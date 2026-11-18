import { createHash, timingSafeEqual } from 'node:crypto';
import { accountsStore, findById, publicProfile, flushAccounts } from './accounts.js';
import { sessionFromRequest } from './auth.js';
import { json, readJson, setCors } from './runtime-config.js';
import { permissionsOf, hasPermission, accessRoles, saveAccessRole, deleteAccessRole, PERMISSIONS } from './access-roles.js';
import { auditItems, pushAdminAudit } from './admin-audit.js';
import { presenceSlice } from './presence.js';
import { adminLocations, teleportAccount } from './admin-world.js';
import { adminOccupancy, rooms } from './room.js';
import { statsRules, saveStatsRules, refillEnergy } from './inventory-store.js';
import { eraseAccount } from './account-delete.js';
export const GAME_VERSION='0.6.7';
const deletionAttempts=new Map();
const liveAccounts=()=>Object.values(accountsStore().accounts).filter(a=>!a.profile?.deletedAt);
const userView=a=>({accountId:a.id,login:a.login,...publicProfile(a),presence:presenceSlice(a).presence,accessRoleId:a.role==='admin'?'admin':a.profile?.accessRoleId || '',permissions:permissionsOf(a)});
function deletePassword(password) {
  const actual=createHash('sha256').update(String(password || '')).digest();
  const expected=process.env.ADMIN_ACCOUNT_DELETE_PASSWORD ? createHash('sha256').update(process.env.ADMIN_ACCOUNT_DELETE_PASSWORD).digest() : Buffer.from('8ba5ef4e282bf7bc5cf13f731a1b9f525bd3b1f69cbfa24c1c69c303c0ac7019','hex');
  return timingSafeEqual(actual,expected);
}
export async function handleAdminConsoleHttp(req,res) {
  try {
    setCors(req,res);
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    const p=new URL(req.url,'http://localhost').pathname.replace('/cfg/console','') || '/';
    const session=sessionFromRequest(req), actor=session?.account;
    if(!actor) return json(res,401,{ok:false,reason:'auth_required'});
    const permission=p==='/characteristics'?'config':p==='/refill-energy'?'world':p==='/'?'overview':p==='/users' || p==='/delete'?'players':p==='/field' || p==='/teleport'?'world':'roles';
    if(!hasPermission(actor,permission) && !(p==='/users' && hasPermission(actor,'roles'))) return json(res,403,{ok:false,reason:'forbidden'});
    if(req.method==='GET') {
      if(p==='/') {
        const all=liveAccounts();
        return json(res,200,{ok:true,registered:all.length,online:all.filter(a=>['online','traveling'].includes(presenceSlice(a).presence)).length,locations:adminLocations().length,version:GAME_VERSION,uptime:Math.floor(process.uptime()),memoryMb:Math.round(process.memoryUsage().rss/1048576),items:auditItems()});
      }
      if(p==='/users') return json(res,200,{ok:true,users:liveAccounts().map(userView)});
      if(p==='/roles') return json(res,200,{ok:true,roles:accessRoles(),permissions:PERMISSIONS});
      if(p==='/characteristics') return json(res,200,{ok:true,rules:statsRules()});
      if(p==='/field') return json(res,200,{ok:true,rooms:adminOccupancy(),locations:adminLocations()});
    }
    if(req.method==='DELETE' && p.startsWith('/roles/')) {
      const id=p.slice(7); if(!deleteAccessRole(id)) return json(res,404,{ok:false,reason:'not_found'});
      for(const acc of liveAccounts()) if(acc.profile?.accessRoleId===id) delete acc.profile.accessRoleId;
      flushAccounts(true); pushAdminAudit('roles',`Удалена роль доступа ${id}`,actor.login); return json(res,200,{ok:true});
    }
    if(req.method!=='POST' && req.method!=='PATCH') return json(res,405,{ok:false,reason:'method_not_allowed'});
    const body=await readJson(req);
    if(p==='/characteristics') {
      const rules=saveStatsRules(body);
      if(!rules) return json(res,400,{ok:false,reason:'invalid_request'});
      pushAdminAudit('config','Обновлены правила характеристик',actor.login);
      return json(res,200,{ok:true,rules});
    }
    if(p==='/roles') {
      const out=saveAccessRole(body); if(out.error) return json(res,400,{ok:false,reason:out.error});
      pushAdminAudit('roles',`Сохранена роль доступа ${out.role.name}`,actor.login); return json(res,200,{ok:true,...out});
    }
    const target=findById(String(body.accountId || ''));
    if(!target || target.profile?.deletedAt) return json(res,404,{ok:false,reason:'not_found'});
    if(p==='/assign') {
      if(target.id===actor.id || (target.role==='admin' && actor.role!=='admin') || body.roleId==='admin') return json(res,403,{ok:false,reason:'protected'});
      if(body.roleId && !accessRoles().some(r=>r.id===body.roleId)) return json(res,400,{ok:false,reason:'invalid_role'});
      target.role='registered'; target.profile ||= {}; target.profile.accessRoleId=String(body.roleId || ''); flushAccounts(true);
      pushAdminAudit('roles',`Назначена роль доступа пользователю ${target.login}`,actor.login); return json(res,200,{ok:true});
    }
    if(p==='/delete') {
      if(target.id===actor.id || (target.role==='admin' && actor.role!=='admin')) return json(res,403,{ok:false,reason:'protected'});
      const rate=deletionAttempts.get(actor.id); if(rate && rate.until>Date.now() && rate.count>=5) return json(res,429,{ok:false,reason:'rate'});
      if(!deletePassword(body.password)) { const row=rate && rate.until>Date.now()?rate:{count:0,until:Date.now()+60000}; row.count++; deletionAttempts.set(actor.id,row); return json(res,403,{ok:false,reason:'bad_password'}); }
      const login=target.login, out=await eraseAccount(target); if(out.error) return json(res,500,{ok:false,reason:out.error});
      for(const room of rooms.values()) for(const ws of room.sockets.keys()) if(ws.account?.id===target.id) ws.close(1000,'Account deleted');
      pushAdminAudit('players',`Удалён аккаунт ${login}`,actor.login); return json(res,200,{ok:true});
    }
    if(p==='/refill-energy') {
      const cat=[...rooms.values()].map(room=>room.cats.get(body.catId))
        .find(row=>row?.accountId===target.id && row.characterId && row.locationId);
      if(!cat) return json(res,404,{ok:false,reason:'not_on_field'});
      refillEnergy(target.id,cat.characterId);
      pushAdminAudit('location-updates',`Восполнена энергия игрока ${cat.login}`,actor.login);
      return json(res,200,{ok:true});
    }
    if(p==='/teleport') {
      const out=teleportAccount(target.id,Number(body.locationId),Number(body.spawnIndex)); if(out.error) return json(res,400,{ok:false,reason:out.error});
      pushAdminAudit('location-updates',`Телепортирован ${target.login} в локацию ${body.locationId}`,actor.login); return json(res,200,out);
    }
    return json(res,404,{ok:false,reason:'not_found'});
  } catch(error) { console.warn('admin console:',error?.message || error); return json(res,400,{ok:false,reason:'invalid_request'}); }
}

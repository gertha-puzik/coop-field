import { sessionFromRequest } from './auth.js';
import { pushAdminAudit } from './admin-audit.js';
export function observeAdminChanges(req,res) {
  if(!['POST','PATCH','DELETE'].includes(req.method)) return;
  const path=new URL(req.url,'http://localhost').pathname;
  let group='',label='';
  if(path==='/auth/register') {group='registrations';label='Зарегистрирован новый пользователь';}
  else if(/\/(?:statuses)(?:\/|$)/.test(path)) {group='statuses';label='Изменены косметические статусы';}
  else if(/\/(?:invites)(?:\/|$)/.test(path)) {group='invites';label=req.method==='POST'?'Созданы пригласительные коды':'Изменён пригласительный код';}
  else if(/\/(?:sprites)(?:\/|$)/.test(path)) {group='sprites';label='Обновлён каталог спрайтов';}
  else if(/\/tex(?:\/|$)/.test(path)) {group='textures';label='Обновлена текстура';}
  else if(path==='/cfg/news') {group='news';label='Обновлена новостная доска';}
  else if(path.includes('/announcements')) {group='announcements';label='Изменены объявления';}
  else if(path==='/cfg/locations' || path==='/admin/locations') {group='location-updates';label='Создана локация';}
  if(!group) return;
  const actor=sessionFromRequest(req)?.account;
  const end=res.end;
  res.end=function(chunk,...args) {
    if(res.statusCode>=200 && res.statusCode<300 && chunk) {
      try { const row=JSON.parse(String(chunk)); if(row.ok===true) {
        const detail=row.statusLabel && row.accountId ? `${row.statusLabel} → ${row.accountId}` : row.item?.name || row.item?.id || row.status?.label || row.place?.name || row.profile?.displayName || row.login || row.accountId || (row.invites ? `${row.invites.length} шт.` : '');
        pushAdminAudit(group,label+(detail?`: ${detail}`:''),actor?.profile?.displayName || actor?.login || 'Регистрация');
      }} catch {}
    }
    return end.call(this,chunk,...args);
  };
}

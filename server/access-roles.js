/** Access roles are independent of cosmetic profile.statusId. */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { writeFileAtomic } from './atomic-file.js';
export const PERMISSIONS = Object.freeze(['overview','players','roles','world','config','sprites','textures','invites','news','announcements','statuses','items']);
const file = path.join(DATA_DIR, 'access-roles.json');
let roles = [];
try { const raw = JSON.parse(fs.readFileSync(file,'utf8')); if (Array.isArray(raw.roles)) roles = raw.roles.filter(r => r && /^[a-z0-9-]{2,40}$/.test(r.id) && typeof r.name === 'string').map(r => ({id:r.id,name:r.name.slice(0,48),permissions:Array.isArray(r.permissions)?r.permissions.filter(p=>PERMISSIONS.includes(p)):[]})); } catch {}
export const accessRoles = () => roles.map(r=>({...r,permissions:[...r.permissions]}));
export function permissionsOf(account) {
  if (!account || account.profile?.deletedAt) return [];
  if (account.role === 'admin') return [...PERMISSIONS];
  return [...(roles.find(r=>r.id === account.profile?.accessRoleId)?.permissions || [])];
}
export const hasPermission = (account, permission) => permissionsOf(account).includes(permission);
export function saveAccessRole(raw) {
  const id=String(raw?.id || ''), name=String(raw?.name || '').trim();
  if (!/^[a-z0-9-]{2,40}$/.test(id) || !name || name.length>48 || !Array.isArray(raw.permissions) || raw.permissions.some(p=>!PERMISSIONS.includes(p))) return {error:'invalid'};
  const row={id,name,permissions:[...new Set(raw.permissions)]};
  const next=roles.filter(r=>r.id!==id); next.push(row);
  fs.mkdirSync(DATA_DIR,{recursive:true}); writeFileAtomic(file,JSON.stringify({v:1,roles:next})); roles=next; return {role:row};
}
export function deleteAccessRole(id) {
  if (!roles.some(r=>r.id===id)) return false;
  const next=roles.filter(r=>r.id!==id); writeFileAtomic(file,JSON.stringify({v:1,roles:next})); roles=next; return true;
}

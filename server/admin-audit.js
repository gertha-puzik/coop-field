/** Persistent last-50 administrative changes, with no passwords or invite codes. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { writeFileAtomic } from './atomic-file.js';
const file=path.join(DATA_DIR,'admin-audit.json');
let rows=[];
try { const raw=JSON.parse(fs.readFileSync(file,'utf8')); if(Array.isArray(raw.items)) rows=raw.items.filter(r=>r && Number.isFinite(r.at) && typeof r.group==='string').slice(0,50); } catch {}
export const auditItems=()=>rows.map(r=>({...r}));
export function pushAdminAudit(group,text,actor='Система') {
  try {
    const item={id:randomUUID(),at:Date.now(),group,text:String(text).slice(0,240),actor:String(actor).slice(0,48)};
    const next=[item,...rows].slice(0,50); fs.mkdirSync(DATA_DIR,{recursive:true}); writeFileAtomic(file,JSON.stringify({v:1,items:next})); rows=next;
  } catch(error) { console.warn('admin audit:',error?.message || error); }
}

/** Isolated console/RBAC/social DTO integration; never uses production data. */
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { WebSocket } from 'ws';
const root=new URL('..',import.meta.url).pathname,data=mkdtempSync(path.join(tmpdir(),'coop-console-'));
const free=net.createServer();await new Promise(resolve=>free.listen(0,'127.0.0.1',resolve));const port=free.address().port;await new Promise(resolve=>free.close(resolve));
const origin=`http://127.0.0.1:${port}`;
const env={...process.env,DATA_DIR:data,PORT:String(port),HOST:'127.0.0.1',AUTH_CSRF_STRICT:'1',AUTH_REGISTER_GAP_MS:'1',AUTH_LOGIN_GAP_MS:'1',AUTH_REGISTER_HOURLY_MAX:'100',ADMIN_ACCOUNT_DELETE_PASSWORD:'integration-only-password'};
let server,logs='';
async function start(){server=spawn(process.execPath,['server.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});server.stdout.on('data',c=>logs=(logs+c).slice(-10000));server.stderr.on('data',c=>logs=(logs+c).slice(-10000));for(let i=0;i<100;i++){try{if((await fetch(origin+'/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,80));}throw Error(logs);}
async function stop(){if(!server || server.exitCode!==null || server.signalCode)return;const end=once(server,'exit');server.kill('SIGTERM');await end;}
async function req(url,cookie,method='GET',body,extra={}){const r=await fetch(origin+url,{method,headers:{origin,'content-type':'application/json',...(cookie?{cookie}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,row:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
async function account(login){const r=await req('/auth/register',null,'POST',{login,pass:'password1'});assert.equal(r.status,200);const auth=await req('/auth/login',null,'POST',{login,pass:'password1'});return {cookie:auth.cookie,id:auth.row.accountId};}
try{
 await start();const admin=await account('console_admin'),member=await account('console_member'),victim=await account('console_victim'),cosmetic=await account('console_cosmetic');
 await stop();const promoted=spawnSync(process.execPath,['scripts/make-admin.mjs','console_admin'],{cwd:root,env,encoding:'utf8'});assert.equal(promoted.status,0,promoted.stderr);await start();
 const preflight=await fetch(origin+'/cfg/console/roles',{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'content-type'}});assert.equal(preflight.status,204);assert.ok(preflight.headers.get('access-control-allow-methods')?.includes('POST'));assert.ok(preflight.headers.get('access-control-allow-headers')?.toLowerCase().includes('content-type'));
 assert.equal((await req('/cfg/console',null)).status,401);
 assert.equal((await req('/cfg/console',member.cookie)).status,403);
 const publicStatus=await new Promise(resolve=>{const r=http.request(origin+'/cfg/console',{headers:{host:'abnocw.phainonsmilk.ru',cookie:admin.cookie}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});r.end();});assert.equal(publicStatus,404);
 let stats=await req('/cfg/console',admin.cookie);assert.equal(stats.status,200,JSON.stringify(stats));assert.equal(stats.row.registered,4);assert.equal(stats.row.version,'0.6.7');assert.ok(stats.row.locations>0);
 assert.ok(stats.row.items.some(i=>i.group==='registrations'));
 // Site chrome: public reads, permission/CSRF/host gates, safe uploads, durable settings.
 const design=await req('/cfg/site-design',null);assert.equal(design.status,200);const defaults=design.row.settings;
 assert.equal(defaults.labels.userInfo,'О пользователе');
 assert.equal((await req('/cfg/site-design',null,'POST',defaults)).status,401);
 assert.equal((await req('/cfg/site-design',member.cookie,'POST',defaults)).status,403);
 assert.equal((await req('/cfg/site-design',admin.cookie,'POST',defaults,{origin:'https://evil.example'})).status,403);
 assert.equal((await req('/cfg/site-design',admin.cookie,'POST',{...defaults,textSize:999})).status,400);
 assert.equal((await req('/cfg/site-design',admin.cookie,'POST',{...defaults,frame:'https://evil.example/frame.svg'})).status,400);
 const png=readFileSync(path.join(root,'public/tex/grass-ground.png'));
 const upload=await fetch(origin+'/cfg/site-design/assets/frame',{method:'POST',headers:{origin,cookie:admin.cookie,'content-type':'application/octet-stream'},body:png});assert.equal(upload.status,200);const uploaded=await upload.json();
 const image=await fetch(origin+uploaded.url);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
 assert.equal((await fetch(origin+'/cfg/site-design/assets/frame',{method:'POST',headers:{origin,cookie:admin.cookie},body:'<svg onload="alert(1)"></svg>'})).status,400);
 assert.equal((await fetch(origin+'/cfg/site-design/assets/frame',{method:'POST',headers:{origin,cookie:admin.cookie},body:Buffer.alloc(2*1024*1024+1)})).status,413);
 assert.equal((await req('/cfg/site-design',null,'POST',defaults)).status,401);
 assert.equal((await req('/cfg/site-design',member.cookie,'POST',defaults)).status,403);
 assert.equal((await req('/cfg/site-design',admin.cookie,'POST',defaults,{origin:'https://evil.example'})).status,403);
 assert.equal((await req('/cfg/site-design',admin.cookie,'POST',{...defaults,frame:'https://evil.example/frame.svg'})).status,400);
 assert.equal((await req('/cfg/site-design',admin.cookie,'POST',{...defaults,textSize:999})).status,400);
 const customDesign={...defaults,textSize:17,frame:uploaded.url,labels:{...defaults.labels,userInfo:'Об игроке'}};
 assert.equal((await req('/cfg/site-design',admin.cookie,'POST',customDesign)).status,200);
 const hiddenDesign=await new Promise(resolve=>{const r=http.request(origin+'/cfg/site-design',{headers:{host:'abnocw.phainonsmilk.ru'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});r.end();});assert.equal(hiddenDesign,404);

 const socials={discord:'https://discord.gg/test',telegram:'https://t.me/example',youtube:'https://www.youtube.com/@example',vk:'https://vk.com/example',website:'https://example.com/'};
 let r=await req('/profiles/me',member.cookie,'PATCH',{socials,birthday:'2000-05-14'});assert.equal(r.status,200,JSON.stringify(r.row));assert.equal(r.row.socials.telegram,socials.telegram);
 r=await req('/profiles/'+member.id,null);assert.equal(r.row.birthday,'05-14');assert.equal(r.row.socials.website,socials.website);assert.equal('permissions' in r.row,false);
 assert.equal((await req('/profiles/me',member.cookie,'PATCH',{socials:{telegram:'javascript:alert(1)'}})).status,400);
 assert.equal((await req('/profiles/me',member.cookie,'PATCH',{socials:{telegram:'https://evil.example/x'}})).status,400);
 assert.equal((await req('/profiles/me',member.cookie,'PATCH',{socials:{telegram:'https://t.me@example.com'}})).status,400);
 assert.equal((await req('/profiles/me',member.cookie,'PATCH',{socials:{unknown:'https://example.com'}})).status,400);
 assert.equal((await req('/cfg/console/roles',admin.cookie,'POST',{id:'observer',name:'Наблюдатель',permissions:['overview']},{origin:'https://evil.example'})).status,403);
 r=await req('/cfg/console/roles',admin.cookie,'POST',{id:'observer',name:'Наблюдатель',permissions:['overview']});assert.equal(r.status,200);
 assert.equal((await req('/cfg/console/assign',admin.cookie,'POST',{accountId:member.id,roleId:'observer'})).status,200);
 r=await req('/auth/me',member.cookie);assert.equal(r.row.role,'registered');assert.deepEqual(r.row.permissions,['overview']);
 assert.equal((await req('/cfg/console',member.cookie)).status,200);
 for(const endpoint of ['/cfg/console/users','/cfg/console/roles','/cfg/console/field','/cfg/admin','/admin/statuses','/admin/invites'])assert.equal((await req(endpoint,member.cookie)).status,403,endpoint);
 assert.equal((await req('/admin/players/promote',member.cookie,'POST',{login:'console_member'})).status,403);
 for(const [permission,endpoint] of [['config','/cfg/admin'],['sprites','/admin/sprites'],['textures','/cfg/tex'],['invites','/admin/invites'],['statuses','/admin/statuses'],['announcements','/admin/announcements']]) {
  assert.equal((await req('/cfg/console/roles',admin.cookie,'POST',{id:'observer',name:'Наблюдатель',permissions:['overview',permission]})).status,200);
  assert.equal((await req(endpoint,member.cookie)).status,200,permission+' permits its own section');
  assert.equal((await req('/cfg/console/roles',admin.cookie,'POST',{id:'observer',name:'Наблюдатель',permissions:['overview']})).status,200);
  assert.equal((await req(endpoint,member.cookie)).status,403,permission+' is immediately revoked');
 }

 r=await req('/admin/statuses',admin.cookie,'POST',{id:'cosmetic-owner',label:'негровладелец'});assert.equal(r.status,200);
 assert.equal((await req('/admin/statuses/assign',admin.cookie,'POST',{accountId:cosmetic.id,statusId:'cosmetic-owner'})).status,200);
 assert.equal((await req('/cfg/console',cosmetic.cookie)).status,403,'cosmetic status never grants access');
 r=await req('/cfg/console/users',admin.cookie);assert.equal(r.row.users.find(u=>u.accountId===cosmetic.id).permissions.length,0);
 assert.equal((await req('/cfg/console/delete',member.cookie,'POST',{accountId:victim.id,password:env.ADMIN_ACCOUNT_DELETE_PASSWORD})).status,403);
 assert.equal((await req('/cfg/console/delete',admin.cookie,'POST',{accountId:victim.id,password:'wrong'})).status,403);
 assert.equal((await req('/profiles/'+victim.id,null)).status,200);
 assert.equal((await req('/cfg/console/delete',admin.cookie,'POST',{accountId:admin.id,password:env.ADMIN_ACCOUNT_DELETE_PASSWORD})).status,403);
 assert.equal((await req('/cfg/console/delete',admin.cookie,'POST',{accountId:victim.id,password:env.ADMIN_ACCOUNT_DELETE_PASSWORD})).status,200);
 assert.equal((await req('/profiles/'+victim.id,null)).status,404);assert.equal((await req('/profiles/me',victim.cookie)).status,401);
 r=await req('/cfg/console/field',admin.cookie);assert.equal(r.status,200);assert.ok(r.row.locations.some(l=>l.spawns.length));
 assert.equal((await req('/cfg/console/teleport',admin.cookie,'POST',{accountId:member.id,locationId:1,spawnIndex:0})).row.reason,'not_on_field');
 const ws=new WebSocket(`ws://127.0.0.1:${port}`);const inbox=[];ws.on('message',raw=>inbox.push(JSON.parse(String(raw))));await once(ws,'open');
 async function waitFor(predicate){for(let i=0;i<100;i++){const found=inbox.find(predicate);if(found)return found;await new Promise(resolve=>setTimeout(resolve,30));}throw Error('WS frame missing '+JSON.stringify(inbox));}
 ws.send(JSON.stringify(['auth',{action:'login',login:'console_member',pass:'password1'}]));await waitFor(([event,row])=>event==='whoami' && row.accountId);
 ws.send(JSON.stringify(['join',{room:'test'}]));await waitFor(([event])=>event==='field');
 const location=r.row.locations.find(l=>l.spawns.some(point=>!point.automatic)) || r.row.locations.find(l=>l.spawns.length),spawn=location.spawns[0];
 const teleported=await req('/cfg/console/teleport',admin.cookie,'POST',{accountId:member.id,locationId:location.id,spawnIndex:spawn.index});assert.equal(teleported.status,200,JSON.stringify(teleported));
 const placed=await req('/cfg/console/field',admin.cookie);const player=placed.row.rooms.flatMap(room=>room.cats).find(cat=>cat.accountId===member.id);if(!spawn.automatic){assert.equal(player.x,spawn.c+1);assert.equal(player.y,spawn.r+1);}assert.ok(Number.isFinite(player.x)&&Number.isFinite(player.y));
 assert.equal((await req('/cfg/console/teleport',admin.cookie,'POST',{accountId:member.id,locationId:1,spawnIndex:999})).status,400);
 ws.close();await once(ws,'close');

 await stop();await start();assert.equal((await req('/cfg/site-design',null)).row.settings.labels.userInfo,'Об игроке','site design persists');assert.equal((await fetch(origin+uploaded.url)).status,200,'uploaded frame persists');assert.equal((await req('/cfg/site-design',admin.cookie,'POST',defaults)).status,200,'restore defaults');assert.equal((await req('/cfg/console',member.cookie)).status,200,'role persists');
 assert.equal((await req('/profiles/'+member.id,null)).row.socials.telegram,socials.telegram);
 assert.equal((await req('/cfg/console/roles/observer',admin.cookie,'DELETE')).status,200);
 assert.equal((await req('/cfg/console',member.cookie)).status,403,'role deletion revokes access');
 r=await req('/cfg/console',admin.cookie);assert.ok(r.row.items.some(i=>i.group==='statuses'));assert.ok(r.row.items.some(i=>i.group==='roles'));
 await stop();
 const code=`const m=await import(${JSON.stringify(path.join(root,'server/admin-audit.js'))});for(let i=0;i<70;i++)m.pushAdminAudit('location-updates','change '+i,'test');console.log(JSON.stringify(m.auditItems()));`;
 const audit=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:root,env,encoding:'utf8'});assert.equal(audit.status,0,audit.stderr);const rows=JSON.parse(audit.stdout.trim().split('\n').at(-1));assert.equal(rows.length,50);assert.equal(rows[0].text,'change 69');assert.equal(rows.at(-1).text,'change 20');
 assert.equal(JSON.parse(readFileSync(path.join(data,'admin-audit.json'),'utf8')).items.length,50);
 console.log('console-profile: PASS — permissions, cosmetic separation, CSRF/host gates, deletion, persistence, social URL validation, 50-entry audit');
}catch(error){console.error(logs);throw error;}finally{await stop();rmSync(data,{recursive:true,force:true});}

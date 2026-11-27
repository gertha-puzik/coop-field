/** Persistent site chrome settings; public read, textures-permission write, no executable uploads. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { writeFileAtomic } from './atomic-file.js';
import { sessionFromRequest } from './auth.js';
import { hasPermission } from './access-roles.js';
import { json, setCors } from './runtime-config.js';
import { readBody } from './sprites.js';
import { pushAdminAudit } from './admin-audit.js';
const dir=path.join(DATA_DIR,'site-design'), file=path.join(dir,'settings.json');
export const DEFAULT_SITE_DESIGN=Object.freeze({font:'inter',textSize:14,headingSize:20,titleSize:34,textColor:'#f4f0ff',mutedColor:'#b9b3d9',accentColor:'#f6d7a2',panelColor:'#17132d',backgroundColor:'#080c1a',frame:'/ui/ornamental-frame.svg',divider:'/ui/site-line.svg',background:'',button:'',fontFile:'',frameSlice:20,frameWidth:14,dividerHeight:1,panelOpacity:90,palette:{},labels:{userInfo:'О пользователе',character:'Активный персонаж',statistics:'Краткая статистика',friends:'Друзья',activity:'Последние действия'}});
const slots=['frame','divider','background','button','fontFile'];
const ranges={textSize:[10,24],headingSize:[14,36],titleSize:[20,56],frameSlice:[4,150],frameWidth:[8,60],dividerHeight:[1,80],panelOpacity:[30,100]};
const colors=['textColor','mutedColor','accentColor','panelColor','backgroundColor'];
const paletteKeys=[
 'button-idle','button-idle-text','button-active','button-active-text','button-disabled','button-disabled-text',
 'header','navigation','cards','inset','dialog','scrim','form-field','game',
];
const hexColor = /^#[a-f0-9]{6}$/i;
const assetRe=/^\/cfg\/site-design\/files\/[a-f0-9]{64}\.(png|jpg|webp|gif|woff2)$/;
function validAsset(key,value){return typeof value==='string' && (value===DEFAULT_SITE_DESIGN[key] || (assetRe.test(value) && (key==='fontFile'?value.endsWith('.woff2'):!value.endsWith('.woff2')) && fs.existsSync(path.join(dir,path.basename(value)))));}
export function validateSiteDesign(raw, currentPalette = {}){
 if(!raw || typeof raw!=='object' || Array.isArray(raw))return null;
 const next={...DEFAULT_SITE_DESIGN,labels:{...DEFAULT_SITE_DESIGN.labels}};
 if(!['inter','serif','sans','mono'].includes(raw.font))return null;next.font=raw.font;
 for(const [key,[min,max]] of Object.entries(ranges)){if(!Number.isFinite(raw[key]) || raw[key]<min || raw[key]>max)return null;next[key]=Math.round(raw[key]);}
 for(const key of colors){if(typeof raw[key]!=='string' || !hexColor.test(raw[key]))return null;next[key]=raw[key];}
 const palette=Object.hasOwn(raw,'palette') ? raw.palette : currentPalette;
 if(!palette || typeof palette!=='object' || Array.isArray(palette))return null;
 next.palette={};
 for(const key of paletteKeys){
  if(!Object.hasOwn(palette,key))continue;
  const color=palette[key];
  if(typeof color!=='string' || !hexColor.test(color))return null;
  next.palette[key]=color.toLowerCase();
 }
 for(const key of slots){if(!validAsset(key,raw[key]))return null;next[key]=raw[key];}
 for(const key of Object.keys(next.labels)){const text=raw.labels?.[key];if(typeof text!=='string' || !text.trim() || text.length>64 || /[\u0000-\u001f]/.test(text))return null;next.labels[key]=text.trim();}
 return next;
}
let settings={...DEFAULT_SITE_DESIGN,labels:{...DEFAULT_SITE_DESIGN.labels}};
try{
 const raw=JSON.parse(fs.readFileSync(file,'utf8'));
 if(raw.frame==='/ui/site-frame.png'){if(raw.accentColor==='#d9c4bc')raw.accentColor=DEFAULT_SITE_DESIGN.accentColor;raw.frame=DEFAULT_SITE_DESIGN.frame;if(raw.frameSlice===44)raw.frameSlice=20;if(raw.frameWidth===26)raw.frameWidth=14;}
 if(raw.divider==='/ui/site-divider.svg'){raw.divider=DEFAULT_SITE_DESIGN.divider;if(raw.dividerHeight===28)raw.dividerHeight=1;}
 settings=validateSiteDesign(raw) || settings;
}catch{}
export async function handleSiteDesignHttp(req,res){
 setCors(req,res);
 if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
 const p=new URL(req.url,'http://localhost').pathname;
 if(req.method==='GET' && p.startsWith('/cfg/site-design/files/')){
  if(!assetRe.test(p))return json(res,404,{ok:false,reason:'not_found'});
  const target=path.join(dir,path.basename(p));if(!fs.existsSync(target))return json(res,404,{ok:false,reason:'not_found'});
  const mime={png:'image/png',jpg:'image/jpeg',webp:'image/webp',gif:'image/gif',woff2:'font/woff2'}[p.split('.').at(-1)];
  res.writeHead(200,{'Content-Type':mime,'Cache-Control':'public, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'});fs.createReadStream(target).pipe(res);return;
 }
 if(req.method==='GET' && p==='/cfg/site-design')return json(res,200,{ok:true,settings});
 const actor=sessionFromRequest(req)?.account;
 if(!actor)return json(res,401,{ok:false,reason:'auth_required'});
 if(!hasPermission(actor,'textures'))return json(res,403,{ok:false,reason:'forbidden'});
 try{
  if(req.method==='POST' && p.startsWith('/cfg/site-design/assets/')){
   const slot=p.split('/').at(-1);if(!slots.includes(slot))return json(res,400,{ok:false,reason:'invalid_slot'});
   const bytes=await readBody(req,2*1024*1024);let ext='';
   if(bytes.length<24)return json(res,400,{ok:false,reason:'invalid_file'});
   if(slot==='fontFile'){if(bytes.subarray(0,4).toString()==='wOF2')ext='woff2';}
   else if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.readUInt32BE(16)>0 && bytes.readUInt32BE(16)<=8192 && bytes.readUInt32BE(20)>0 && bytes.readUInt32BE(20)<=8192)ext='png';
   else if(bytes[0]===255 && bytes[1]===216 && bytes[2]===255)ext='jpg';
   else if(bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP')ext='webp';
   else if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()))ext='gif';
   if(!ext)return json(res,400,{ok:false,reason:'invalid_file'});
   const name=createHash('sha256').update(bytes).digest('hex')+'.'+ext;
   fs.mkdirSync(dir,{recursive:true});writeFileAtomic(path.join(dir,name),bytes);
   return json(res,200,{ok:true,url:'/cfg/site-design/files/'+name});
  }
  if(req.method==='POST' && p==='/cfg/site-design'){
   const raw=JSON.parse((await readBody(req,16000)).toString());const next=validateSiteDesign(raw,settings.palette);
   if(!next)return json(res,400,{ok:false,reason:'invalid_settings'});
   fs.mkdirSync(dir,{recursive:true});writeFileAtomic(file,JSON.stringify(next));settings=next;
   pushAdminAudit('textures','Изменено оформление сайта',actor.login);return json(res,200,{ok:true,settings});
  }
  return json(res,405,{ok:false,reason:'method_not_allowed'});
 }catch(error){return json(res,error?.code==='too_large'?413:400,{ok:false,reason:error?.code==='too_large'?'too_large':'invalid_request'});}
}

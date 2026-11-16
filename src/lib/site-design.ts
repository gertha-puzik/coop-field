import { httpOrigin } from './net/coop';
export const DEFAULT_SITE_DESIGN={font:'inter',textSize:14,headingSize:20,titleSize:34,textColor:'#f4f0ff',mutedColor:'#b9b3d9',accentColor:'#d9c4bc',panelColor:'#17132d',backgroundColor:'#080c1a',frame:'/ui/site-frame.png',divider:'/ui/site-divider.svg',background:'',button:'',fontFile:'',frameSlice:44,frameWidth:26,dividerHeight:28,panelOpacity:90,labels:{userInfo:'О пользователе',character:'Активный персонаж',statistics:'Краткая статистика',friends:'Друзья',activity:'Последние действия'}};
export type SiteDesign=typeof DEFAULT_SITE_DESIGN;
export type DesignSlot='frame'|'divider'|'background'|'button'|'fontFile';
export const siteAsset=(url:string)=>url.startsWith('/cfg/')?`${httpOrigin()}${url}`:url;
export async function designRequest(method='GET',body?:SiteDesign){
 const response=await fetch(`${httpOrigin()}/cfg/site-design`,{method,credentials:'include',cache:'no-store',...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
 const row=await response.json();if(!response.ok || !row.ok)throw new Error(row.reason || 'offline');return row.settings as SiteDesign;
}
export async function uploadDesignAsset(slot:DesignSlot,file:File){
 const response=await fetch(`${httpOrigin()}/cfg/site-design/assets/${slot}`,{method:'POST',credentials:'include',headers:{'Content-Type':'application/octet-stream'},body:file});
 const row=await response.json();if(!response.ok || !row.ok)throw new Error(row.reason || 'offline');return row.url as string;
}
export function designVariables(settings:SiteDesign):Record<string,string>{
 const image=(url:string)=>url?`url("${siteAsset(url)}")`:'none';
 const fonts={inter:'var(--font-geist-sans), sans-serif',serif:'Georgia, "Times New Roman", serif',sans:'Arial, sans-serif',mono:'var(--font-geist-mono), monospace'};
 return {'--site-font':settings.fontFile?'SiteCustom, sans-serif':fonts[settings.font as keyof typeof fonts] || fonts.inter,'--site-text-size':`${settings.textSize}px`,'--site-heading-size':`${settings.headingSize}px`,'--site-title-size':`${settings.titleSize}px`,'--site-text-color':settings.textColor,'--site-muted-color':settings.mutedColor,'--site-accent-color':settings.accentColor,'--site-panel-color':settings.panelColor,'--site-background-color':settings.backgroundColor,'--site-frame-marks':settings.frame===DEFAULT_SITE_DESIGN.frame?'url("/ui/site-frame-mark.svg")':'none','--site-frame':image(settings.frame),'--site-divider':image(settings.divider),'--site-background':image(settings.background),'--site-button':image(settings.button),'--site-frame-slice':String(settings.frameSlice),'--site-frame-width':`${settings.frameWidth}px`,'--site-divider-height':`${settings.dividerHeight}px`,'--site-panel-opacity':`${settings.panelOpacity}%`};
}

'use client';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_SITE_DESIGN, designRequest, designVariables, siteAsset, type SiteDesign } from '@/lib/site-design';
const DesignContext=createContext<SiteDesign>(DEFAULT_SITE_DESIGN);
export const useSiteDesign=()=>useContext(DesignContext);
export function SiteDesignProvider({children}:{children:ReactNode}){
 const [settings,setSettings]=useState(DEFAULT_SITE_DESIGN),preview=useRef(false),saved=useRef(DEFAULT_SITE_DESIGN);
 useEffect(()=>{
  let active=true;
  const refresh=async()=>{try{const value=await designRequest();saved.current=value;if(active && !preview.current)setSettings(value);}catch{/* Defaults keep the site usable during a server update. */}};
  void refresh();const id=window.setInterval(()=>{if(!preview.current)void refresh();},60000);
  const change=(event:Event)=>{const value=(event as CustomEvent<SiteDesign|null>).detail;preview.current=!!value;if(active)setSettings(value || saved.current);};
  const save=(event:Event)=>{const value=(event as CustomEvent<SiteDesign>).detail;saved.current=value;preview.current=false;if(active)setSettings(value);};
  window.addEventListener('site-design-preview',change);window.addEventListener('site-design-saved',save);
  return()=>{active=false;window.clearInterval(id);window.removeEventListener('site-design-preview',change);window.removeEventListener('site-design-saved',save);};
 },[]);
 useEffect(()=>{
  const root=document.documentElement;root.dataset.siteDesign='true';if(settings.button)root.dataset.siteButton='true';else delete root.dataset.siteButton;
  root.toggleAttribute('data-site-custom-frame',settings.frame!==DEFAULT_SITE_DESIGN.frame);root.toggleAttribute('data-site-custom-divider',settings.divider!==DEFAULT_SITE_DESIGN.divider);
  const vars=designVariables(settings);
  root.dataset.sitePalette=Object.keys(vars).filter(key=>key.startsWith('--site-color-')).map(key=>key.slice(13)).join(' ');
  root.toggleAttribute('data-site-panel-color',!!vars['--site-color-panel']);
  root.toggleAttribute('data-site-page-color',!!settings.background || settings.backgroundColor!==DEFAULT_SITE_DESIGN.backgroundColor);
  for(const [key,value] of Object.entries(vars))root.style.setProperty(key,value);
  let font:FontFace|null=null;
  if(settings.fontFile){font=new FontFace('SiteCustom',`url("${siteAsset(settings.fontFile)}")`);void font.load().then(loaded=>{if(font)document.fonts.add(loaded);}).catch(()=>{});}
  return()=>{for(const key of Object.keys(vars))root.style.removeProperty(key);root.removeAttribute('data-site-custom-frame');root.removeAttribute('data-site-custom-divider');delete root.dataset.siteDesign;delete root.dataset.siteButton;delete root.dataset.sitePalette;root.removeAttribute('data-site-panel-color');root.removeAttribute('data-site-page-color');if(font){document.fonts.delete(font);font=null;}};
 },[settings]);
 return <DesignContext.Provider value={settings}>{children}</DesignContext.Provider>;
}

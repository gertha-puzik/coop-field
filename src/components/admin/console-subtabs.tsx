'use client';
import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import s from './admin-console.module.css';
export const ConsoleNavigationContext=createContext<{target:HTMLDivElement|null;expanded:boolean}>({target:null,expanded:true});
export function ConsoleSubtabs({tabs}:{tabs:{id:string;label:string;content:ReactNode}[]}) {
  const [active,setActive]=useState('');
  const {target,expanded}=useContext(ConsoleNavigationContext);
  const panelId=useId();
  useEffect(()=>{if(!expanded)setActive('');},[expanded]);
  const shown=tabs.find(t=>t.id===active);
  if(!tabs.length)return <p className={s.muted}>Для этого раздела нет разрешений.</p>;
  const navigation=<nav className={s.subnav} aria-label="Подразделы">{tabs.map(t=><button key={t.id} type="button" aria-expanded={expanded && t.id===shown?.id} aria-controls={panelId} onClick={()=>setActive(current=>current===t.id?'':t.id)}>{t.label}</button>)}</nav>;
  return <>{target?createPortal(navigation,target):navigation}<div id={panelId} className={s.tabContent} key={shown?.id || 'closed'}>{expanded?shown?.content:null}</div></>;
}

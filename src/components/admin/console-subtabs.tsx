'use client';
import { useState, type ReactNode } from 'react';
import s from './admin-console.module.css';
export function ConsoleSubtabs({tabs}:{tabs:{id:string;label:string;content:ReactNode}[]}) {
  const [active,setActive]=useState(tabs[0]?.id || '');
  const shown=tabs.find(t=>t.id===active) || tabs[0];
  if(!shown) return <p className={s.muted}>Для этого раздела нет разрешений.</p>;
  return <><nav className={s.subnav} aria-label="Подразделы">{tabs.map(t=><button key={t.id} type="button" aria-selected={t.id===shown.id} onClick={()=>setActive(t.id)}>{t.label}</button>)}</nav>{shown.content}</>;
}

'use client';
import { useCallback,useEffect,useState } from 'react';
import { consoleRequest,consoleError,AUDIT_LABELS,type AuditItem } from '@/lib/net/http-console';
import { ConsoleSubtabs } from './console-subtabs';
import { InvitesTab } from './invites-tab';
import { NewsTab } from './news-tab';
import { AnnouncementsTab } from './announcements-tab';
import s from './admin-console.module.css';
type Snapshot={registered:number;online:number;locations:number;version:string;uptime:number;memoryMb:number;items:AuditItem[]};
function Overview() {
  const [data,setData]=useState<Snapshot|null>(null),[error,setError]=useState(''),[groups,setGroups]=useState<string[]>([]);
  const load=useCallback(async()=>{const r=await consoleRequest<Snapshot>();if(r.ok){setData(r);setError('');}else setError(consoleError(r.reason));},[]);
  useEffect(()=>{void load();const id=setInterval(()=>void load(),15000);return()=>clearInterval(id);},[load]);
  if(!data) return <p className={s.muted}>{error || 'Загружаем данные…'}</p>;
  const items=data.items.filter(item=>!groups.length || groups.includes(item.group));
  return <div className={s.stack}>
    {error?<p className={s.error}>{error}</p>:null}
    <section className={`${s.panel} ${s.quick}`}><h2>ϟ Быстрые действия</h2><div className={s.placeholder}>Панель быстрых действий</div></section>
    <div className={s.overview}>
    <section className={s.panel}><h2>▥ Краткая статистика</h2><div className={s.stats}>
      <div className={s.stat}><strong>{data.registered}</strong><span>Зарегистрировано пользователей · в сети и путешествуют: {data.online}</span></div>
      <div className={s.stat}><strong>{data.locations}</strong><span>Всего локаций</span></div>
    </div></section>
    <section className={s.panel}><h2>ⓘ Состояние системы</h2><div className={s.system}>
      <div><span>Сервер</span><strong>Доступен</strong></div><div><span>Версия игры</span><strong>v{data.version}</strong></div>
      <div><span>Время работы</span><strong>{Math.floor(data.uptime/60)} мин</strong></div><div><span>Память процесса</span><strong>{data.memoryMb} МБ</strong></div>
    </div></section>
    <section className={s.panel}><h2>◷ Последние изменения</h2><div className={s.filters}>
      <button type="button" aria-pressed={!groups.length} onClick={()=>setGroups([])}>Все группы</button>
      {Object.entries(AUDIT_LABELS).map(([key,label])=><button key={key} type="button" aria-pressed={groups.includes(key)} onClick={()=>setGroups(old=>old.includes(key)?old.filter(v=>v!==key):[...old,key])}>{label}</button>)}
    </div><ul className={s.audit} data-scroll={items.length>10} tabIndex={items.length>10?0:undefined} aria-label="Последние 50 изменений">{items.map(item=><li key={item.id} title={item.text}>
      <time dateTime={new Date(item.at).toISOString()}>{new Date(item.at).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</time>
      <span className={s.badge}>{AUDIT_LABELS[item.group] || item.group}</span><div>{item.text}<small>{item.actor}</small></div>
    </li>)}</ul>{!items.length?<p className={s.muted}>Изменений пока нет.</p>:null}</section>
    </div>
  </div>;
}
export function ConsoleGeneral({permissions}:{permissions:string[]}) {
  return <ConsoleSubtabs tabs={[
    ...(permissions.includes('overview')?[{id:'overview',label:'Общее',content:<Overview/>}]:[]),
    ...(permissions.includes('invites')?[{id:'invites',label:'Коды приглашений',content:<InvitesTab/>}]:[]),
    ...(permissions.includes('news')?[{id:'news',label:'Новости',content:<NewsTab/>}]:[]),
    ...(permissions.includes('announcements')?[{id:'announcements',label:'Объявления',content:<AnnouncementsTab/>}]:[]),
  ]}/>;
}

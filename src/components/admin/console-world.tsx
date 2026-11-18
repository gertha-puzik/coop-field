'use client';
import { useCallback,useEffect,useState,type ReactNode } from 'react';
import { consoleRequest,consoleError } from '@/lib/net/http-console';
import { ConsoleSubtabs } from './console-subtabs';
import s from './admin-console.module.css';
type Location={id:number;name:string;zoneName:string;spawns:{index:number;c:number;r:number;automatic?:boolean}[]};
type Field={rooms:{room:string;title:string;cats:{id:number;accountId:string|null;accountLogin:string|null;login:string;x:number;y:number;locationLabel?:string}[]}[];locations:Location[]};
function FieldPlayers() {
  const [data,setData]=useState<Field|null>(null),[error,setError]=useState(''),[target,setTarget]=useState<Record<string,string>>({}),[busy,setBusy]=useState(''),[note,setNote]=useState('');
  const load=useCallback(async()=>{const r=await consoleRequest<Field>('/field');if(r.ok)setData(r);else setError(consoleError(r.reason));},[]);
  useEffect(()=>{void load();const id=setInterval(()=>void load(),10000);return()=>clearInterval(id);},[load]);
  const teleport=async(accountId:string)=>{const [locationId,spawnIndex]=(target[accountId] || '').split(':').map(Number);setBusy(accountId);setError('');const r=await consoleRequest('/teleport','POST',{accountId,locationId,spawnIndex});setBusy('');if(!r.ok)setError(consoleError(r.reason));else await load();};
  const refill = async (catId:number, accountId:string, login:string) => {
    setBusy(String(catId)); setError(''); setNote('');
    const r=await consoleRequest('/refill-energy','POST',{accountId,catId});
    setBusy('');
    if(!r.ok) setError(consoleError(r.reason));
    else setNote(`${login} · энергия 100%`);
  };
  return <section className={s.panel}><h2>Игроки на поле</h2>{error?<p role="alert" className={s.error}>{error}</p>:null}{note?<p role="status">{note}</p>:null}
    <div className={s.tableWrap}><table className={s.table}><thead><tr><th>Игрок</th><th>Местонахождение</th><th>Координаты</th><th>Телепортировать на спавн</th><th>Энергия</th></tr></thead><tbody>
      {data?.rooms.flatMap(room=>room.cats.map((cat)=><tr key={`${room.room}:${cat.id}`}><td>{cat.login}<br/><small>{cat.accountLogin}</small></td><td>{cat.locationLabel || room.title}</td><td>{cat.x}, {cat.y}</td><td>{cat.accountId?<div className={s.actions}>
        <select aria-label={`Точка спавна: ${cat.login}`} value={target[cat.accountId] || ''} onChange={e=>setTarget({...target,[cat.accountId!]:e.target.value})}><option value="">Выберите локацию и спавн</option>
          {data.locations.map(location=><optgroup key={location.id} label={`${location.zoneName} · ${location.name}`}>{location.spawns.map(spawn=><option key={spawn.index} value={`${location.id}:${spawn.index}`}>{spawn.automatic ? 'Свободная точка спавна' : `Спавн ${spawn.index+1} (${spawn.c+1}, ${spawn.r+1})`}</option>)}</optgroup>)}
        </select><button type="button" disabled={!!busy || !target[cat.accountId]} onClick={()=>void teleport(cat.accountId!)}>Переместить</button>
      </div>:<span className={s.muted}>Гостевая комната</span>}</td><td>{cat.accountId && cat.locationLabel ? (
        <button type="button" disabled={!!busy} onClick={()=>void refill(cat.id,cat.accountId!,cat.login)}>Восполнить энергию</button>
      ) : null}</td></tr>))}
    </tbody></table></div>{data && !data.rooms.length?<p className={s.muted}>На поле никого нет.</p>:null}
  </section>;
}
export function ConsoleWorld({permissions,settings,armor}:{permissions:string[];settings:ReactNode;armor:ReactNode}) {
  return <ConsoleSubtabs tabs={[
    ...(permissions.includes('world')?[{id:'field',label:'Игроки на поле',content:<FieldPlayers/>}]:[]),
    ...(permissions.includes('config')?[{id:'settings',label:'Настройки мира',content:<div className={s.stack}>{settings}{armor}</div>}]:[]),
  ]}/>;
}

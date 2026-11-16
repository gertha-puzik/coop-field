'use client';
import { useCallback,useEffect,useState } from 'react';
import { consoleRequest,consoleError,PERMISSION_LABELS,type ConsoleUser,type ConsoleRole } from '@/lib/net/http-console';
import { StatusesTab } from './statuses-tab';
import { ConsoleSubtabs } from './console-subtabs';
import s from './admin-console.module.css';
function Users({administration=false}:{administration?:boolean}) {
  const [users,setUsers]=useState<ConsoleUser[]>([]),[q,setQ]=useState(''),[error,setError]=useState(''),[removing,setRemoving]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false);
  const load=useCallback(async()=>{const r=await consoleRequest<{users:ConsoleUser[]}>('/users');if(r.ok)setUsers(r.users);else setError(consoleError(r.reason));},[]);
  useEffect(()=>{void load();},[load]);
  const remove=async()=>{setBusy(true);const r=await consoleRequest('/delete','POST',{accountId:removing,password});setPassword('');setBusy(false);if(!r.ok){setError(consoleError(r.reason));return;}setRemoving('');await load();};
  const shown=users.filter(user=>(!administration || user.permissions.length>0) && `${user.login} ${user.displayName}`.toLowerCase().includes(q.toLowerCase()));
  return <section className={s.panel}><h2>{administration?'Администрация':'Игроки'} · {shown.length}</h2>
    <input aria-label="Поиск игроков" placeholder="Имя или логин" value={q} onChange={e=>setQ(e.target.value)}/>
    {error?<p className={s.error} role="alert">{error}</p>:null}
    <div className={s.tableWrap}><table className={s.table}><thead><tr><th>Игрок</th><th>Статус на поле</th><th>Присутствие</th><th>Доступ</th><th>Действия</th></tr></thead><tbody>{shown.map(user=><tr key={user.accountId}>
      <td><a href={`/players/?id=${user.accountId}`}>{user.displayName}</a><small className={s.muted}><br/>{user.login}</small></td>
      <td>{user.statusLabel}</td><td>{{online:'В сети',traveling:'Путешествует',away:'Отошёл',resting:'Не в сети'}[user.presence] || user.presence}</td><td>{user.accessRoleId || 'Нет роли доступа'}</td>
      <td><button type="button" onClick={()=>{setRemoving(user.accountId);setPassword('');setError('');}}>Удалить аккаунт</button></td>
    </tr>)}</tbody></table></div>
    {removing?<div className={s.error}><p>Удалить аккаунт «{users.find(u=>u.accountId===removing)?.displayName}»? Вход будет закрыт, данные профиля и личные файлы удалены.</p>
      <div className={s.actions}><input type="password" autoComplete="off" aria-label="Специальный пароль удаления" placeholder="Специальный пароль" value={password} onChange={e=>setPassword(e.target.value)}/>
      <button type="button" disabled={busy || !password} onClick={()=>void remove()}>Подтвердить удаление</button><button type="button" disabled={busy} onClick={()=>{setRemoving('');setPassword('');}}>Отмена</button></div></div>:null}
  </section>;
}
function AccessRoles() {
  const [roles,setRoles]=useState<ConsoleRole[]>([]),[users,setUsers]=useState<ConsoleUser[]>([]),[draft,setDraft]=useState<ConsoleRole>({id:'',name:'',permissions:[]}),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const load=useCallback(async()=>{const [r,u]=await Promise.all([consoleRequest<{roles:ConsoleRole[]}>('/roles'),consoleRequest<{users:ConsoleUser[]}>('/users')]);if(r.ok)setRoles(r.roles);else setError(consoleError(r.reason));if(u.ok)setUsers(u.users);},[]);
  useEffect(()=>{void load();},[load]);
  const mutate=async(path:string,method:string,body?:unknown)=>{setBusy(true);setError('');const r=await consoleRequest(path,method,body);setBusy(false);if(!r.ok){setError(consoleError(r.reason));return false;}await load();return true;};
  return <section className={s.panel}><h2>Роли доступа</h2><p className={s.muted}>Это права доступа. Косметические статусы на поле настраиваются отдельно и прав не дают.</p>
    {error?<p className={s.error} role="alert">{error}</p>:null}
    <div className={s.actions}>{roles.map(role=><button key={role.id} type="button" aria-pressed={draft.id===role.id} onClick={()=>setDraft({...role,permissions:[...role.permissions]})}>{role.name}</button>)}<button type="button" onClick={()=>setDraft({id:'',name:'',permissions:[]})}>+ Новая роль</button></div>
    <form onSubmit={e=>{e.preventDefault();const row={...draft,id:draft.id || `role-${crypto.randomUUID().slice(0,8)}`};void mutate('/roles','POST',row).then(ok=>{if(ok)setDraft(row);});}}>
      <div className={s.form}><label>Название роли<input maxLength={48} required value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label></div>
      <div className={s.permissions}>{Object.entries(PERMISSION_LABELS).map(([key,label])=><label key={key}><input type="checkbox" checked={draft.permissions.includes(key)} onChange={e=>setDraft({...draft,permissions:e.target.checked?[...draft.permissions,key]:draft.permissions.filter(p=>p!==key)})}/>{label}</label>)}</div>
      <div className={s.actions}><button type="submit" disabled={busy || !draft.name.trim()}>Сохранить роль</button>{draft.id?<button type="button" disabled={busy} onClick={()=>void mutate(`/roles/${draft.id}`,'DELETE').then(ok=>{if(ok)setDraft({id:'',name:'',permissions:[]});})}>Удалить роль — снять её права</button>:null}</div>
    </form>
    <h2 className="mt-6">Назначения</h2><div className={s.tableWrap}><table className={s.table}><tbody>{users.map(user=><tr key={user.accountId}><td>{user.displayName}<br/><small>{user.login}</small></td><td>
      <select aria-label={`Роль доступа: ${user.displayName}`} value={user.accessRoleId} disabled={busy} onChange={e=>void mutate('/assign','POST',{accountId:user.accountId,roleId:e.target.value})}>
        <option value="">Без роли доступа</option>{user.accessRoleId==='admin'?<option value="admin" disabled>Системный администратор</option>:null}{roles.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}
      </select></td></tr>)}</tbody></table></div>
  </section>;
}
export function ConsoleUsers({permissions}:{permissions:string[]}) {
  return <ConsoleSubtabs tabs={[
    ...(permissions.includes('players')?[{id:'users',label:'Игроки',content:<Users/>},{id:'administration',label:'Администрация',content:<Users administration/>}]:[]),
    ...(permissions.includes('roles')?[{id:'roles',label:'Роли доступа',content:<AccessRoles/>}]:[]),
    ...(permissions.includes('statuses')?[{id:'statuses',label:'Косметические статусы',content:<StatusesTab/>}]:[]),
  ]}/>;
}

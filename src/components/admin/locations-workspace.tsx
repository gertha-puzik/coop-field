'use client';

import { useEffect, useState } from 'react';
import { httpCreateLocation, httpLocations } from '@/lib/net/http-locations';
import { LocationPreview } from './location-preview';
import { locationRoom, type LocationPlace } from '@/lib/sim/location-map';
import s from './admin-console.module.css';
import styles from './locations-workspace.module.css';

function editorAddress(id: number) {
  const params = new URLSearchParams({room:locationRoom(id), editLocation:String(id)});
  const ws = new URLSearchParams(window.location.search).get('ws');
  if (ws) params.set('ws',ws);
  return `/game/?${params}`;
}

export function LocationsWorkspace() {
  const [locations,setLocations] = useState<LocationPlace[]>([]);
  const [regions,setRegions] = useState<string[]>([]);
  const [selected,setSelected] = useState<number>();
  const [editing,setEditing] = useState<number>();
  const [filter,setFilter] = useState('');
  const [sort,setSort] = useState('name');
  const [name,setName] = useState('');
  const [id,setId] = useState('');
  const [region,setRegion] = useState('1');
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [previewRevision,setPreviewRevision] = useState(0);
  const [note,setNote] = useState('');

  useEffect(() => {
    let active = true;
    void httpLocations().then(result => {
      if (!active) return;
      setLoading(false);
      if (!result.ok) { setError(result.message || 'Не удалось загрузить локации.'); return; }
      setLocations(result.locations);
      setRegions(result.regions);
      setSelected(current=>result.locations.some(location=>location.id===current) ? current : result.locations[0]?.id);
    });
    return () => { active=false; };
  }, [previewRevision]);

  const groups = [...new Set([...regions, ...locations.map(location=>location.zoneName)])];
  const chosen = locations.find(location=>location.id===selected);
  const opened = locations.find(location=>location.id===editing);
  const highestId = Math.max(0,...locations.map(location=>location.id));
  const nextId = highestId<9999 ? highestId+1 : Array.from({length:locations.length+1},(_,i)=>i+1)
    .find(candidate=>locations.every(location=>location.id!==candidate));
  function selectRegion(value: string) {
    setFilter(value);
    if (value && chosen?.zoneName!==value) setSelected(locations.find(location=>location.zoneName===value)?.id);
    if (!value && !chosen) setSelected(locations[0]?.id);
  }

  async function createLocation() {
    setError('');
    setNote('');
    if (id && locations.some(location=>location.id===Number(id))) {
      setError(`Локация с ID ${id} уже существует.`);
      return;
    }
    if (!name.trim()) { setError('Введите название локации.'); return; }
    setBusy(true);
    try {
      const result = await httpCreateLocation(name,{id:Number(id || nextId),zoneId:Number(region)});
      if (!result.ok) { setError(result.message || 'Не удалось создать локацию.'); return; }
      setLocations(result.locations);
      setSelected(result.place.id);
      setFilter(result.place.zoneName);
      setName('');
      setId('');
      setNote(`Создана локация «${result.place.name}».`);
    } finally {
      setBusy(false);
    }
  }

  if (opened) {
    const address = editorAddress(opened.id);
    return <section className={styles.editor}>
      <header className={s.actions}>
        <button type="button" onClick={()=>{
          if (!window.confirm('Вернуться к списку локаций? Убедитесь, что изменения в редакторе сохранены.')) return;
          setEditing(undefined);
          setPreviewRevision(value=>value+1);
        }}>← К списку локаций</button>
        <strong>{opened.zoneName} · {opened.name} · ID {opened.id}</strong>
        <a href={address} target="_blank" rel="noreferrer">Открыть в новой вкладке</a>
      </header>
      <iframe key={opened.id} src={address} title={`Редактор локации «${opened.name}»`} />
    </section>;
  }

  return <div className={styles.layout}>
    <section className={s.panel}>
      <h2>Локации</h2>
      <div className={styles.filters}>
        <label>Регион<select aria-label="Регион" value={filter} onChange={event=>selectRegion(event.target.value)}>
          <option value="">Все регионы</option>
          {groups.map(group=><option key={group}>{group}</option>)}
        </select></label>
        <label>Сортировка<select aria-label="Сортировка" value={sort} onChange={event=>setSort(event.target.value)}>
          <option value="name">По названию</option><option value="id">По ID</option>
        </select></label>
      </div>
      {loading && <p role="status">Загрузка локаций…</p>}
      <div className={styles.list}>
        {groups.filter(group=>!filter||group===filter).map(group=>{
          const rows=locations.filter(location=>location.zoneName===group).sort((a,b)=>sort==='id'?
            a.id-b.id : a.name.localeCompare(b.name,'ru') || a.id-b.id);
          if (!rows.length && !filter) return null;
          return <section key={group}><h3>{group}</h3>
            {rows.length ? <ul>{rows.map(location=><li key={location.id}>
              <button type="button" aria-pressed={chosen?.id===location.id} onClick={()=>setSelected(location.id)}>
                <span>{location.name}</span><small>ID {location.id}</small>
              </button>
            </li>)}</ul> : <p>В этом регионе пока нет локаций.</p>}
          </section>;
        })}
      </div>
    </section>
    <div className={s.stack}>
      {chosen && <section className={s.panel}>
        <h2>{chosen.name}</h2>
        <p>{chosen.zoneName} · ID {chosen.id}</p>
        <LocationPreview key={`${chosen.id}:${previewRevision}`} location={chosen}/>
        <button type="button" onClick={()=>setEditing(chosen.id)}>Открыть редактор</button>
      </section>}
      <section className={s.panel}>
        <h2>Новая локация</h2>
        <form className={styles.form} onSubmit={event=>{event.preventDefault();void createLocation();}}>
          <label>Название локации<input required maxLength={64} value={name} onChange={event=>setName(event.target.value)}/></label>
          <div className={styles.filters}>
            <label>ID локации<input type="number" min={1} max={9999} step={1} placeholder={nextId?.toString()}
              value={id} onChange={event=>setId(event.target.value)}/></label>
            <label>Регион новой локации<select aria-label="Регион новой локации" value={region} onChange={event=>setRegion(event.target.value)}>
              {regions.map((label,index)=><option key={label} value={index+1}>{label}</option>)}
            </select></label>
          </div>
          <div><button type="submit" disabled={busy||!regions.length}>{busy?'Создаём…':'Создать локацию'}</button></div>
        </form>
        {error && <p role="alert" className={s.error}>{error}</p>}
        {note && <p role="status">{note}</p>}
      </section>
    </div>
  </div>;
}

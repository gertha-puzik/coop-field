'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { httpOrigin } from '@/lib/net/coop';
import type { LocationPlace } from '@/lib/sim/location-map';
import { decodeTerrainRect } from '@/lib/sim/terrain-shape';
import s from './world-atlas.module.css';

// The four marked places retain the positions of the numbered points in the reference.
const regions = [
  {id:1,name:'Средиземье',color:'#ac396c',label:[414,292],anchor:[409,351],shape:'M243 137 Q312 112 353 132 Q392 150 429 142 L503 195 Q498 261 572 249 Q630 251 658 279 Q704 314 750 273 L754 339 Q702 399 632 377 Q601 372 581 385 Q550 408 524 448 Q462 416 414 450 L362 488 Q302 486 266 455 Q276 416 242 388 Q209 368 203 305 Q177 289 202 258 Q237 234 224 213 Q208 196 222 179 Q232 154 243 137 Z'},
  {id:2,name:'Южный лес',color:'#ad582d',label:[636,189],anchor:[711,163],shape:'M429 142 Q441 107 502 104 L536 115 Q576 92 638 97 Q719 79 753 143 Q789 205 750 273 Q704 314 658 279 Q630 251 572 249 Q498 261 503 195 Z'},
  {id:3,name:'Северный лес',color:'#9e8c24',label:[444,75],anchor:[548,63],shape:'M243 137 Q262 88 312 65 Q405 26 558 35 Q648 30 678 70 Q697 94 639 98 Q580 92 535 113 L501 104 Q452 104 429 142 Q392 150 353 132 Q312 112 243 137 Z'},
  {id:4,name:'Ферма',color:'#216987',label:[192,487],anchor:[165,658],shape:'M203 305 Q209 368 242 388 Q276 416 266 455 Q302 486 362 488 Q397 517 415 542 L379 563 Q412 594 361 650 Q322 699 249 699 Q199 731 130 707 Q100 690 63 680 Q18 668 40 616 Q73 554 99 492 Q104 460 126 415 Z'},
  {id:5,name:'Шахты',color:'#237758',label:[637,487],anchor:[636,553],shape:'M414 450 Q462 416 524 448 Q550 408 581 385 Q601 372 632 377 Q702 399 754 339 Q766 392 762 475 L773 627 Q798 701 711 712 Q631 724 562 699 Q504 695 490 631 Q483 581 430 571 L378 562 L415 541 L362 488 Z'},
  {id:6,name:'Город',color:'#792656',label:[113,313],anchor:[89,265],shape:'M271 85 Q252 109 243 137 Q232 154 222 179 Q208 196 224 213 Q237 234 202 258 Q177 289 203 305 L126 415 Q117 432 112 452 Q67 480 27 444 Q-12 417 18 355 Q64 207 153 151 Q200 117 271 85 Z'},
] as const;

function orderedTiles(values: Record<string,number>) {
  const tiles = Object.entries(values).map(([key,level])=>({key,tile:decodeTerrainRect(key,level)}));
  const legacy = tiles.filter(({key})=>key.split(',').length===2);
  return [...legacy,...tiles.filter(({key})=>key.split(',').length===4)];
}

type AtlasTerrain = {
  cols:number;
  rows:number;
  painted:boolean;
  elev:Record<string,number>;
  water:Record<string,number>;
  objects:{kind:string;c:number;r:number;x?:number;y?:number}[];
};

export function AtlasButton({open}: {open:()=>void}) {
  return <button className={s.trigger} type="button" onClick={open} aria-keyshortcuts="M" title="Карта мира (M)">
    Карта <kbd>M</kbd>
  </button>;
}

function TerrainPreview({id}: {id:number}) {
  const [terrain,setTerrain] = useState<AtlasTerrain>();
  const [failed,setFailed] = useState(false);
  const target = useRef<HTMLDivElement>(null);
  const waterMask = useId();
  const source = `${httpOrigin()}/cfg/locations?atlas=${id}`;
  useEffect(() => {
    const controller = new AbortController();
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void fetch(source,{credentials:'include',signal:controller.signal}).then(async response => {
        if (!response.ok) throw new Error('Atlas terrain unavailable');
        setTerrain(await response.json());
      }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    },{rootMargin:'120px'});
    if (target.current) observer.observe(target.current);
    return () => { observer.disconnect(); controller.abort(); };
  },[source]);

  const waterTiles = terrain ? orderedTiles(terrain.water) : [];
  return <div className={s.terrain} ref={target}>
    {terrain ? <svg role="img" aria-label="Рельеф локации" viewBox={`0 0 ${terrain.cols} ${terrain.rows * 1.5}`}>
      <g transform="scale(1 1.5)">
        <rect width={terrain.cols} height={terrain.rows} fill="#798042"/>
        {terrain.painted && <image href={`${source}&layer=paint`} width={terrain.cols} height={terrain.rows} preserveAspectRatio="none"/>}
        {orderedTiles(terrain.elev).map(({key,tile})=>tile && <rect key={key} x={tile.x} y={tile.y}
          width={tile.w} height={tile.d} fill={tile.level ? '#fdf1a6' : '#495120'}
          fillOpacity={tile.level ? Math.min(.12+tile.level*.09,.65) : .25}/>)}
        {terrain.objects.filter(o=>o.kind==='path').map(({c,r},i)=>
          <rect key={i} x={c} y={r} width={1} height={1} rx={.16} fill="#8a6b44"/>)}
        <mask id={waterMask} maskUnits="userSpaceOnUse" x={0} y={0} width={terrain.cols} height={terrain.rows}>
          {waterTiles.map(({key,tile})=>tile && <rect key={key} x={tile.x} y={tile.y}
            width={tile.w} height={tile.d} fill={tile.level?'white':'black'}/>)}
        </mask>
        <g mask={`url(#${waterMask})`}>
          {waterTiles.map(({key,tile})=>tile && tile.level>0 && <rect key={key} x={tile.x} y={tile.y}
            width={tile.w} height={tile.d} fill={['','#61b4bd','#4298ab','#2f7999','#236086'][tile.level] ?? '#236086'}/>)}
        </g>
        {terrain.objects.filter(o=>o.kind!=='path').map(({kind,c,r,x,y},i)=>
          <circle key={i} cx={x??c+.5} cy={y??r+.5} r={kind==='tree'?.38:.22}
            fill={kind==='tree'?'#31573a':kind==='waterfall'?'#a9e6ed':'#a99e81'}/>)}
      </g>
    </svg> : <span>{failed?'Рельеф недоступен':'Загрузка рельефа…'}</span>}
  </div>;
}

export function WorldAtlas({place,places,close}: {place:LocationPlace;places:LocationPlace[];close:()=>void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected,setSelected] = useState<number>();
  const heading = useRef<HTMLHeadingElement>(null);
  const locations = Array.from(new Map([...places,place].map(location=>[location.id,location])).values());
  const region = regions.find(entry=>entry.id===selected);
  const regionLocations = (id:number) => locations.filter(location=>location.zoneId===id).sort((a,b)=>a.id-b.id);
  useEffect(() => {
    const modal = dialog.current;
    modal?.showModal();
    window.dispatchEvent(new Event('game-ui:pause-controls'));
    return () => { modal?.close(); };
  },[]);
  function selectRegion(id?: number) {
    setSelected(id);
    if (dialog.current) dialog.current.scrollTop = 0;
    heading.current?.focus();
  }
  return <dialog ref={dialog} data-game-dialog className={s.dialog} aria-labelledby="atlas-title"
    onCancel={event=>{event.preventDefault();close();}}
    onClick={event=>{if(event.target===event.currentTarget)close();}}
    onKeyDown={event=>{
      if(event.code==='KeyM' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        if (!event.repeat) close();
      }
    }}>
    <div className={s.content}>
      <header className={s.header}>
        <div><h2 id="atlas-title" ref={heading} tabIndex={-1}>{region?.name ?? 'Карта мира'}</h2><p>Вы здесь · {place.zoneName} — {place.name}</p></div>
        <button type="button" className={s.close} aria-label="Закрыть карту" onClick={close}>×</button>
      </header>
      {region ? <>
        <button type="button" className={s.back} onClick={()=>selectRegion()}>← К карте мира</button>
        <div className={s.cards}>
          {regionLocations(region.id).map(location=><article className={s.card} key={location.id}
            aria-current={location.id===place.id?'location':undefined}>
            <h3>{location.name}</h3>
            {location.id===place.id && <p>Вы здесь</p>}
            <TerrainPreview id={location.id}/>
          </article>)}
          {!regionLocations(region.id).length && <p>В этом регионе пока нет локаций.</p>}
        </div>
      </> : <div className={s.overview}>
        <svg className={s.map} viewBox="0 10 800 720" aria-label="Регионы мира">
          {regions.map(({id,name,color,shape,label,anchor})=>{
            const current = id===place.zoneId;
            const entries = regionLocations(id);
            const markers = entries.slice(0,4);
            if (current && !markers.some(location=>location.id===place.id)) markers[3] = place;
            const offsets = [[0,0],[17,-11],[-13,15],[24,12]];
            return <g key={id} className={s.region} role="button" tabIndex={0}
              aria-label={current?`${name}, текущий регион`:name}
              onClick={()=>selectRegion(id)} onKeyDown={event=>{
                if(event.key==='Enter'||event.key===' '){event.preventDefault();selectRegion(id);}
              }}>
              <path d={shape} fill={color} className={current?s.currentRegion:undefined}/>
              <text x={label[0]} y={label[1]}>{name}</text>
              {markers.map((location,index)=>{
                const here = location.id===place.id;
                return <circle key={location.id} cx={anchor[0]+offsets[index][0]} cy={anchor[1]+offsets[index][1]}
                  r={here?9:5} className={here?s.here:undefined}>
                  <title>{here?`${location.name} — вы здесь`:location.name}</title>
                </circle>;
              })}
            </g>;
          })}
        </svg>
        <nav className={s.legend} aria-label="Локации по регионам">
          {regions.map(({id,name,color})=><section key={id}>
            <button type="button" onClick={()=>selectRegion(id)} aria-current={id===place.zoneId?'location':undefined}>
              <span className={s.swatch} style={{background:color}}/>{name}
            </button>
            {regionLocations(id).map(location=><div key={location.id} className={s.place}
              aria-current={location.id===place.id?'location':undefined}>{location.name}</div>)}
          </section>)}
        </nav>
      </div>}
    </div>
  </dialog>;
}

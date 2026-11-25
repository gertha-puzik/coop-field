'use client';

import { useEffect, useRef, useState } from 'react';
import { httpOrigin } from '@/lib/net/coop';
import type { LocationPlace } from '@/lib/sim/location-map';
import { startLocationPreview, PREVIEW_YAW } from '@/lib/sim/location-preview-view';
import styles from './locations-workspace.module.css';

export function LocationPreview({ location }: { location: LocationPlace }) {
  const stage = useRef<HTMLDivElement>(null);
  const yaw = useRef(PREVIEW_YAW);
  const drag = useRef<{ id: number; x: number } | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  function rotate(direction: -1 | 1) {
    const quarter = Math.PI/2;
    const step = yaw.current/quarter;
    const next = direction===1 ? Math.floor(step+1e-6)+1 : Math.ceil(step-1e-6)-1;
    yaw.current=next*quarter;
  }

  useEffect(() => {
    if (status!=='ready') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.code!=='BracketLeft' && event.code!=='BracketRight') return;
      if (event.target instanceof HTMLElement &&
          (event.target.isContentEditable || event.target.closest('input,textarea,select'))) return;
      event.preventDefault();
      if (!event.repeat) rotate(event.code==='BracketLeft'?-1:1);
    };
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[status]);

  useEffect(() => {
    const target = stage.current;
    if (!target) return;
    const controller = new AbortController();
    const source = `${httpOrigin()}/cfg/locations?atlas=${location.id}`;
    return startLocationPreview(target,source,yaw,controller,status=>setStatus(status));
  },[location.id]);

  return <div className={styles.preview}>
    <div className={styles.previewViewport}
      role="img" aria-label={`Объёмный предпросмотр «${location.name}»`}
      onPointerDown={event=>{
        if (event.button!==0 || status!=='ready') return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current={id:event.pointerId,x:event.clientX};
      }}
      onPointerMove={event=>{
        const active=drag.current;
        if (active?.id!==event.pointerId) return;
        yaw.current+=(event.clientX-active.x)*.012;
        active.x=event.clientX;
      }}
      onLostPointerCapture={()=>{drag.current=null;}}>
      <div ref={stage} style={{width:'100%',height:'100%'}}/>
      {status!=='ready' && <p role="status">
        {status==='loading'?'Загрузка рельефа…':'Не удалось загрузить предпросмотр локации.'}
      </p>}
    </div>
    <div className={styles.previewControls} role="group" aria-label="Поворот предпросмотра">
      <button type="button" disabled={status!=='ready'} aria-label="Повернуть предпросмотр влево"
        aria-keyshortcuts="[" onClick={()=>rotate(-1)}>↶ [</button>
      <button type="button" disabled={status!=='ready'} aria-label="Повернуть предпросмотр вправо"
        aria-keyshortcuts="]" onClick={()=>rotate(1)}>↷ ]</button>
      <button type="button" disabled={status!=='ready'} onClick={()=>{yaw.current=PREVIEW_YAW;}}>Исходный ракурс</button>
      <span>[ и ] меняют ракурс на 90°. Перетаскивание вращает карту свободно.</span>
    </div>
  </div>;
}

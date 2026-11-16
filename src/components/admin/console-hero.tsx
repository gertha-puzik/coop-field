'use client';
import { useEffect,useRef } from 'react';
import { BANNER_W,BANNER_H,generateBanner,paintPixels } from '@/lib/sim/banner-gen';
import { PawGlyph } from '@/components/players/profile-icons';
import s from './admin-console.module.css';
export function ConsoleHero({title}:{title:string}) {
  const canvas=useRef<HTMLCanvasElement|null>(null);
  useEffect(()=>{const ctx=canvas.current?.getContext('2d');if(ctx)paintPixels(ctx,generateBanner('elysiae-admin-night'),1);},[]);
  return <header className={s.hero}><canvas ref={canvas} width={BANNER_W} height={BANNER_H} aria-hidden/>
    <span aria-hidden><svg viewBox="0 0 24 24" width="52" height="52" fill="currentColor"><PawGlyph/></svg></span>
    <div><h1>{title}</h1><p>Управление игрой, миром и пользователями.</p></div>
  </header>;
}

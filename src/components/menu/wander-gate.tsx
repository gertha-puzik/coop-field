'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Lilita_One } from 'next/font/google';
import { wsUrl } from '@/lib/net/coop';
import { playersLabel } from '@/components/sim/room-picker';
// Звёздный фон вынесен в star-backdrop.tsx (переиспользуется и контентными
// страницами); здесь — патч-замена инлайн-блока 1:1: тот же массив, те же
// классы wander-star/wander-spark, появление после гидрации.
import { StarBackdrop } from '@/components/menu/star-backdrop';
import { WanderNewsHotspot } from '@/components/menu/wander-home-board';
// Пересводка W2 (2026-11-08): навигацию аккаунтов главной несёт общая шапка
// сайта. Макет 2026-11-14: на главной кнопки справа вверху (home). Фон —
// авторский арт /menu/home-bg.jpg; доска справа — кликабельный hotspot.
import { SiteHeader } from '@/components/site/site-header';

const display = Lilita_One({ weight: '400', subsets: ['latin'], display: 'swap' });

/**
 * Compile-time вариант сайта (P3): сравнение инлайном, а не через хелпер из
 * site.ts — сборщик сворачивает его в false/true, и мёртвая ветка (в grotto —
 * карточки и коды Элизии с их текстами) не попадает в бандл вовсе (спек §2A).
 */
const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria';

/**
 * Состав комнат для живого счётчика — только миры этого варианта (P3):
 * grotto спрашивает гроты и голодные игры, elyria — комнату Элизии.
 * Код закрытой комнаты (test) в grotto на сервер не уходит вовсе.
 */
const GROTTO_ROOM_IDS = ['grot-1', 'grot-2', 'grot-3', 'hunger'] as const;
const ELYRIA_SEED_ROOMS = ['test', 'test-loc-2'] as const;

type Preview = 'combat' | 'hunger' | 'elision';

type WorldCard = {
  href: string;
  name: string;
  blurb: string;
  italic: boolean;
  ids: readonly string[];
  preview: Preview;
};

/** Мировые карточки меню. В grotto-варианте Элизии нет — ни кода, ни ссылки. */
const GROTTO_WORLDS: readonly WorldCard[] = [
  {
    href: '/combat/',
    name: 'abnocw',
    blurb: 'Симуляция активного боя из игры Catwar',
    italic: true,
    ids: ['grot-1', 'grot-2', 'grot-3'],
    preview: 'combat',
  },
  {
    href: '/hunger/',
    name: 'Wanderpaws: Hunger Games',
    blurb: 'Великие игры Пузорящиков, находятся в разработке...',
    italic: false,
    ids: ['hunger'],
    preview: 'hunger',
  },
];

/** Элизия: меню — мир Элизии. Карточки гротов сюда не показываем. */
const ELYRIA_WORLDS: readonly WorldCard[] = [
  {
    href: '/game/',
    name: 'Wanderpaws: Elysiae',
    blurb: 'Твой путь начинается здесь',
    italic: true,
    ids: [...ELYRIA_SEED_ROOMS],
    preview: 'elision',
  },
];

const WORLDS: readonly WorldCard[] = IS_ELYRIA ? ELYRIA_WORLDS : GROTTO_WORLDS;

/**
 * Превью мира Элизии (луна) — JSX живёт в elyria-ветке тернарника: сборка
 * grotto не содержит ни разметки, ни ссылки на маршрут (спек §2A).
 */
const ELISION_PREVIEW = IS_ELYRIA ? (
  <div className="wander-preview wander-preview-elision" aria-hidden>
    <span className="wander-moon" />
  </div>
) : null;

/**
 * Старые ссылки с `?room=` вели на корень. Корень теперь меню — уводим в свой
 * мир, но только если этот мир есть в варианте сайта: grotto не редиректит на
 * вырезанный маршрут Элизии (404 и утечка маршрута), elyria — на гроты.
 */
function legacyRoomHref(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const room = (params.get('room') || '').trim();
  if (!room) return null;
  const q = window.location.search;
  if (IS_ELYRIA) {
    // Только комната Элизии; чужие коды в этом варианте каталожным мирам
    // не соответствуют — остаёмся на меню, без редиректа в 404.
    return room === 'test' ? `/game/${q}` : null;
  }
  if (room === 'test') return null; // закрытая комната в grotto не открывается
  if (room === 'hunger') return `/hunger/${q}`;
  return `/combat/${q}`;
}

function useLiveCounts() {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [online, setOnline] = useState(false);
  const [roomIds, setRoomIds] = useState<string[]>(
    IS_ELYRIA ? [...ELYRIA_SEED_ROOMS] : [...GROTTO_ROOM_IDS],
  );
  useEffect(() => {
    if (!IS_ELYRIA) return;
    let dead = false;
    void import('@/lib/net/http-locations').then(async ({ httpLocations }) => {
      const res = await httpLocations();
      if (dead || !res.ok || !res.rooms.length) return;
      setRoomIds(res.rooms);
    });
    return () => { dead = true; };
  }, []);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let poll = 0;
    let retry = 0;
    let dead = false;
    const ask = () => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(['rooms', { ids: roomIds.slice(0, 32) }]));
      }
    };
    const open = () => {
      if (dead) return;
      ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        setOnline(true);
        ask();
        poll = window.setInterval(ask, 2000);
      };
      ws.onmessage = (ev) => {
        let msg: unknown;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (!Array.isArray(msg) || msg[0] !== 'roomsinfo' || !Array.isArray(msg[1])) return;
        const next: Record<string, number> = {};
        for (const raw of msg[1] as { id?: unknown; count?: unknown }[]) {
          if (!raw || typeof raw.id !== 'string') continue;
          next[raw.id] = Math.max(0, Math.round(Number(raw.count) || 0));
        }
        setCounts(next);
      };
      ws.onclose = () => {
        setOnline(false);
        window.clearInterval(poll);
        if (!dead) retry = window.setTimeout(open, 1500);
      };
      ws.onerror = () => {
        /* onclose закроет и поднимет снова */
      };
    };
    open();
    return () => {
      dead = true;
      window.clearInterval(poll);
      window.clearTimeout(retry);
      try {
        ws?.close();
      } catch {
        /* сокет уже закрыт */
      }
    };
  }, [roomIds]);
  return { counts, online, roomIds };
}

function sumCounts(counts: Record<string, number>, ids: readonly string[], online: boolean): number | null {
  if (!online || ids.some((id) => counts[id] == null)) return null;
  return ids.reduce((sum, id) => sum + (counts[id] ?? 0), 0);
}

type Paw = { id: number; x: number; y: number; rot: number };

/** Следы лап за курсором: левая и правая по очереди, гаснут сами. */
function PawTrail() {
  const [paws, setPaws] = useState<Paw[]>([]);
  const seq = useRef(0);
  const last = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const drop = (ev: PointerEvent) => {
      if (ev.pointerType === 'touch') return;
      const prev = last.current;
      const x = ev.clientX;
      const y = ev.clientY;
      last.current = { x, y };
      if (!prev) return;
      const dx = x - prev.x;
      const dy = y - prev.y;
      if (Math.hypot(dx, dy) < 34) return;
      const angle = Math.atan2(dy, dx);
      const side = seq.current % 2 === 0 ? 1 : -1;
      seq.current += 1;
      const id = seq.current;
      const ox = Math.cos(angle + Math.PI / 2) * 11 * side;
      const oy = Math.sin(angle + Math.PI / 2) * 11 * side;
      const paw: Paw = {
        id,
        x: x + ox,
        y: y + oy,
        rot: (angle * 180) / Math.PI + 70 + side * 16,
      };
      setPaws((list) => [...list.slice(-18), paw]);
      window.setTimeout(() => setPaws((list) => list.filter((item) => item.id !== id)), 2200);
    };
    window.addEventListener('pointermove', drop);
    return () => window.removeEventListener('pointermove', drop);
  }, []);
  return (
    <div className="pointer-events-none fixed inset-0 z-30" aria-hidden>
      {paws.map((paw) => (
        <img
          key={paw.id}
          src="/lapka.svg"
          alt=""
          className="wander-paw"
          style={{ left: paw.x, top: paw.y, ['--rot' as string]: `${paw.rot}deg` }}
        />
      ))}
    </div>
  );
}

function Grass() {
  const blades = Array.from({ length: 56 }, (_, i) => {
    const x = (i / 55) * 1200;
    const h = 26 + ((i * 19) % 40);
    const lean = i % 2 === 0 ? -10 : 9;
    return (
      <path
        key={i}
        d={`M${x.toFixed(1)} 86 Q ${(x + lean).toFixed(1)} ${(86 - h * 0.55).toFixed(1)} ${(x + lean * 0.35).toFixed(1)} ${(86 - h).toFixed(1)}`}
        fill="none"
        stroke={i % 3 === 0 ? '#07140c' : '#0c2216'}
        strokeWidth={2.4 + (i % 3)}
        strokeLinecap="round"
      />
    );
  });
  return (
    <svg className="wander-grass" viewBox="0 0 1200 86" preserveAspectRatio="none" aria-hidden>
      <path d="M0 46 Q 180 18 360 48 T 740 40 T 1200 50 V 86 H 0 Z" fill="#07140e" />
      <path d="M0 62 Q 200 44 420 66 T 860 58 T 1200 68 V 86 H 0 Z" fill="#040c09" />
      {blades}
    </svg>
  );
}

function NightSky({
  children,
  home = false,
  boardHotspot = null,
}: {
  children: ReactNode;
  home?: boolean;
  /** Hotspot доски — внутри 16:9-рамки арта, чтобы % совпадали с картинкой. */
  boardHotspot?: ReactNode;
}) {
  return (
    <div className={home ? 'wander-sky wander-sky-home' : 'wander-sky'}>
      {home ? (
        // Рамка 16:9 cover: ровная обрезка по центру + hotspot в тех же %.
        <div className="wander-home-art">
          <img className="wander-home-bg" src="/menu/home-bg.jpg" alt="" />
          {boardHotspot}
        </div>
      ) : (
        <>
          <div className="wander-drift" aria-hidden />
          <StarBackdrop />
        </>
      )}
      <PawTrail />
      <div className={home ? 'wander-stage wander-stage-home' : 'wander-stage'}>{children}</div>
      {home ? null : <Grass />}
    </div>
  );
}

function WorldPreview({ kind }: { kind: Preview }) {
  if (kind === 'combat') return <div className="wander-preview wander-preview-combat" aria-hidden />;
  if (kind === 'hunger') {
    return (
      <div className="wander-preview wander-preview-hunger" aria-hidden>
        <span>в разработке</span>
      </div>
    );
  }
  return ELISION_PREVIEW;
}

/** Главное меню: авторский фон, окна миров слева снизу, доска справа —
 *  hotspot → модалка новостей; на закрытом варианте — шапка сверху. */
export function WanderMenu() {
  const { counts, online, roomIds } = useLiveCounts();
  useEffect(() => {
    const href = legacyRoomHref();
    if (href) window.location.replace(href);
  }, []);
  return (
    <NightSky home boardHotspot={<WanderNewsHotspot />}>
      <h1 className="sr-only">Wanderpaws</h1>
      <div className="wander-topbar">
        {IS_ELYRIA ? <SiteHeader ghost home /> : <span aria-hidden />}
      </div>
      <div className="wander-layout wander-layout-art">
        <div className="wander-layout-main">
          <div className="wander-worlds">
            {WORLDS.map((world) => {
              const ids = IS_ELYRIA && world.preview === 'elision' ? roomIds : world.ids;
              const n = sumCounts(counts, ids, online);
              return (
                <a key={world.href} className="wander-window" href={world.href}>
                  <span className="wander-window-knob" aria-hidden />
                  <WorldPreview kind={world.preview} />
                  <span className="wander-name">{world.name}</span>
                  <span className={world.italic ? 'wander-blurb wander-blurb-italic' : 'wander-blurb'}>{world.blurb}</span>
                  <span className="wander-count" aria-live="polite">
                    <i className={online ? 'wander-dot wander-dot-on' : 'wander-dot'} />
                    {n == null ? 'считаем…' : playersLabel(n)}
                  </span>
                </a>
              );
            })}
            {!IS_ELYRIA ? (
              <a className="wander-window" href="https://phainonsmilk.ru/">
                <span className="wander-window-knob" aria-hidden />
                <span className="wander-name">Wanderpaws: Elysiae</span>
                <span className="wander-blurb">Закрытый мир — вход по аккаунту, отдельный сайт</span>
                <span className="wander-count">отдельный сайт →</span>
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </NightSky>
  );
}

/** Голодные игры пока не играются: та же ночь, без поля. */
export function HungerGate() {
  return (
    <NightSky>
      <a className="wander-back" href="/">
        ← Главное меню
      </a>
      <header className="wander-hero">
        <h1 className={`${display.className} wander-title wander-title-small`}>Wanderpaws: Hunger Games</h1>
        <p className="wander-lead">Великие игры Пузорящиков, находятся в разработке...</p>
      </header>
      <p className="wander-note">Эта страница пока в разработке. Поле откроется позже — вернуться можно в главное меню.</p>
    </NightSky>
  );
}

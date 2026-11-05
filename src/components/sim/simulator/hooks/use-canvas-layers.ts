/**
 * Canvas pipeline hooks of the Simulator, carved out verbatim from
 * simulator.tsx (W5b stage 2, behavior-preserving). Three independent
 * contracts, each called from simulator.tsx at the position of the original
 * effect (hook order and timing are unchanged):
 *  - `useAimPublisher`: installs `publishAimRef` — throttled (~32 ms)
 *    publisher of the local arrow angle into the room; the effect keeps the
 *    original shape and has NO deps array (re-installed on every render);
 *  - `useSpriteCache`: preloads all FIELD_SPRITES into images plus white
 *    silhouette canvases, remembering broken ones; runs once (`[]`);
 *  - `useAtmosphereLayer`: mounts the dynamic Pixi atmosphere over the field
 *    canvas when `stage === 'field'` and tears it down on exit (`[stage]`).
 *    The layer canvas is created imperatively and lives exactly one mount:
 *    the old React-rendered slot canvas survived `destroy()` while pixi
 *    loseContext killed its WebGL context, so a remount (dev StrictMode,
 *    room change) got `getContext()` on the dead context — the layer silently
 *    died until a full page reload.
 */
import { useEffect, type RefObject } from 'react';
import type { CoopAtmo, createCoopClient } from '@/lib/net/coop';
import { FIELD_SPRITES, wrap180, wrap360, type SimSettings, type SpriteId } from '@/lib/sim/settings';
import type { AtmosphereLike } from '../sim-model';

export interface AimPublisherDeps {
  netRef: RefObject<ReturnType<typeof createCoopClient> | null>;
  settingsRef: RefObject<SimSettings>;
  aimSyncRef: RefObject<{ deg: number | null; at: number; pending: number | null; timer: ReturnType<typeof setTimeout> | null }>;
  publishAimRef: RefObject<(angle: number, force: boolean) => void>;
}

export function useAimPublisher(deps: AimPublisherDeps) {
  const { netRef, settingsRef, aimSyncRef, publishAimRef } = deps;
  useEffect(() => {
    publishAimRef.current = (angle: number, force: boolean) => {
      const net = netRef.current;
      if (!net?.ready || settingsRef.current.controlled !== 'main') return;
      const deg = Math.round(wrap360(angle) * 10) / 10;
      const sync = aimSyncRef.current;
      const now = performance.now();
      const changed = sync.deg == null || Math.abs(wrap180(deg - sync.deg)) >= 0.05;
      if (!changed) {
        sync.pending = null;
        if (sync.timer) {
          clearTimeout(sync.timer);
          sync.timer = null;
        }
        return;
      }
      const AIM_EMIT_MS = 32;
      const due = sync.at === 0 || now - sync.at >= AIM_EMIT_MS;
      if (force || due) {
        if (sync.timer) {
          clearTimeout(sync.timer);
          sync.timer = null;
        }
        sync.pending = null;
        sync.deg = deg;
        sync.at = now;
        net.emit('aim', { deg });
        return;
      }
      sync.pending = deg;
      if (sync.timer) return;
      const wait = Math.max(0, AIM_EMIT_MS - (now - sync.at));
      sync.timer = setTimeout(() => {
        sync.timer = null;
        const latest = sync.pending;
        sync.pending = null;
        const netNow = netRef.current;
        if (latest == null || !netNow?.ready || settingsRef.current.controlled !== 'main') return;
        if (sync.deg != null && Math.abs(wrap180(latest - sync.deg)) < 0.05) return;
        sync.deg = latest;
        sync.at = performance.now();
        netNow.emit('aim', { deg: latest });
      }, wait);
    };
  });
}


export interface SpriteCacheDeps {
  spritesRef: RefObject<Partial<Record<SpriteId, HTMLImageElement>>>;
  whiteSpritesRef: RefObject<Partial<Record<SpriteId, HTMLCanvasElement>>>;
  brokenSpritesRef: RefObject<Set<SpriteId>>;
}

export function useSpriteCache(deps: SpriteCacheDeps) {
  const { spritesRef, whiteSpritesRef, brokenSpritesRef } = deps;
  useEffect(() => {
    let cancelled = false;
    for (const sp of FIELD_SPRITES) {
      const img = new Image();
      const store = () => {
        if (cancelled || spritesRef.current[sp.id]) return;
        spritesRef.current[sp.id] = img;
        // светлый силуэт того же спрайта: тонкая обводка своего кота
        const wc = document.createElement('canvas');
        wc.width = img.naturalWidth;
        wc.height = img.naturalHeight;
        const wctx = wc.getContext('2d');
        if (wctx) {
          wctx.drawImage(img, 0, 0);
          wctx.globalCompositeOperation = 'source-in';
          wctx.fillStyle = '#f4f4f5';
          wctx.fillRect(0, 0, wc.width, wc.height);
        }
        whiteSpritesRef.current[sp.id] = wc;
      };
      // Обработчик до src: у уже лежащего в кэше PNG load бывает синхронным,
      // и назначенный после src onload его не видит — кот остаётся без картинки.
      img.onload = store;
      img.onerror = () => {
        if (!cancelled) brokenSpritesRef.current.add(sp.id);
      };
      img.src = sp.src;
      if (img.complete && img.naturalWidth > 0) store();
    }
    return () => {
      cancelled = true;
    };
  }, []);
}


export interface AtmosphereLayerDeps {
  stage: 'entry' | 'field';
  canvasRef: RefObject<HTMLCanvasElement | null>;
  pixiRef: RefObject<HTMLDivElement | null>;
  atmoRef: RefObject<AtmosphereLike | null>;
  atmoStateRef: RefObject<CoopAtmo>;
  atmoOnRef: RefObject<boolean>;
}

export function useAtmosphereLayer(deps: AtmosphereLayerDeps) {
  const { stage, canvasRef, pixiRef, atmoRef, atmoStateRef, atmoOnRef } = deps;
  useEffect(() => {
    if (stage !== 'field') return;
    const slot = pixiRef.current;
    const worldCv = canvasRef.current;
    if (!slot || !worldCv) return;
    let dead = false;
    // Канвас слоя создаётся императивно и живёт ровно один монтаж. Раньше его
    // рендерил React как слот: pixi destroy убивал WebGL-контекст вместе с
    // канвасом, а повторный монтаж (React StrictMode в dev, смена комнаты)
    // получал через getContext тот же уже убитый контекст — слой молча умирал
    // до F5. Свежий канвас каждый раз — свежий (живой) контекст.
    const cnv = document.createElement('canvas');
    // Геометрия — как у бывшего canvas-слота в field-stage: заполнить слот
    // контейнера (block, 100×100%) со скруглением; события мыши режутся самим
    // слотом (pointer-events-none).
    cnv.className = 'block h-full w-full rounded-lg pointer-events-none';
    slot.appendChild(cnv);
    import('@/lib/sim/atmosphere')
      .then(({ Atmosphere }) => (dead ? undefined : Atmosphere.create(cnv, worldCv)))
      .then((a) => {
        if (!a) return;
        if (dead) {
          a.destroy();
          return;
        }
        atmoRef.current = a;
        a.setDaypart(atmoStateRef.current.dp);
        a.setWeather(atmoStateRef.current.w);
        // повторно созданный слой (смена комнаты) помнит дебаг-тумблер
        a.setVisible(atmoOnRef.current);
      })
      .catch(() => {
        // без WebGL слой не встал — пустой канвас убираем из слота;
        // работает прежний 2D-рендер
        cnv.remove();
      });
    return () => {
      dead = true;
      atmoRef.current?.destroy();
      atmoRef.current = null;
      // канвас слоя умирает вместе со слоем — повторно контекст не используем
      cnv.remove();
    };
  }, [stage]);

}

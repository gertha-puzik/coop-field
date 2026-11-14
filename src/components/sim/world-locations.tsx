'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Button, Dropdown } from '@/components/ui';
import type { createCoopClient } from '@/lib/net/coop';
import type { SimSettings } from '@/lib/sim/settings';
import type { TestMap } from '@/lib/sim/test-map';
import type { EditorDraft } from '@/lib/sim/editor-model';
import { defaultPlace, locationRoom, passageContains, type LocationPlace, type LocationPassage } from '@/lib/sim/location-map';
import type { Engine } from './simulator/sim-model';
import styles from './world-locations.module.css';
import editorStyles from './simulator/components/editor-workspace.module.css';
import { LocationCreatePanel } from './location-create-panel';
const LOAD_MIN_MS=10000;
const LOAD_TIP = 'Исследуй мир. В каждом его уголке есть свои секреты.';

/** Панель загрузки локации — тот же пейзаж, что при переходе между локациями. */
export function LocationLoadingPanel(props: {
  title: string;
  subtitle?: string;
  progress: number;
  detail: string;
  tip?: string;
  countdown?: ReactNode;
  actions?: ReactNode;
}) {
  const { title, subtitle, progress, detail, tip = LOAD_TIP, countdown, actions } = props;
  return (
    <div className={styles.loading}>
      <div className={styles.landscape} aria-hidden />
      <div className={styles.loadingContent}>
        <img src="/lapka.svg" width="36" height="36" alt="" />
        <h1>Wanderpaws</h1>
        <span className={styles.compass} aria-hidden>✧</span>
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
        <progress max="100" value={Math.max(0, Math.min(100, progress))} aria-label="Готовность локации" />
        <p>{detail}</p>
        {actions}
        {countdown}
        <i>{tip}</i>
      </div>
    </div>
  );
}

/** Полноэкранная крышка первого входа / ожидания карты (портал на body). */
export function LocationLoadingCover(props: {
  title: string;
  subtitle?: string;
  progress: number;
  detail: string;
  label?: string;
}) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className={styles.lock}
      data-phase="loading"
      role="status"
      aria-live="polite"
      aria-label={props.label ?? props.title}
    >
      <LocationLoadingPanel
        title={props.title}
        subtitle={props.subtitle}
        progress={props.progress}
        detail={props.detail}
      />
    </div>,
    document.body,
  );
}

type Phase = 'idle' | 'walk' | 'fade' | 'loading' | 'arrive';
type Options = {
    enabled: boolean;
    engine: RefObject<Engine>;
    settings: RefObject<SimSettings>;
    editor: RefObject<EditorDraft | null>;
    editorOpen: RefObject<boolean>;
    net: RefObject<ReturnType<typeof createCoopClient> | null>;
    foot: () => {
        dx: number;
        dy: number;
        rx: number;
        ry: number;
    };
    map: () => TestMap;
    ready: () => boolean;
    yaw:()=>number;
    support: (x: number, y: number) => number;
    walkable: (x: number, y: number) => boolean;
    moving: RefObject<{
        moving: boolean;
    }>;
    cancelInputs: () => void;
    openEditor: () => void;
    closeEditor: () => void;
};
type Run = {
    phase: Phase;
    since: number;
    target: number;
    passage?: LocationPassage;
    mapReceived: boolean;
    sent?: boolean;
    editor: boolean;
    start: {
        x: number;
        y: number;
    };
    end: {
        x: number;
        y: number;
    };
    ready: boolean;
    error: string;
};
const freshRun = (): Run => ({ phase: 'idle', since: 0, target: 0, mapReceived: false, editor: false, start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, ready: false, error: '' });
const textInput = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input,textarea,select,[contenteditable="true"]');
/** UI state stays outside the engine; tick only owns the short walk and input
 * lock. Server FIELD is the authority for map identity and arrival coordinates.
 */
export function useWorldLocations(options: Options) {
    const opts = useRef(options);
    opts.current = options;
    const run = useRef<Run>(freshRun());
    const prompt = useRef<LocationPassage | null>(null);
    const suppress = useRef<{
        map: number;
        untilOutside: boolean;
    }>({ map: 0, untilOutside: false });
    const [places, setPlaces] = useState<LocationPlace[]>([]);
    const [place, setPlace] = useState<LocationPlace>(defaultPlace());
    const [view, setView] = useState({ phase: 'idle' as Phase, target: 0, ready: false, mapReceived: false, elapsed: 0, error: '', editor: false });
    const [near, setNear] = useState<LocationPassage | null>(null);
    const publish = () => { const r = run.current; setView({ phase: r.phase, target: r.target, ready: r.ready, mapReceived: r.mapReceived, elapsed: Math.max(0, performance.now() - r.since), error: r.error, editor: r.editor }); };
    const clearMotion = () => {
        const o = opts.current, e = o.engine.current;
        e.held = [];
        e.path = [];
        e.ptarget = null;
        e.pvx = 0;
        e.pvy = 0;
        e.strikeHeld = false;
        e.blocking = false;
        o.moving.current.moving = false;
    };
    const finish = () => { run.current.phase = 'arrive'; run.current.since = performance.now(); publish(); };
    const begin = useCallback(() => {
        const o = opts.current, p = prompt.current, e = o.engine.current;
        if (!p || o.settings.current.controlled!=='main' || run.current.phase !== 'idle' || o.editorOpen.current || o.settings.current.arrow.battleMode || e.leap || e.blocking || !o.net.current?.ready)
            return;
        o.cancelInputs();
        clearMotion();
        const foot = o.foot(), map = o.map();
        const dir = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[p.direction];
        const cx = p.x + p.w / 2 + dir[0] * Math.min(.35, p.w / 4), cy = p.y + p.h / 2 + dir[1] * Math.min(.35, p.h / 4), dx = cx - (e.fx + foot.dx), dy = cy - (e.fy + foot.dy);
        // A few short steps towards the passage centre, never a long forced route.
        const length = Math.hypot(dx * o.settings.current.field.cellW, dy * o.settings.current.field.cellH), scale = length > 100 ? 100 / length : 1;
        run.current = { ...freshRun(), phase: 'walk', since: performance.now(), target: p.targetId, passage: p,
            start: { x: e.fx, y: e.fy }, end: { x: e.fx + dx * scale, y: e.fy + dy * scale } };
        suppress.current = { map: map.place?.id ?? 1, untilOutside: true };
        publish();
    }, []);
    const onField = useCallback((map: TestMap, list?: LocationPlace[]) => {
        const o = opts.current, current = map.place ?? defaultPlace();
        setPlace(current);
        setNear(null);prompt.current=null;
        if (list)
            setPlaces(list);
        if (o.enabled) {
            const url = new URL(window.location.href);
            url.searchParams.set('room', locationRoom(current.id));
            window.history.replaceState(window.history.state, '', url);
        }
        const r = run.current;
        if (r.phase === 'loading' && current.id === r.target) {
            r.mapReceived = true;
            o.cancelInputs();clearMotion();
            const e = o.engine.current, f = o.foot();
            e.leap = null;
            e.leapZ = 0;
            e.liftV = o.support(e.fx + f.dx, e.fy + f.dy);
        }
    }, []);
    const onCatalogue = useCallback((list: LocationPlace[]) => { setPlaces(list); setPlace(previous => list.find(p => p.id === previous.id) ?? previous); }, []);
    const onDisconnect=useCallback(()=>{
        const r=run.current;if(r.phase==='idle')return;
        if(!r.mapReceived){run.current={...freshRun(),error:'Связь прервалась. Переход отменён — попробуйте после подключения.'};opts.current.cancelInputs();clearMotion();}
        else{r.ready=false;r.error='Связь прервалась — переподключаемся к локации…';}
        publish();
    },[]);
    const onInfo = useCallback((text: string) => {
        if (!text.startsWith('Переход:') || run.current.phase === 'idle')
            return;
        run.current = { ...freshRun(), error: text };
        clearMotion();
        publish();
    }, []);
    const switchEditor = useCallback((id: number) => {
        const o = opts.current;
        if (!o.net.current?.ready || id === (o.map().place?.id ?? 1))
            return;
        if (o.editor.current?.dirty && !window.confirm('В локации есть несохранённые изменения. Переключиться без их сохранения?'))
            return;
        o.closeEditor();
        o.cancelInputs();
        clearMotion();
        run.current = { ...freshRun(), phase: 'loading', since: performance.now(), target: id, editor: true };
        publish();
    }, []);
    const tick = useCallback((now: number, dt: number) => {
        const r = run.current, o = opts.current;
        if (!o.enabled || r.phase === 'idle')
            return false;
        const e = o.engine.current;
        clearMotion();
        if (r.phase === 'walk') {
            const t = Math.min(1, (now - r.since) / 850), ease = t * t * (3 - 2 * t);
            const x = r.start.x + (r.end.x - r.start.x) * ease, y = r.start.y + (r.end.y - r.start.y) * ease;
            const f = o.foot(), allowed = o.walkable(x + f.dx, y + f.dy);
            const dx = allowed ? x - e.fx : 0, dy = allowed ? y - e.fy : 0;
            if (allowed) {
                e.fx = x;
                e.fy = y;
            }
            o.moving.current.moving = Math.hypot(dx, dy) > .00001;
            const screenDx=dx*o.settings.current.field.cellW*Math.cos(o.yaw())-dy*o.settings.current.field.cellH*Math.sin(o.yaw());
            if(Math.abs(screenDx)>.01)e.face=screenDx>0?-1:1;
            o.net.current?.emit('freemove', { x: e.fx, y: e.fy, foot: o.foot(), stop: t === 1 });
            if (t === 1) {
                r.phase = 'fade';
                r.since = now;
                publish();
            }
        }
        else if (r.phase === 'fade' && now - r.since >= 450) {
            r.phase = 'loading';
            r.since = now;
            publish();
            o.net.current?.travel(r.passage!.id);
        }
        else if (r.phase === 'loading') {
            if (r.editor && !r.sent && now - r.since >= 1100) {
                r.sent = true;
                const s = o.settings.current;
                o.net.current?.joinRoom({ room: locationRoom(r.target), sprite: s.character.sprite, size: s.character.spriteScale });
            }
            r.ready = r.mapReceived && !!o.net.current?.ready && o.ready();
            if (r.ready && (r.editor || now - r.since >= LOAD_MIN_MS))
                finish();
            else if (now - r.since > 30000 && !r.ready)
                r.error = 'Загрузка затянулась. Проверяем связь и данные карты…';
        }
        else if (r.phase === 'arrive' && now - r.since >= 500) {
            const edit = r.editor;
            run.current = freshRun();
            publish();
            if (edit)
                o.openEditor();
        }
        return r.phase === 'walk' || r.phase === 'fade' || r.phase === 'loading' && !r.mapReceived;
    }, []);
    useEffect(() => {
        if (!options.enabled)
            return;
        const poll = () => {
            const o = opts.current, r = run.current, map = o.map(), e = o.engine.current, f = o.foot();
            if (r.phase !== 'idle') {
                publish();
                return;
            }
            const candidate = o.settings.current.controlled==='main' && !o.editorOpen.current && !o.settings.current.arrow.battleMode && !e.leap && !e.blocking
                ? (map.passages ?? []).find(p => passageContains(p, e.fx + f.dx, e.fy + f.dy)) ?? null : null;
            if (suppress.current.untilOutside) {
                if ((map.place?.id ?? 1) !== suppress.current.map || !candidate)
                    suppress.current.untilOutside = false;
                else
                    return;
            }
            prompt.current = candidate;
            setNear(prev => prev === candidate ? prev : candidate);
        };
        const timer = window.setInterval(poll, 150);
        const key = (ev: KeyboardEvent) => {
            if (textInput(ev.target))
                return;
            const r = run.current;
            if (r.phase !== 'idle') {
                if (ev.code === 'KeyE' && !ev.repeat && r.phase === 'loading' && r.ready)
                    finish();
                if (ev.code === 'KeyE' || !ev.ctrlKey && !ev.metaKey) {
                    ev.preventDefault();
                    ev.stopImmediatePropagation();
                }
                return;
            }
            if (ev.code === 'KeyE' && !ev.repeat && !opts.current.editorOpen.current && prompt.current) {
                ev.preventDefault();
                ev.stopImmediatePropagation();
                begin();
            }
        };
        window.addEventListener('keydown', key, true);
        return () => { window.clearInterval(timer); window.removeEventListener('keydown', key, true); };
    }, [options.enabled, begin]);
    const destination = places.find(p => p.id === (view.phase === 'idle' ? near?.targetId : view.target));
    return { place, places, view, near, destination, begin, onField, onInfo, onCatalogue, onDisconnect, switchEditor, tick };
}
export type WorldLocations = ReturnType<typeof useWorldLocations>;
export function WorldLocationOverlay({ world, editorOpen }: {
    world: WorldLocations;
    editorOpen: boolean;
}) {
    const { view, place, near, destination } = world;
    const busy = view.phase !== 'idle';
    return <>
    {!editorOpen && <div className={styles.location} aria-label="Текущая локация">{place.zoneName.toLocaleUpperCase('ru-RU')} — {place.name}</div>}
    {!editorOpen && !busy && near && <div className={styles.prompt} role="region" aria-label="Переход в локацию">
      <span className={styles.sign} aria-hidden>♧</span><strong>Путь в «{destination?.name ?? `Локация ${near.targetId}`}»</strong>
      <span>{destination?.zoneName ?? 'Неизвестная зона'}</span><button type="button" onClick={world.begin}><kbd>E</kbd> Перейти</button>
    </div>}
    {!busy && view.error && <div className={styles.notice} role="alert">{view.error}</div>}
    {busy && createPortal(<div className={styles.lock} data-phase={view.phase} role="status" aria-live="polite" aria-label={view.phase === 'walk' ? 'Идём в проход' : 'Переход между локациями'}>
      {view.phase === 'loading' && (
        <LocationLoadingPanel
          title={`Переход в «${destination?.name ?? `Локация ${view.target}`}»…`}
          subtitle={destination?.zoneName ?? ''}
          progress={view.ready ? 100 : view.mapReceived ? 60 : 10}
          detail={view.ready ? 'Локация готова' : view.error || (view.mapReceived ? 'Подготавливаем карту и изображения…' : 'Получаем данные локации…')}
          countdown={!view.editor ? (
            <span className={styles.countdown}>
              Переход автоматически через {Math.max(0, Math.ceil((LOAD_MIN_MS - view.elapsed) / 1000))} с — когда карта будет готова
            </span>
          ) : null}
          actions={
            <>
              {view.ready ? (
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }))}
                >
                  <kbd>E</kbd> Продолжить сейчас
                </button>
              ) : null}
              {view.elapsed > 30000 && !view.ready ? (
                <button type="button" onClick={() => window.location.reload()}>Перезагрузить локацию</button>
              ) : null}
            </>
          }
        />
      )}
    </div>,document.body)}
  </>;
}
type EditorProps = {
    draft: EditorDraft;
    places: LocationPlace[];
    change: (fn: (d: EditorDraft) => void) => void;
    sync: () => void;
    switchLocation: (id: number) => void;
};
export function LocationEditorPanel({ draft, places, change, switchLocation }: EditorProps) {
    const p = draft.place ?? defaultPlace(), [name, setName] = useState(p.name), [next, setNext] = useState(String(p.id));
    useEffect(() => { setName(p.name); setNext(String(p.id)); }, [p.id, p.name]);
    const nextIdHint = places.reduce((max, loc) => Math.max(max, loc.id), 0) + 1;
    return <div className={editorStyles.zoneList}>
    <h3>Локация мира · ID {p.id}</h3>
    <label className={editorStyles.field}>Название локации<input aria-label="Название локации" maxLength={64} value={name} onChange={e => setName(e.target.value)}/></label>
    <Button onClick={() => { if (name.trim())
        change(d => { d.place = { ...p, name: name.trim() }; }); }}>Задать название локации</Button>
    <p className={editorStyles.hint}>Зона: {p.zoneName} · ID {p.zoneId}. Название записывается вместе с сохранением локации.</p>
    <label className={editorStyles.field}>Переключиться на другую локацию<Dropdown aria-label="Другая локация" value={next} onChange={setNext} options={places.map(l => ({ value: String(l.id), label: `${l.name} · ID ${l.id}` }))}/></label>
    <Button onClick={() => switchLocation(Number(next))} disabled={Number(next) === p.id}>Открыть локацию в редакторе</Button>
    <LocationCreatePanel nextIdHint={nextIdHint} onCreated={switchLocation}/>
  </div>;
}
export function PassageEditorPanel({ draft, places, change, sync }: EditorProps) {
    const current = draft.place?.id ?? 1, brush = draft.passageBrush ?? { w: 1, h: 1, targetId: current === 1 ? 2 : 1, link: '', direction: 'right' as const };
    const update = (patch: Partial<typeof brush>) => { draft.passageBrush = { ...brush, ...patch }; sync(); };
    return <>
    <h3>Область перехода</h3>
    <label className={editorStyles.field}>Куда · ID локации<Dropdown aria-label="Целевая локация перехода" value={String(brush.targetId)} onChange={v => update({ targetId: Number(v) })} options={places.filter(p => p.id !== current).map(p => ({ value: String(p.id), label: `ID ${p.id} — ${p.name}` }))}/></label>
    <div className={editorStyles.two}>{(['w', 'h'] as const).map((key, i) => <label key={key} className={editorStyles.field}>{i ? 'Длина области' : 'Ширина области'}<input type="number" aria-label={i ? 'Длина области' : 'Ширина области'} min="0.1" max={i ? draft.rows : draft.cols} step="0.1" value={brush[key]} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= .1)
        update({ [key]: Math.min(n, i ? draft.rows : draft.cols) }); }}/></label>)}</div>
    <label className={editorStyles.field}>Ключ связи<input aria-label="Ключ связи перехода" maxLength={32} placeholder="Например: лесная-тропа (латиницей)" value={brush.link} onChange={e => { if (/^[a-zA-Z0-9_-]*$/.test(e.target.value))
        update({ link: e.target.value }); }}/></label>
    <label className={editorStyles.field}>Направление прохода<Dropdown aria-label="Направление прохода" value={brush.direction} onChange={v => update({ direction: v as LocationPassage['direction'] })} options={[{ value: 'left', label: 'Влево' }, { value: 'right', label: 'Вправо' }, { value: 'up', label: 'Вверх' }, { value: 'down', label: 'Вниз' }]}/></label>
    <p className={editorStyles.hint}>Переход работает только в мирном режиме. Клик по карте ставит область. ПКМ удаляет область под курсором. Если проходов между двумя локациями несколько, задайте каждой паре одинаковый уникальный ключ связи. Обратные переходы не создаются автоматически.</p>
    <h3>Переходы · {draft.passages?.length ?? 0}</h3>
    {(draft.passages ?? []).map(p => <div key={p.id} className={editorStyles.zone}>
      <span>→ {places.find(l => l.id === p.targetId)?.name ?? p.targetId} · ID {p.targetId}<small className={editorStyles.hint}> {p.link || 'Без ключа'} · {p.w}×{p.h}</small></span>
      <button type="button" aria-label={`Удалить переход ${p.id}`} onClick={() => change(d => { d.passages = d.passages?.filter(q => q.id !== p.id); })}>×</button>
    </div>)}
  </>;
}

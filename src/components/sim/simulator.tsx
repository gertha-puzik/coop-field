'use client';
/**
 * Simulator — единственный компонент движка: канвас-сцена, сетевой контекст,
 * панели и JSX. Пояс чистых функций (строки 1–1361 прежней нумерации) выехал
 * волной W5a (этап 1) в src/lib/sim/{engine-consts, particles, editor-model,
 * paint, combat-log, geometry, targeting} и вернулся импортом — behavior-
 * preserving; карта поясов — docs/ARCHITECTURE.md §2.
 * W5b (этап 2) продолжил карвинг: HUD-циферблат уехал в ./simulator/hud-canvas,
 * типы и remote-draw-хелперы — в ./simulator/sim-model, клавиатура/сеть/слои
 * канваса — в ./simulator/hooks/*, JSX-блоки — в ./simulator/components/*
 * (карта — docs/ARCHITECTURE.md §2). Здесь остались: главный rAF-цикл и его
 * стейт-пояс, редакторы-обработчики мыши, патчи настроек и JSX-каркас.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Button } from '@/components/ui/button';
import { EntryScreen } from './entry-screen';
import { RoomPicker, type RoomRow } from './room-picker';
import { SettingsPanel } from './settings-panel';
import type { DirectionWindow, DummyConfig, SlowdownTier, SimSettings, SpriteId, StrikeZone, WindowKey } from '@/lib/sim/settings';
import {
  ARROW_ANCHOR_F,
  ARROW_TIP_SHADE,
  CAM_USER_ZOOM_MAX,
  CAM_USER_ZOOM_MIN,
  CAM_USER_ZOOM_STEP,
  CAMERA_TAU_MS,
  CAMZOOM_TAU_MS,
  DUMMY_DEFAULT,
  DUMMY_EMIT_MS,
  DUMMY_ID,
  DUMMY_SCALE,
  FIELD_MAX_UPSCALE,
  FREE_EMIT_MS,
  NET_ROLLBACK_LOCK_MS,
  OCCLUDE_ALPHA,
  OCCLUDE_COVER,
  PEACE_BATTLE_LEAN_Y,
  PEACE_SPEED_DEFAULT,
  PEACE_STUCK_MS,
  PEACE_TILT,
  PEACE_ZOOM,
  RAB_ID,
  RAB_POS,
  RAB_SCALE,
  round2,
  shadeHex,
  SPRINT_MULT,
  SPENT_COLOR,
  STORAGE_KEY,
} from '@/lib/sim/engine-consts';
import {
  anchorAtPx,
  anchorOf,
  coveredRatio,
  entrySide,
  nearestEntryCell,
  peaceBodyRadius,
  peaceHalfBox,
  type PxRect,
  rr,
  spriteBoxOf,
} from '@/lib/sim/geometry';
import {
  CHAT_W,
  clampLayout,
  COMBAT_KEY,
  type CombatLogEntry,
  type CombatState,
  type Layout,
  defaultCombat,
  formatLogLine,
  loadCombat,
  loadLayout,
  LOG_W,
  logActor,
  mergeLog,
  saveLayout,
} from '@/lib/sim/combat-log';
import { SPRINT_GRAVITY, SPRINT_SPAWN_MS, spawnSprintPart, type SprintPart } from '@/lib/sim/particles';
import {
  copyPaintCanvas,
  encodeDraftPaint,
  ensureDraftPaint,
  PAINT_MATS,
  pushPaintUndo,
  stampPaintBrush,
  undoPaintStroke,
} from '@/lib/sim/paint';
import {
  EDITOR_PASS_KEY,
  type EditorDraft,
  type EditorPlace,
  type EditorTool,
  type PaintBrushShape,
} from '@/lib/sim/editor-model';
import {
  dummiesOf,
  dummyIsDrawn,
  isBlockedCell,
  othersOf,
  pickStrikeTarget,
  pruneRemoteEnergy,
  strikeResponseMs,
  strikeTargetDrawn,
  type CharRef,
} from '@/lib/sim/targeting';
import { ROOMS, catToDummy, createCoopClient, nameFromUrl, roomFromUrl, roomTitle, type CoopAtmo, type CoopAtmoAnchor, type CoopChatMessage, type CoopDummyPos, type CoopFight, type CoopRoomInfo } from '@/lib/net/coop';
import {
  applyOwnMoveAck,
  rejectOwnMove,
  seedRemoteDraw,
  type RemoteDraw,
} from '@/lib/net/move-book';
import { FightLog } from './fight-log';
import { RoomChat } from './room-chat';
import { ThemeBackdrop } from './theme-backdrop';
import { applyTheme, FIELD_PRESETS, fieldPaletteOf, loadTheme, THEMES, type ThemeId } from '@/lib/sim/theme';
import { createRemoteAim, noteRemoteAim, stepRemoteAim, type RemoteAim } from '@/lib/sim/remote-aim';
import { keyAction } from '@/lib/sim/keys';
import {
  currentTestMap,
  drawDirtPatch,
  drawEntryCheck,
  drawEntryMark,
  drawGroundCover,
  drawTerrainTop,
  drawTerrainWall,
  drawTestDecorItem,
  drawTestObject,
  elevAny,
  elevLevelAt,
  elevLiftAtPoint,
  groundPointAtWorld,
  hashStr,
  nearestWalkableCell,
  peaceDepthScale,
  ensurePaintDecoded,
  paintCanvas,
  paintCellCoverage,
  paintPointOn,
  paintReady,
  PAINT_CELL_H,
  PAINT_CELL_W,
  setPaintOverride,
  setTestMap,
  TERRAIN_LIFT_PX,
  terrainWallBottomY,
  testBattleRouteBlocked,
  testClippedCells,
  testEntryAt,
  testEntryStrict,
  testFieldGeometry,
  testObstacleBodies,
  testObjects,
  testObjectAt,
  testObjectDrawRect,
  testPeaceBattleBlocked,
  testPeaceBattleDepth,
  testPeaceObjectsFree,
  testPeacePointFree,
  testPointInCellsZone,
  testPointInIsland,
  testWalkableCell,
} from '@/lib/sim/test-field';
import { coverPattern, grassPattern } from '@/lib/sim/textures';
import {
  entryDirDelta,
  newObjectId,
  newZoneId,
  objectBase,
  objectPosOffset,
  objectMir,
  objectRotDeg,
  objectScale,
  objectSprite,
  obstacleBodyPx,
  GROUND_COVER_OPTS,
  mapHasPaint,
  PAINT_MAX_BASE64,
  paintFormatError,
  OBJECT_ROT_STEP,
  OBJECT_SCALE_MAX,
  OBJECT_SCALE_MIN,
  ROCK_SPRITE_OPTS,
  TERRAIN_MAX_LEVEL,
  TREE_SPRITE_OPTS,
  sanitizeTestMap,
  TEST_MAP_DEFAULT,
  TEST_MAP_LIMITS,
  testMapConnectivityError,
  type GroundCover,
  type TestMap,
  type TestMapEntryDir,
  type TestMapObject,
  type TestMapSpawn,
  type TestMapZone,
  type TestMapZoneKind,
} from '@/lib/sim/test-map';
import {
  DEFAULT_SETTINGS,
  DAYPARTS,
  DIRECTIONS,
  DUMMY_DEFAULT_SPRITE,
  DUMMY_NAME,
  FIELD_SPRITES,
  RAB_SPRITE,
  SPRITES,
  WEATHERS,
  bfsPath,
  cycleStartFor,
  dayPartOfProgress,
  dayProgressAt,
  damageLevelLabel,
  dirByDeg,
  GAME_CREDITS,
  inWindow,
  mergeSettings,
  rayBox,
  resolveZonePixel,
  slowdownFor,
  speedFor,
  stepDuration,
  throatDamageFor,
  tierColor,
  wrap180,
  wrap360,
  type DayPart,
  type WeatherKind,
} from '@/lib/sim/settings';
import { drawFieldHud } from './simulator/hud-canvas';
import { fmtSec, rememberRemoteCell, stepRemoteDraws, type AtmosphereLike, type AtmoClock, type Engine } from './simulator/sim-model';


/**
 * Вертикальный разделитель между колонками: тянется мышью, меняя ширину
 * соседней панели. Сам ничего не хранит — отдаёт дельту dx родителю.
 */
function ColResize({ onDrag, onEnd }: { onDrag: (dx: number) => void; onEnd: () => void }) {
  const last = useRef(0);
  const dragging = useRef(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Потяните, чтобы изменить ширину панели"
      title="Потяните, чтобы изменить ширину"
      onPointerDown={(ev) => {
        ev.preventDefault();
        ev.currentTarget.setPointerCapture(ev.pointerId);
        last.current = ev.clientX;
        dragging.current = true;
      }}
      onPointerMove={(ev) => {
        if (!dragging.current || !(ev.buttons & 1)) return;
        onDrag(ev.clientX - last.current);
        last.current = ev.clientX;
      }}
      onPointerUp={(ev) => {
        if (!dragging.current) return;
        dragging.current = false;
        try {
          ev.currentTarget.releasePointerCapture(ev.pointerId);
        } catch {}
        onEnd();
      }}
      onPointerCancel={() => {
        dragging.current = false;
        onEnd();
      }}
      className="hidden w-1.5 shrink-0 cursor-col-resize touch-none rounded bg-[var(--sim-divider)] transition-colors hover:bg-[var(--sim-accent-soft)] active:bg-[var(--sim-accent-soft)] lg:block"
    />
  );
}


export default function Simulator() {
  const [settings, setSettings] = useState<SimSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  /** Экран: вход (кот + скрытые параметры + выбор комнаты) → поле. */
  const [stage, setStage] = useState<'entry' | 'field'>('entry');
  /** Сеть поднята с самого входа: сокет слушает состав комнат, join уходит
   *  только по выбору комнаты. Смена entry↔field сокет не пересоздаёт. */
  const [netStarted, setNetStarted] = useState(true);
  /** Клавиатура поля активна только на stage «field» (см. обработчики keydown). */
  const enteredRef = useRef(false);
  const pendingJoinRef = useRef<{ room: string; login: string; sprite: SpriteId; scale: number } | null>(null);
  /** Состав комнат для выбора (roomsinfo). null — данных ещё не было. */
  const [roomsRows, setRoomsRows] = useState<CoopRoomInfo[] | null>(null);
  /** roomsinfo не приходит дольше 5 с (старый сервер без протокола) — предупреждение в карточках. */
  const [roomsStale, setRoomsStale] = useState(false);
  /** Модалка «Перейти в другую комнату» поверх поля. */
  const [switchOpen, setSwitchOpen] = useState(false);
  const [combat, setCombat] = useState<CombatState>(() => defaultCombat(100));
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const combatRef = useRef(combat);
  useEffect(() => {
    combatRef.current = combat;
  }, [combat]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Рамка поля: по ней канвас вписывается в оставшееся место, без внутреннего скролла. */
  const fieldFrameRef = useRef<HTMLDivElement | null>(null);
  const [fieldFit, setFieldFit] = useState<{ w: number; h: number } | null>(null);
  /** Ширины чата и лога ударов; меняются перетаскиванием разделителей и запоминаются. */
  const [layout, setLayout] = useState<Layout>(() => ({ chatW: CHAT_W.def, logW: LOG_W.def }));
  const layoutRef = useRef(layout);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);
  useEffect(() => {
    const saved = loadLayout();
    setLayout(saved);
    layoutRef.current = saved;
  }, []);
  /** Панель настроек теперь выдвижная: не отдаёт поле постоянной колонке. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Формат поля комнаты: «test» — лужайка/переход/закуток с камерой и свободной ходьбой. */
  const [fieldFormat, setFieldFormat] = useState<'grid' | 'test'>('grid');
  const fieldFormatRef = useRef<'grid' | 'test'>('grid');
  /** Плавная камера «теста»: центр взгляда в px мира; init — встать на игрока без анимации. */
  const camRef = useRef({ x: 0, y: 0, init: false });
  /** Зум/наклон/глубина камеры «теста»: z — зум, sq — сжатие земли по вертикали,
   *  dp — сила перспективы (масштаб спрайтов по глубине: 0 — бой, 1 — мирный режим). */
  const camFxRef = useRef({ z: 1, sq: 1, dp: 0 });
  /** Зум колесом мыши — множитель поверх базового зума вида (1 — как задано режимом).
   *  Меняется колесом над полем «теста», сам плавно догоняется камерой (kz). */
  const camUserZoomRef = useRef(1);
  /** Shift зажат — спринт мирного режима: скорость ×2 и частицы из-под лап. */
  const sprintRef = useRef(false);
  /** Копилка темпа спавна частиц спринта (мс бега с прошлого комочка). */
  const sprintAccRef = useRef(0);
  /** Живые частицы спринта: обновляет игровой цикл, рисует секция грунта. */
  const sprintPartsRef = useRef<SprintPart[]>([]);
  /** Редактор локации: открыт/закрыт (ref — для игрового цикла и обработчиков мыши). */
  const [editorOpen, setEditorOpen] = useState(false);
  const editorOpenRef = useRef(false);
  useEffect(() => {
    editorOpenRef.current = editorOpen;
  }, [editorOpen]);
  /** Черновик редактора и его зеркальный снапшот для панели (перерисовка по React). */
  const editorRef = useRef<EditorDraft | null>(null);
  const [editorView, setEditorView] = useState<EditorDraft | null>(null);
  /** Пароль редактора: хранится в localStorage, подставляется при открытии. */
  const [editorPass, setEditorPass] = useState('');
  /** Вариант спрайта при постановке: последнее выбранное дерево и камень. */
  const lastSprRef = useRef<{ tree: string; stone: string }>({ tree: 'tree-1', stone: 'rock-1' });
  /** Вариант покрытия земли при покраске (инструмент «Покрытие»). */
  const [editorCover, setEditorCover] = useState<GroundCover>('flower-1');
  const editorCoverRef = useRef<GroundCover>('flower-1');
  useEffect(() => {
    editorCoverRef.current = editorCover;
  }, [editorCover]);
  /** Ставящийся объект («призрак»): ref — источник истины для кадра (позиция
   *  меняется каждым движением мыши), state — зеркало для панели редактора. */
  const [editorPlace, setEditorPlace] = useState<EditorPlace | null>(null);
  const editorPlaceRef = useRef<EditorPlace | null>(null);
  /** Правка и зеркалирование ставящегося объекта: одним входом, чтобы ref и state не разъехались. */
  const patchEditorPlace = (p: Partial<EditorPlace>) => {
    const next = { ...(editorPlaceRef.current ?? { kind: 'tree', spr: 'tree-1', s: 1, rot: 0, mir: 0, x: 0, y: 0, anchored: false, pickId: null }), ...p } as EditorPlace;
    editorPlaceRef.current = next;
    setEditorPlace(next);
  };
  /** Направление шага для нового захода (инструмент «Заход»): куда игрока
   *  перенесёт шаг в боевом режиме — туда же рисуется градиент от боевой клетки. */
  const [editorEntryDir, setEditorEntryDir] = useState<TestMapEntryDir>('right');
  const editorEntryDirRef = useRef<TestMapEntryDir>('right');
  useEffect(() => {
    editorEntryDirRef.current = editorEntryDir;
  }, [editorEntryDir]);
  /** Строка состояния редактора: ошибка проверки / «Сохраняем…» / «Сохранено». */
  const [editorMsg, setEditorMsg] = useState<string | null>(null);
  /** Табличка «Загрузка локации»: на время применения нового конфига локации
   *  (сохранение в редакторе, вход/переподключение) — игроки видят, что поле
   *  обновляется, а не «игра сломалась». */
  const [mapLoading, setMapLoading] = useState(false);
  const mapLoadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showMapLoading = useCallback(() => {
    setMapLoading(true);
    if (mapLoadingTimerRef.current) clearTimeout(mapLoadingTimerRef.current);
    mapLoadingTimerRef.current = setTimeout(() => setMapLoading(false), 1500);
  }, []);
  useEffect(
    () => () => {
      if (mapLoadingTimerRef.current) clearTimeout(mapLoadingTimerRef.current);
    },
    [],
  );
  /** Последняя локация, подтверждённая сервером: к ней откатывается поле и черновик. */
  const savedMapRef = useRef<TestMap>(TEST_MAP_DEFAULT);
  /** Темп рассылки freemove и флаг «сейчас идём» (для финального стоп-пакета). */
  const freeSyncRef = useRef({ at: 0, moving: false });
  /** Был ли центр модельки внутри боевой зоны на прошлом кадре. Переключение
   *  режима срабатывает на входе в зону (край, а не «пока внутри») — иначе
   *  вышедший из зоны мирным шагом кот тут же возвращался бы в бой. */
  const inZonePrevRef = useRef(true);
  /** Признак «только что вошли в комнату»: 'you' отмечает вход/переподключение,
   *  по первому field после него гасим боевой режим (свежий вход — мирный спавн).
   *  field после сохранения локации приходит без you — флаг уже снят, и бой
   *  у игроков не выключается при каждой правке локации. */
  const freshJoinRef = useRef(true);
  /** Клетка захода, с которой включаем бой: переход в бой привязывает кота к ней
   *  (а не к ближайшей боевой клетке) и уходит в cellsync серверу. */
  const battleEntryRef = useRef<{ c: number; r: number } | null>(null);
  /** Клетка захода для выхода из боя кнопкой: на боевой клетке выключение боя
   *  телепортирует кота на заход (тот же проход, через который вошли). */
  const battleExitRef = useRef<{ c: number; r: number } | null>(null);
  /** Заход, через который последний раз входили в зону, — туда же возвращает выход. */
  const entryAnchorRef = useRef<{ c: number; r: number } | null>(null);
  /** Подсказка над полем: почему бой не включился / что сделал выход из боя. */
  const [battleHint, setBattleHint] = useState<string | null>(null);
  const battleHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Чужие коты в свободной ходьбе (комната «тест»): экранная позиция и цель доведения,
   *  face — куда смотрит моделька (флип по горизонтали их бега), jpUntil — докуда
   *  рисовать дугу прыжка (jp во freemove). */
  const remoteFreeRef = useRef(
    new Map<string, { x: number; y: number; tx: number; ty: number; sp?: boolean; face?: 1 | -1; jpUntil?: number }>(),
  );
  /** Режим чужих котов «теста» по сети (поле fm из publicCat): 1 — мирный (стрела
   *  и проценты не рисуются), 0 — боевой. Раньше чужие стрелы рисовались всегда —
   *  отсюда «багованные» стрелы над мирными котами у соседей. */
  const remoteFmRef = useRef(new Map<string, number>());
  /** Тема оформления: ночь / светлая / пивная. Цвета — CSS-переменные (globals.css). */
  const [theme, setTheme] = useState<ThemeId>('night');
  useEffect(() => {
    setTheme(loadTheme());
  }, []);
  const spritesRef = useRef<Partial<Record<SpriteId, HTMLImageElement>>>({});
  /** Белые силуэты спрайтов: тонкая обводка своего кота. */
  const whiteSpritesRef = useRef<Partial<Record<SpriteId, HTMLCanvasElement>>>({});
  const netRef = useRef<ReturnType<typeof createCoopClient> | null>(null);
  /** Атмосфера комнаты: время суток + погода. Общая для всех (состояние на сервере). */
  const [atmoState, setAtmoState] = useState<CoopAtmo>({ dp: 'day', w: 'sun' });
  const atmoStateRef = useRef<CoopAtmo>(atmoState);
  /** Часы атмосферы: якорь комнаты (сервер) или локальный — до первого якоря и без сети. */
  const atmoAnchorRef = useRef<AtmoClock>({ cs: 0, pl: 0, wl: 0, w: 'sun', ws: 0, srv: false });
  const atmoInitRef = useRef(false);
  /** Значок погоды на HUD: текущая, прежняя (для кроссфейда) и момент смены. */
  const hudWxRef = useRef<{ w: WeatherKind; prev: WeatherKind; at: number }>({ w: 'sun', prev: 'sun', at: 0 });
  /** Pixi-канвас поверх поля и его слой атмосферы (null — WebGL недоступен). */
  const pixiRef = useRef<HTMLCanvasElement | null>(null);
  /** HUD-канвас над слоем атмосферы: циферблат день/ночь + значок погоды. */
  const hudRef = useRef<HTMLCanvasElement | null>(null);
  const atmoRef = useRef<AtmosphereLike | null>(null);
  /** Прошлая позиция камеры — для сдвига теней облаков (лёгкий параллакс). */
  const camPrevRef = useRef<{ x: number; y: number } | null>(null);
  /** Курсор над полем в мировых координатах (с поправкой на подъём земли):
   *  прицел прыжка — конечная точка привязана к мышке, игрок сам выбирает
   *  дистанцию в пределах максимальной. */
  const cursorWorldRef = useRef<{ x: number; y: number } | null>(null);
  const meIdRef = useRef<number | null>(null);
  /**
   * Своя клетка на сервере и шаги, которые уже нарисовали, но ещё не подтвердили.
   * Кот шагает сразу, не дожидаясь RTT. Отказ («клетка занята» / «край поля»)
   * возвращает его на последнюю подтверждённую клетку.
   */
  const netMovesRef = useRef<{
    server: { col: number; row: number } | null;
    pending: { col: number; row: number }[];
  }>({ server: null, pending: [] });
  /** Живые соседи с сервера: если кто-то ещё в комнате — рисуем их, иначе локальные
   *  манекены. Всё в refs, не в модуле: два экземпляра Simulator не делят состояние. */
  const liveRemotesRef = useRef<DummyConfig[]>([]);
  /** Плавный угол чужой стрелы: d.angle — последний сетевой угол, на кадре рисуем display. */
  const remoteAimRef = useRef(new Map<string, RemoteAim>());
  /** Экранная дорисовка чужих клеток: за кадр не больше одного шага. */
  const remoteDrawRef = useRef(new Map<string, RemoteDraw>());
  /** Спрайт, который не удалось декодировать: кота всё равно рисуем заглушкой. */
  const brokenSpritesRef = useRef<Set<SpriteId>>(new Set());
  /**
   * Последний угол, уже ушедший в комнату. Пока стрела крутится или ползунок едет,
   * шлём aim примерно каждые 32 мс, если угол вообще изменился (порога в 2° нет).
   * На 60 Гц это каждый второй кадр (~33 мс, около 30/с), а не каждый третий:
   * порог 45 мс попадал только в кадр на 50 мс и давал ступеньку 3.75°.
   * Отпускание клавиши (force) уходит сразу. Пропущенный внутри окна угол
   * не теряется: его забирает короткий хвост, без setState.
   */
  const aimSyncRef = useRef<{
    deg: number | null;
    at: number;
    pending: number | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ deg: null, at: 0, pending: null, timer: null });
  const publishAimRef = useRef<(angle: number, force: boolean) => void>(() => {});
  // Присвоение — в эффекте, а не в теле рендера: мутация ref во время render —
  // антипаттерн React (конкурентный режим рендерит компонент повторно).
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
  const [roomCode, setRoomCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [netStatus, setNetStatus] = useState('подключение…');
  const [peerCount, setPeerCount] = useState(1);
  const [netReady, setNetReady] = useState(false);
  const [meId, setMeId] = useState<number | null>(null);
  /** Манекен «ПОЧУХАТЬ» включён в комнате (истина приходит с сервера, не из localStorage). */
  const [dummyOn, setDummyOn] = useState(false);
  /** Боевая мишень «РАБ» включена в комнате. */
  const [rabOn, setRabOn] = useState(false);
  /** Выбранный скин манекена (ушёл на сервер при включении, живёт в состоянии комнаты). */
  const [dummySprite, setDummySprite] = useState<SpriteId>(DUMMY_DEFAULT_SPRITE);
  const [chatLines, setChatLines] = useState<CoopChatMessage[]>([]);
  const startStepRef = useRef<((dir: number) => void) | null>(null);
  const doStrikeRef = useRef<(() => void) | null>(null);
  /** Где стоит свой кот, пока управление передано манекену (null — кот под управлением). */
  const mainSavedRef = useRef<{ col: number; row: number; angle: number } | null>(null);
  /** Перетаскивание манекена зажатой ЛКМ: кто тащится (id манекена), захват курсора
   *  и текущий px спрайта. */
  const dragRef = useRef<{
    key: string;
    grabDX: number;
    grabDY: number;
    x: number;
    y: number;
    w: number;
    h: number;
    lastX: number;
    lastY: number;
    lastT: number;
    moved: boolean;
  } | null>(null);
  /** «Желе»: амплитуда дрожи каждого манекена (0..1) — растёт от тряски мышью при
   *  перетаскивании, дальше качается и гаснет сама. */
  const jellyRef = useRef<Record<string, number>>({});
  /** Анимация удержания пробела (свой кот): пока держится — моделька плавно
   *  приплющивается вниз с нарастающей дрожью (полный эффект за 4 с), при
   *  отпускании — желейный «выстрел» вверх и пружинный возврат в норму.
   *  charge — заряд на момент отпускания (0.15 тап → 1 полные 4 с): амплитуда
   *  «выстрела» растёт вместе с приседом, короткое нажатие подбрасывает едва-едва. */
  const spaceHoldRef = useRef({ holding: false, since: 0, releaseAt: 0, charge: 0 });
  /** Позиция манекена в клеточных долях (левый верх спрайта); null — выключен. */
  const dummyPosRef = useRef<CoopDummyPos | null>(null);
  /** Манекен включён — зеркало для игрового цикла: state в замыкание кадра не попадает. */
  const dummyOnRef = useRef(false);
  /** Скин манекена — зеркало для кадра. */
  const dummySpriteRef = useRef<SpriteId>(DUMMY_DEFAULT_SPRITE);
  /** Кто сейчас тащит манекен (login) — курсор с именем видят все; null — никто. */
  const dummyGrabRef = useRef<string | null>(null);
  /** performance.now() последнего сетевого сдвига манекена — для скорости «желе». */
  const dummySeenRef = useRef(0);
  /** Темп рассылки dummyMove при перетаскивании. */
  const dummySyncRef = useRef<{ at: number }>({ at: 0 });
  /** Мишень РАБ включена — зеркало для игрового цикла. */
  const rabOnRef = useRef(false);
  /** Кто из чужих котов держит блок (их числовые id): любой удар по такому — в «Лапы»,
   *  кроме удара в хвост — хвост блок не ловит. */
  const remoteBlockRef = useRef<Set<number>>(new Set());
  /** Присед-желе на пробеле у чужих котов (ключи p<id>): Holding — держит пробел,
   *  releaseAt/charge — желейный «выстрел» после отпускания. Времена — в локальных
   *  часах, длительность удержания приходит в пакете отпускания (hold). */
  const remoteSpaceRef = useRef<Map<string, { holding: boolean; since: number; releaseAt: number; charge: number }>>(new Map());
  /** После перетаскивания один клик подавляется — чтобы не строился маршрут. */
  const skipClickRef = useRef(false);
  /** Идёт росчерк «Земли» протяжкой (редактор): клетки насыпаются на pointermove. */
  const dirtPaintingRef = useRef(false);
  /** Идёт мазок кисти локации (протяжка с зажатой кнопкой). */
  const paintStrokeRef = useRef(false);
  /** Запрос прыжка из обработчика клавиш: отпускание Пробела с зарядом.
   *  Игровой цикл забирает его раз в кадр (charge 0.15..1 — как у «выстрела»). */
  const leapRequestRef = useRef<number | null>(null);
  /** Росчерк кистей рельефа (редактор): тронутые клетки и уровень «Ровно». */
  const elevStrokeRef = useRef<{ touched: Set<string>; flat: number } | null>(null);
  const engineRef = useRef<Engine>({
    angle: 0,
    col: 4,
    row: 2,
    step: null,
    path: [],
    held: [],
    rot: 0,
    rotBase: 0,
    rotBaseT: 0,
    rotPeriod: 0,
    rotActive: 0,
    regenAcc: 0,
    lastStrike: 0,
    strikeHeld: false,
    nextHoldStrike: 0,
    /** Блок (удержание К): двигаться, бить и крутить стрелу нельзя; виден только самому. */
    blocking: false,
    labels: [],
    hover: null,
    lastSpeed: 100,
    lastDir: null,
    /** performance.now(), до которого новые шаги подавлены: пауза после отката
     *  предикта, чтобы перешаг не уходил в серверный кулдаун и не терялся. */
    moveLockUntil: 0,
    fx: 4,
    fy: 2,
    ptarget: null,
    pvx: 0,
    pvy: 0,
    // Спрайты котов смотрят влево «как нарисованы» (flip=1): покой и бег влево —
    // без зеркала, бег вправо — зеркалит (flip=-1).
    face: 1,
    lastSprint: 0,
    leap: null,
    leapZ: 0,
    liftV: 0,
  });

  /** Применить состояние манекена из комнаты: зеркала для кадра + React-состояние. */
  const applyDummy = useCallback((on: boolean, pos: CoopDummyPos | null, sprite?: SpriteId) => {
    dummyOnRef.current = on;
    dummyPosRef.current = on ? pos : null;
    setDummyOn(on);
    if (sprite) {
      dummySpriteRef.current = sprite;
      setDummySprite(sprite);
    }
  }, []);

  /** Применить состояние мишени РАБ из комнаты. */
  const applyRab = useCallback((on: boolean) => {
    rabOnRef.current = on;
    setRabOn(on);
  }, []);

  /** Клетки общих предметов комнаты (0-based): и РАБ, и ПОЧУХАТЬ непроходимы.
   *  Для ударов нужен только РАБ (манекен вне боя), поэтому раздельно. */
  const rabExtra = useCallback((): CharRef[] =>
    rabOnRef.current
      ? [{ id: RAB_ID, name: RAB_SPRITE.name, col: RAB_POS.col, row: RAB_POS.row, sprite: RAB_SPRITE.id, scale: RAB_SCALE }]
      : [],
    [],
  );
  const objectExtras = useCallback((): CharRef[] => {
    const out = rabExtra();
    if (dummyOnRef.current && dummyPosRef.current) {
      out.push({
        id: DUMMY_ID,
        name: DUMMY_NAME,
        col: Math.round(dummyPosRef.current.x),
        row: Math.round(dummyPosRef.current.y),
        sprite: dummySpriteRef.current,
        scale: DUMMY_SCALE,
      });
    }
    return out;
  }, [rabExtra]);

  /** Тумблер «Включить манекен»: локально optimistic, сервер рассылёт dummyState всей комнате. */
  const toggleDummy = useCallback(
    (on: boolean) => {
      const net = netRef.current;
      if (!net?.ready) return;
      applyDummy(on, on ? (dummyPosRef.current ?? { ...DUMMY_DEFAULT }) : null);
      net.emit('dummy', { on, sprite: dummySpriteRef.current });
    },
    [applyDummy],
  );

  /** Смена скина манекена в настройках: уходит в комнату, dummyState вернёт авторитетное состояние. */
  const changeDummySprite = useCallback((sprite: SpriteId) => {
    dummySpriteRef.current = sprite;
    setDummySprite(sprite);
    const net = netRef.current;
    if (net?.ready && dummyOnRef.current) net.emit('dummy', { on: true, sprite });
  }, []);

  /** Тумблер «Включить мишень» (РАБ): локально optimistic, сервер рассылёт rabState всей комнате. */
  const toggleRab = useCallback(
    (on: boolean) => {
      const net = netRef.current;
      if (!net?.ready) return;
      applyRab(on);
      net.emit('rab', { on });
    },
    [applyRab],
  );

  /* ---------- загрузка / сохранение настроек ---------- */

  useEffect(() => {
    let s = DEFAULT_SETTINGS;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      // разовая загрузка сохранённого конфига после монтирования (SSR-безопасно)
      if (raw) s = mergeSettings(JSON.parse(raw));
    } catch {
      /* игнорируем повреждённый конфиг */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(s);
    setCombat(loadCombat(s.combat.energyStart));
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* хранилище может быть недоступно */
    }
  }, [settings, loaded]);

  /* ---------- часы атмосферы ---------- */

  // Локальные часы цикла суток — стартовые и для поля без сети. В комнате их
  // перезадаст первый же якорь с сервера (снапшот field / событие atmo).
  useEffect(() => {
    if (!loaded || atmoInitRef.current) return;
    atmoInitRef.current = true;
    const now = Date.now();
    const a = settingsRef.current.atmo;
    const pl = Math.round(a.phaseMin * 60_000);
    const wl = Math.round(a.weatherMin * 60_000);
    atmoAnchorRef.current = { cs: cycleStartFor('day', pl, now), pl, wl, w: 'sun', ws: now, srv: false };
  }, [loaded]);

  /* Вход на боевые клетки — мгновенный: вид сверху (зум 1, без наклона и перспективы)
   * ставится сразу, поэтому стрела, сетка и проценты энергии появляются сразу, без
   * плавной анимации перехода. Обратный переход на траву остаётся плавным. */
  const battleOn = settings.arrow.battleMode;
  useEffect(() => {
    if (!battleOn) return;
    if (editorOpenRef.current) return; // в редакторе камера сама подстраивается
    camFxRef.current.z = camUserZoomRef.current;
    camFxRef.current.sq = 1;
    camFxRef.current.dp = 0;
  }, [battleOn]);

  /** Строка удара из комнаты пишется в тот же боевой лог. Урон цели тоже живёт здесь, не только у бьющего. */
  const applyNetFight = useCallback((fight: CoopFight) => {
    const me = meIdRef.current;
    const actor = fight.attackerId === me ? 'Я' : fight.attacker || 'Кот';
    const targetName = fight.targetId === me ? 'Я' : fight.name || 'кот';
    const zoneId = fight.zone || 'hit';
    const zoneLabel = fight.part || zoneId;
    const weapon = typeof fight.weapon === 'string' ? fight.weapon : '';
    const damage = Number(fight.damage);
    const dmg = Number.isFinite(damage) ? Math.max(0, damage) : 0;
    setCombat((prev) => {
      const es = Math.max(1, settingsRef.current.combat.energyStart);
      let playerEnergy = prev.playerEnergy;
      const de = pruneRemoteEnergy(prev.dummyEnergy, settingsRef.current, liveRemotesRef.current, rabOnRef.current ? [RAB_ID] : []);
      if (fight.attackerId === me) {
        playerEnergy = Math.max(0, playerEnergy - settingsRef.current.combat.strikeCost);
      }
      if (dmg > 0 && fight.targetId != null) {
        if (fight.targetId === me) playerEnergy = Math.max(0, playerEnergy - dmg);
        else {
          const key = `p${fight.targetId}`;
          de[key] = Math.max(0, (de[key] ?? es) - dmg);
        }
      }
      const entry: CombatLogEntry = {
        target: targetName,
        zoneId,
        zoneLabel,
        count: 1,
        // fight.damage — урон уже после блока и брони цели: ровно то,
        // сколько энергии цель потеряла этим ударом.
        dmg,
        actor,
        weapon,
      };
      return { playerEnergy, dummyEnergy: de, log: mergeLog(prev.log, entry) };
    });
    const e = engineRef.current;
    const s = settingsRef.current;
    const zone = s.combat.zones.find((z) => z.id === zoneId);
    const victim =
      fight.targetId === me
        ? { col: e.col, row: e.row }
        : liveRemotesRef.current.find((d) => d.id === `p${fight.targetId}`);
    if (!victim) return;
    e.labels.push({
      x: victim.col * s.field.cellW + s.field.cellW / 2,
      y: victim.row * s.field.cellH + s.field.cellH / 2 - s.field.cellH * 0.35,
      born: performance.now(),
      text: dmg > 0 ? `${zoneLabel} -${dmg}%` : zoneLabel,
      color: zone?.color || '#ffd60a',
    });
  }, []);

  /** Какие комнаты спрашивать у сервера: три грота + комната из ссылки, если она чужая. */
  const wantedRoomIds = useCallback((): string[] => {
    const ids: string[] = ROOMS.map((r) => r.id);
    const urlRoom = roomFromUrl();
    if (urlRoom && urlRoom !== 'demo' && !ids.includes(urlRoom)) ids.push(urlRoom);
    return ids;
  }, []);

  /* ---------- редактор локации «теста» ---------- */

  /** Применение конфига локации (с сервера или черновика редактора): setTestMap
   *  сбрасывает кэши — картинка и проверки ходьбы сразу считают новую локацию. */
  const applyTestMap = useCallback((map: TestMap) => {
    setTestMap(map);
    savedMapRef.current = map;
    // Пиксельная отрисовка чужого/нового конфига: декод асинхронный — как только
    // готов, кэши контура пересобираются и поле перерисовывается уже по рисунку.
    if (mapHasPaint(map)) void ensurePaintDecoded();
    const d = editorRef.current;
    if (d) {
      // Свой только что сохранённый конфиг возвращается рассылкой «map»:
      // черновик совпал с сохранённой локацией — метка «не сохранено» гаснет.
      const same =
        d.cols === map.cols &&
        d.rows === map.rows &&
        JSON.stringify(d.zones.map((z) => [z.name, z.kind, z.c0, z.r0, z.c1, z.r1])) ===
          JSON.stringify(map.zones.map((z) => [z.name, z.kind, z.c0, z.r0, z.c1, z.r1])) &&
        JSON.stringify(d.objects.map((o) => [o.kind, o.x ?? o.c, o.y ?? o.r, o.s ?? null, o.rot ?? null, o.spr ?? null, o.cv ?? null, o.mir ?? null])) ===
          JSON.stringify((map.objects ?? []).map((o) => [o.kind, o.x ?? o.c, o.y ?? o.r, o.s ?? null, o.rot ?? null, o.spr ?? null, o.cv ?? null, o.mir ?? null])) &&
        JSON.stringify(d.spawns.map((s) => [s.c, s.r])) ===
          JSON.stringify((map.spawns ?? []).map((s) => [s.c, s.r])) &&
        JSON.stringify(d.elev) === JSON.stringify(map.elev ?? {}) &&
        (d.pcv ? d.ppaint ?? '' : '') === (map.paint ?? '');
      if (same) {
        d.dirty = false;
        d.zones = map.zones.map((z) => ({ ...z }));
        d.objects = (map.objects ?? []).map((o) => ({ ...o }));
        d.spawns = (map.spawns ?? []).map((s) => ({ ...s }));
        d.elev = { ...(map.elev ?? {}) };
        setEditorView({ ...d, zones: d.zones.map((z) => ({ ...z })), objects: d.objects.map((o) => ({ ...o })), undo: [...d.undo] });
        return;
      }
    }
    if (d && !d.dirty) {
      d.zones = map.zones.map((z) => ({ ...z }));
      d.objects = (map.objects ?? []).map((o) => ({ ...o }));
      d.spawns = (map.spawns ?? []).map((s) => ({ ...s }));
      d.elev = { ...(map.elev ?? {}) };
      d.cols = map.cols;
      d.rows = map.rows;
      setEditorView({ ...d, zones: d.zones.map((z) => ({ ...z })), objects: d.objects.map((o) => ({ ...o })), undo: [...d.undo] });
    }
  }, []);

  const syncEditorView = () => {
    const d = editorRef.current;
    if (!d) return;
    setEditorView({ ...d, zones: d.zones.map((z) => ({ ...z })), objects: d.objects.map((o) => ({ ...o })), undo: [...d.undo] });
  };

  const draftMap = (d: EditorDraft): TestMap => ({
    // Правки редактора сохраняются в текущей версии конфига (v2 — деление поля
    // на траву и боевые клетки).
    v: 2,
    cols: d.cols,
    rows: d.rows,
    margin: savedMapRef.current.margin,
    seed: savedMapRef.current.seed,
    zones: d.zones.map((z) => ({ ...z })),
    objects: d.objects.map((o) => ({ ...o })),
    spawns: d.spawns.map((s) => ({ ...s })),
    ...(Object.keys(d.elev).length > 0 ? { elev: { ...d.elev } } : {}),
    // Кисть локации: холст черновика уходит в конфиг PNG base64. С рисунком
    // проталины/покрытия больше не нужны (запечены) — как в sanitize.
    ...(d.pcv ? { paint: encodeDraftPaint(d) } : {}),
  });

  /** Черновик сразу рисуется на поле (WYSIWYG): setTestMap пересобирает кэши.
   *  Холст кисти черновика подменяет декодированный рисунок: мазки видны сразу,
   *  без PNG-декодирования на каждый росчерк. */
  const applyDraftPreview = () => {
    const d = editorRef.current;
    if (!d) return;
    setTestMap(draftMap(d));
    if (d.pcv) setPaintOverride(d.pcv, true);
  };

  const pushEditorUndo = () => {
    const d = editorRef.current;
    if (!d) return;
    d.undo.push({ zones: d.zones.map((z) => ({ ...z })), objects: d.objects.map((o) => ({ ...o })), spawns: d.spawns.map((s) => ({ ...s })), elev: { ...d.elev }, cols: d.cols, rows: d.rows });
    if (d.undo.length > 40) d.undo.shift();
  };

  const openEditor = () => {
    const m = savedMapRef.current;
    const draft: EditorDraft = {
      zones: m.zones.map((z) => ({ ...z })),
      objects: (m.objects ?? []).map((o) => ({ ...o })),
      spawns: (m.spawns ?? []).map((s) => ({ ...s })),
      elev: { ...(m.elev ?? {}) },
      pcv: copyPaintCanvas(),
      pmat: 'grass-1',
      psize: 24,
      pshape: 'round',
      pundo: [],
      pdirty: false,
      ppaint: null,
      cols: m.cols,
      rows: m.rows,
      tool: 'cells',
      drag: null,
      undo: [],
      sel: [],
      dirty: false,
    };
    editorRef.current = draft;
    setEditorView({ ...draft, zones: draft.zones.map((z) => ({ ...z })), objects: draft.objects.map((o) => ({ ...o })), undo: [] });
    // Рисунок локации ещё декодируется (конфиг пришёл только что): как только
    // готов, черновик получает его копию — кисть правит сохранённый рисунок.
    if (mapHasPaint(m) && !draft.pcv) {
      void ensurePaintDecoded().then((ok2) => {
        const d = editorRef.current;
        if (!ok2 || !d || d.pcv || d.pdirty) return;
        d.pcv = copyPaintCanvas();
        if (d.pcv) setPaintOverride(d.pcv, true);
        syncEditorView();
      });
    }
    patchOrClearPlace(null);
    setEditorMsg(null);
    try {
      setEditorPass(localStorage.getItem(EDITOR_PASS_KEY) || '');
    } catch {
      /* приватный режим — пароль вводится вручную */
    }
    setEditorOpen(true);
    // Режим редактирования выключает мирную ходьбу: цель клика и маршрут гасим.
    const e = engineRef.current;
    e.ptarget = null;
    e.path = [];
    e.hover = null;
    camRef.current.init = false;
  };

  const closeEditor = () => {
    editorRef.current = null;
    setEditorOpen(false);
    setEditorView(null);
    setEditorMsg(null);
    // Черновик без записи: поле возвращается к сохранённой сервером локации.
    setTestMap(savedMapRef.current);
    // Подмену рисунка (черновой холст кисти) снимаем: декодируем заново рисунок
    // сохранённой локации, если он есть.
    void ensurePaintDecoded();
    camRef.current.init = false;
  };

  const setEditorTool = (tool: EditorTool) => {
    const d = editorRef.current;
    if (!d) return;
    d.tool = tool;
    // Камень/дерево: сразу создаём «призрак» постановки — следует за курсором,
    // размер/поворот подгоняются до клика-фиксации; остальные инструменты его снимают.
    if (tool === 'tree' || tool === 'stone') {
      const p = editorPlaceRef.current;
      if (!p || p.kind !== tool) {
        patchEditorPlace({
          kind: tool,
          spr: lastSprRef.current[tool],
          anchored: false,
          pickId: null,
        });
      }
    } else {
      patchOrClearPlace(null);
    }
    syncEditorView();
  };

  /** Полная очистка ставящегося объекта (ref + state). */
  const patchOrClearPlace = (p: EditorPlace | null) => {
    editorPlaceRef.current = p;
    setEditorPlace(p);
  };

  /** Зажим точки опоры призрака в пределы мира (плюс небольшой запас по краям). */
  const clampPlacePos = (x: number, y: number): { x: number; y: number } => {
    const d = editorRef.current;
    if (!d) return { x, y };
    return {
      x: Math.min(d.cols + 0.5, Math.max(-0.5, Math.round(x * 100) / 100)),
      y: Math.min(d.rows + 1.5, Math.max(-0.2, Math.round(y * 100) / 100)),
    };
  };

  /** Препятствие под курсором (для подъёма существующего объекта в призрак).
 *  Считается расстояние до точки опоры тела; exceptId — чей-то поднятый объект. */
  const pickObstacleAt = (mx: number, my: number, exceptId: string | null): TestMapObject | null => {
    const s = settingsRef.current;
    let best: TestMapObject | null = null;
    let bestD = 34; // px вокруг точки опоры — щедрый захват
    for (const ob of testObstacleBodies()) {
      if (exceptId && ob.o.id === exceptId) continue;
      const dist = Math.hypot(mx - ob.x * s.field.cellW, my - ob.y * s.field.cellH);
      if (dist < bestD) {
        bestD = dist;
        best = ob.o;
      }
    }
    return best;
  };

  /** Подъём существующего препятствия в призрак: оригинал остаётся в черновике,
   * но скрывается — ✓ поставит правленый объект вместо него, ✕ вернёт как было. */
  const liftObstacleToPlace = (o: TestMapObject) => {
    const b = objectBase(o);
    lastSprRef.current[o.kind === 'tree' ? 'tree' : 'stone'] = objectSprite(o);
    patchEditorPlace({
      kind: o.kind === 'tree' ? 'tree' : 'stone',
      spr: objectSprite(o),
      s: objectScale(o),
      rot: objectRotDeg(o),
      mir: objectMir(o),
      x: b.x,
      y: b.y,
      anchored: true,
      pickId: o.id,
    });
  };

  /** Клик инструментом камня/дерева: фиксация/перенос точки призрака или подъём
   *  существующего объекта под курсором. */
  const editorPlacementClick = (mx: number, my: number) => {
    const p = editorPlaceRef.current;
    if (!p) return;
    const s = settingsRef.current;
    if (p.anchored) {
      // клик по другому объекту — поднимаем его; по земле — переносим точку
      const hit = pickObstacleAt(mx, my, p.pickId);
      if (hit) {
        liftObstacleToPlace(hit);
        return;
      }
      const b = clampPlacePos(mx / s.field.cellW, my / s.field.cellH);
      patchEditorPlace(b);
      return;
    }
    const hit = pickObstacleAt(mx, my, null);
    if (hit) {
      liftObstacleToPlace(hit);
      return;
    }
    const b = clampPlacePos(mx / s.field.cellW, my / s.field.cellH);
    patchEditorPlace({ ...b, anchored: true });
  };

  /** ✓ — поставить: поднятый объект заменяется, новый добавляется; призрак
   *  остаётся неприкреплённым — можно ставить следующий сразу. */
  const confirmEditorPlace = () => {
    const d = editorRef.current;
    const p = editorPlaceRef.current;
    if (!d || !p) return;
    if (d.objects.length - (p.pickId ? 1 : 0) >= TEST_MAP_LIMITS.objectsMax) {
      setEditorMsg(`Объектов не больше ${TEST_MAP_LIMITS.objectsMax}.`);
      return;
    }
    pushEditorUndo();
    d.objects = d.objects.filter((o) => o.id !== p.pickId);
    d.objects.push({
      id: newObjectId(),
      kind: p.kind,
      spr: p.spr,
      s: p.s,
      rot: p.rot,
      mir: p.mir,
      x: p.x,
      y: p.y,
      c: Math.min(d.cols - 1, Math.max(0, Math.floor(p.x))),
      r: Math.min(d.rows - 1, Math.max(0, Math.floor(p.y - 0.01))),
      pos: 'center',
    });
    d.dirty = true;
    lastSprRef.current[p.kind] = p.spr;
    patchEditorPlace({ pickId: null, anchored: false });
    applyDraftPreview();
    syncEditorView();
  };

  /** ✕ — отмена: поднятый объект возвращается (он никуда не удалялся из черновика). */
  const cancelEditorPlace = () => {
    const d = editorRef.current;
    patchOrClearPlace(null);
    if (d) {
      applyDraftPreview();
      syncEditorView();
    }
  };

  /** Смена размера мира: зоны и препятствия, вылезшие за новый край, обрезаются/удаляются. */
  const resizeEditorWorld = (cols: number, rows: number) => {
    const d = editorRef.current;
    if (!d) return;
    const nc = Math.min(TEST_MAP_LIMITS.colsMax, Math.max(TEST_MAP_LIMITS.colsMin, cols));
    const nr = Math.min(TEST_MAP_LIMITS.rowsMax, Math.max(TEST_MAP_LIMITS.rowsMin, rows));
    if (nc === d.cols && nr === d.rows) return;
    pushEditorUndo();
    d.cols = nc;
    d.rows = nr;
    const kept: TestMapZone[] = [];
    for (const z of d.zones) {
      const c1 = Math.min(z.c1, nc - 1);
      const r1 = Math.min(z.r1, nr - 1);
      if (z.c0 <= c1 && z.r0 <= r1) kept.push({ ...z, c1, r1 });
    }
    d.zones = kept;
    d.objects = d.objects.filter((o) => {
      if (o.kind === 'stone' || o.kind === 'tree') {
        const b = objectBase(o);
        return b.x < nc && b.y - 0.01 < nr;
      }
      return o.c < nc && o.r < nr;
    });
    // Клетки высот за новым краем мира исчезают вместе с краем.
    const keptElev: Record<string, number> = {};
    for (const [key, lv] of Object.entries(d.elev)) {
      const [c, r] = key.split(',').map(Number);
      if (c < nc && r < nr) keptElev[key] = lv;
    }
    d.elev = keptElev;
    // Холст кисти живёт в канонических пикселях мира: при смене размера — новый
    // холст нужного размера, старый рисунок переносится 1:1 (вылезшее — срезано,
    // добавленное — пустота за кромкой).
    if (d.pcv) {
      const next = document.createElement('canvas');
      next.width = nc * PAINT_CELL_W;
      next.height = nr * PAINT_CELL_H;
      const g = next.getContext('2d');
      if (g) {
        g.imageSmoothingEnabled = false;
        g.drawImage(d.pcv, 0, 0);
      }
      d.pcv = next;
      d.pundo = [];
      d.pdirty = true;
      setPaintOverride(next, true);
    }
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
  };

  /** Вычитание прямоугольника из зоны: остаток распадается максимум на 4 полосы. */
  const subtractFromZone = (
    z: TestMapZone,
    cut: { c0: number; r0: number; c1: number; r1: number },
  ): TestMapZone[] => {
    const c0 = Math.max(z.c0, cut.c0);
    const r0 = Math.max(z.r0, cut.r0);
    const c1 = Math.min(z.c1, cut.c1);
    const r1 = Math.min(z.r1, cut.r1);
    if (c0 > c1 || r0 > r1) return [z];
    const pieces: TestMapZone[] = [];
    if (z.r0 < r0) pieces.push({ ...z, id: newZoneId(), r0: z.r0, r1: r0 - 1 });
    if (z.r1 > r1) pieces.push({ ...z, id: newZoneId(), r0: r1 + 1, r1: z.r1 });
    if (z.c0 < c0) pieces.push({ ...z, id: newZoneId(), c0: z.c0, c1: c0 - 1, r0, r1 });
    if (z.c1 > c1) pieces.push({ ...z, id: newZoneId(), c0: c1 + 1, c1: z.c1, r0, r1 });
    return pieces;
  };

  /** Завершение рисунка: прямоугольник становится зоной (или стирает зоны ластиком). */
  const commitEditorDrag = () => {
    const d = editorRef.current;
    if (!d || !d.drag) return;
    const drag = d.drag;
    d.drag = null;
    const c0 = Math.min(drag.c0, drag.c1);
    const c1 = Math.max(drag.c0, drag.c1);
    const r0 = Math.min(drag.r0, drag.r1);
    const r1 = Math.max(drag.r0, drag.r1);
    if (c1 < c0 || r1 < r0) {
      syncEditorView();
      return;
    }
    pushEditorUndo();
    if (drag.erase || d.tool === 'erase') {
      d.zones = d.zones.flatMap((z) => subtractFromZone(z, { c0, r0, c1, r1 }));
      // ластик снимает препятствия (по точке опоры), клеточные объекты
      // (землю/покрытие/заход) и клетки спавна внутри стёртого прямоугольника
      d.objects = d.objects.filter((o) => {
        if (o.kind === 'stone' || o.kind === 'tree') {
          const b = objectBase(o);
          const fc = Math.floor(b.x);
          const fr = Math.floor(b.y - 0.01);
          return !(fc >= c0 && fc <= c1 && fr >= r0 && fr <= r1);
        }
        return !(o.c >= c0 && o.c <= c1 && o.r >= r0 && o.r <= r1);
      });
      d.spawns = d.spawns.filter((s) => !(s.c >= c0 && s.c <= c1 && s.r >= r0 && s.r <= r1));
      // и срезает рельеф: стёртый участок возвращается к базовой земле
      let elevChanged = false;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          if (`${c},${r}` in d.elev) {
            delete d.elev[`${c},${r}`];
            elevChanged = true;
          }
        }
      }
      if (elevChanged) applyDraftPreview();
    } else {
      const kind: TestMapZoneKind = d.tool === 'green' ? 'green' : 'cells';
      const n = d.zones.filter((z) => z.kind === kind).length + 1;
      d.zones = [
        ...d.zones,
        {
          id: newZoneId(),
          name: kind === 'cells' ? `Клетки ${n}` : `Зелёная зона ${n}`,
          kind,
          c0,
          r0,
          c1,
          r1,
        },
      ];
    }
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
  };

  const deleteEditorZone = (id: string) => {
    const d = editorRef.current;
    if (!d) return;
    pushEditorUndo();
    d.zones = d.zones.filter((z) => z.id !== id);
    d.sel = d.sel.filter((s) => s !== id);
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
  };

  /** Отметка зоны для объединения (галка в списке зон). */
  const toggleEditorSel = (id: string) => {
    const d = editorRef.current;
    if (!d) return;
    d.sel = d.sel.includes(id) ? d.sel.filter((s) => s !== id) : [...d.sel, id];
    syncEditorView();
  };

  /** Объединение отмеченных зон в одну: общий охватывающий прямоугольник, тип и
   *  имя — от первой отмеченной в списке. Зоны — прямоугольники, поэтому союз
   *  двух угловатых областей — это всегда их охват (клетки между ними входят). */
  const mergeEditorZones = () => {
    const d = editorRef.current;
    if (!d) return;
    const chosen = d.zones.filter((z) => d.sel.includes(z.id));
    if (chosen.length < 2) return;
    pushEditorUndo();
    const first = chosen[0];
    const merged: TestMapZone = {
      id: newZoneId(),
      name: first.name,
      kind: first.kind,
      c0: Math.min(...chosen.map((z) => z.c0)),
      r0: Math.min(...chosen.map((z) => z.r0)),
      c1: Math.max(...chosen.map((z) => z.c1)),
      r1: Math.max(...chosen.map((z) => z.r1)),
    };
    d.zones = [...d.zones.filter((z) => !d.sel.includes(z.id)), merged];
    d.sel = [];
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
  };

  /** Протяжка «Земли»/«Покрытия»: насыпает клетки без снятия и без записи отмены
   *  на каждую клетку (отмена пишется один раз на росчерк — см. pointerdown).
   *  Земля и покрытие не совмещаются на одной клетке: покрытие заменяет проталину. */
  const paintEditorCellObject = (kind: 'dirt' | 'ground', c: number, r: number): boolean => {
    const d = editorRef.current;
    if (!d) return false;
    if (d.objects.some((o) => (o.kind === 'dirt' || o.kind === 'ground') && o.c === c && o.r === r)) return false;
    if (d.objects.length >= TEST_MAP_LIMITS.objectsMax) {
      setEditorMsg(`Объектов не больше ${TEST_MAP_LIMITS.objectsMax}.`);
      return false;
    }
    d.objects.push(
      kind === 'ground'
        ? { id: newObjectId(), kind: 'ground', c, r, cv: editorCoverRef.current, pos: 'center' }
        : { id: newObjectId(), kind: 'dirt', c, r, pos: 'center' },
    );
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
    return true;
  };

  /** Клетка спавна разрешена только на траве (зелёной зоне) и не на боевых
   *  клетках: новичок появляется в мирном режиме (это же проверяет сервер). */
  /** Поставить/снять одиночную боевую клетку (kind «battle»). Боевая клетка —
   *  область 150×100: ставится только на место, покрашенное кистью целиком;
   *  если место не соответствует размерам — клетка не ставится. Повторный клик
   *  по уже стоящей клетке снимает её. */
  const placeBattleCell = (c: number, r: number) => {
    const d = editorRef.current;
    if (!d) return;
    const existing = d.objects.some((o) => o.kind === 'battle' && o.c === c && o.r === r);
    if (!existing && !d.pcv) {
      setEditorMsg(
        'Боевая клетка ставится на закрашенное кистью место: проведите кистью (пресет «Клетка 150×100»), затем кликните по клетке.',
      );
      return;
    }
    if (!existing && paintCellCoverage(c, r) < 0.995) {
      setEditorMsg(
        `Боевая клетка ${c + 1}×${r + 1} не поставлена: место покрашено не целиком. Закрасьте область клетки пресетом кисти «Клетка 150×100».`,
      );
      return;
    }
    if (!existing && testObjectAt(c, r)) {
      setEditorMsg(`Боевая клетка ${c + 1}×${r + 1} не поставлена: на клетке уже стоит другой объект.`);
      return;
    }
    pushEditorUndo();
    if (existing) {
      d.objects = d.objects.filter((o) => !(o.kind === 'battle' && o.c === c && o.r === r));
    } else {
      d.objects.push({ id: newObjectId(), kind: 'battle', c, r, pos: 'center' });
    }
    d.dirty = true;
    setEditorMsg(existing ? `Боевая клетка ${c + 1}×${r + 1} снята.` : null);
    syncEditorView();
    applyDraftPreview();
  };

  const editorSpawnAllowed = (d: EditorDraft, c: number, r: number): boolean => {
    const onBattle =
      d.zones.some((z) => z.kind === 'cells' && c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1) ||
      d.objects.some((o) => o.kind === 'battle' && o.c === c && o.r === r);
    if (onBattle) return false;
    // С рисунком кисти спавн — на любом закрашенном месте (не на боевых клетках);
    // без рисунка — по-старому, только в зелёной зоне.
    if (d.pcv) return paintPointOn(c + 0.5, r + 0.5);
    return d.zones.some((z) => z.kind === 'green' && c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1);
  };

  /**
   * Кисть рельефа: «насыпать» (+1 уровень, предел 3), «срыть» (−1, до базовой
   * земли) и «ровно» (срезает все клетки росчерка на уровень первой клетки).
   * Росчерк пишет отмену один раз и не обрабатывает клетку дважды — протяжка
   * с зажатой кнопкой насыпает уступ целиком (см. pointerdown/pointermove).
   */
  const applyElevBrush = (mode: 'raise' | 'lower' | 'flat', c: number, r: number): boolean => {
    const d = editorRef.current;
    if (!d) return false;
    if (c < 0 || r < 0 || c >= d.cols || r >= d.rows) return false;
    const stroke = elevStrokeRef.current;
    if (!stroke) return false;
    const key = `${c},${r}`;
    if (stroke.touched.has(key)) return false;
    stroke.touched.add(key);
    const cur = d.elev[key] ?? 0;
    let next: number;
    if (mode === 'raise') next = Math.min(TERRAIN_MAX_LEVEL, cur + 1);
    else if (mode === 'lower') next = Math.max(0, cur - 1);
    else next = Math.min(TERRAIN_MAX_LEVEL, Math.max(0, stroke.flat));
    if (next === cur) return false;
    if (next <= 0) delete d.elev[key];
    else d.elev[key] = next;
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
    return true;
  };

  /** Начало росчерка кисти рельефа: копилка тронутых клеток + уровень «Ровно»
   *  (уровень первой клетки под кистью — весь росчерк срезается в неё). */
  const beginElevStroke = (mode: 'raise' | 'lower' | 'flat', c: number, r: number) => {
    const d = editorRef.current;
    const first = d ? d.elev[`${c},${r}`] ?? 0 : 0;
    elevStrokeRef.current = { touched: new Set(), flat: mode === 'flat' ? first : 0 };
    applyElevBrush(mode, c, r);
  };

  const endElevStroke = () => {
    elevStrokeRef.current = null;
  };

  /** Добавить клетку спавна (клик/протяжка инструмента «Спавн»): одна точка
   *  на клетку, лимит TEST_MAP_LIMITS.spawnsMax. */
  const addEditorSpawn = (c: number, r: number): boolean => {
    const d = editorRef.current;
    if (!d) return false;
    if (d.spawns.some((s) => s.c === c && s.r === r)) return true;
    if (!editorSpawnAllowed(d, c, r)) {
      setEditorMsg('Клетка спавна ставится на траве (зелёной зоне), не на боевых клетках.');
      return false;
    }
    if (d.spawns.length >= TEST_MAP_LIMITS.spawnsMax) {
      setEditorMsg(`Клеток спавна не больше ${TEST_MAP_LIMITS.spawnsMax}.`);
      return false;
    }
    d.spawns.push({ c, r });
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
    return true;
  };

  /** Клик инструментом «Спавн»: клетка со спавном — снимает, без — ставит. */
  const toggleEditorSpawn = (c: number, r: number): boolean => {
    const d = editorRef.current;
    if (!d) return false;
    const idx = d.spawns.findIndex((s) => s.c === c && s.r === r);
    if (idx < 0) return addEditorSpawn(c, r);
    d.spawns.splice(idx, 1);
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
    return true;
  };

  /** Постановка клетки захода (инструмент «Заход»): клик ставит заход с выбранным
   *  направлением, клик по тому же заходу с тем же направлением — убирает, с другим —
   *  меняет направление. На боевой клетке заход не ставится; по направлению шага
   *  обязана быть боевая клетка (это же проверяет сервер при сохранении). */
  const placeEditorEntry = (c: number, r: number): boolean => {
    const d = editorRef.current;
    if (!d) return false;
    const dir = editorEntryDirRef.current;
    const idx = d.objects.findIndex((o) => o.c === c && o.r === r);
    if (idx >= 0 && d.objects[idx].kind === 'entry') {
      pushEditorUndo();
      if (d.objects[idx].dir === dir) d.objects.splice(idx, 1);
      else d.objects[idx] = { ...d.objects[idx], dir };
      d.dirty = true;
      applyDraftPreview();
      syncEditorView();
      return true;
    }
    const isBattleAt = (cc: number, rr: number): boolean =>
      d.zones.some((z) => z.kind === 'cells' && cc >= z.c0 && cc <= z.c1 && rr >= z.r0 && rr <= z.r1) ||
      d.objects.some((o) => o.kind === 'battle' && o.c === cc && o.r === rr);
    const battleCell = isBattleAt(c, r);
    const targetBattle = isBattleAt(
      c + (dir === 'left' ? -1 : dir === 'right' ? 1 : 0),
      r + (dir === 'up' ? -1 : dir === 'down' ? 1 : 0),
    );
    if (battleCell) {
      setEditorMsg('Клетка захода ставится на траве рядом с боевой зоной, не на боевых клетках.');
      return false;
    }
    if (!targetBattle) {
      setEditorMsg('По направлению шага должна быть боевая клетка — выберите направление в сторону зоны.');
      return false;
    }
    // Логика боевых клеток — и для заходов: заход занимает клетку 150×100 и
    // ставится только на место, покрашенное кистью целиком.
    if (d.pcv && paintCellCoverage(c, r) < 0.995) {
      setEditorMsg(
        `Заход ${c + 1}×${r + 1} не поставлен: место покрашено не целиком. Закрасьте область клетки пресетом кисти «Клетка 150×100».`,
      );
      return false;
    }
    if (idx < 0 && d.objects.length >= TEST_MAP_LIMITS.objectsMax) {
      setEditorMsg(`Объектов не больше ${TEST_MAP_LIMITS.objectsMax}.`);
      return false;
    }
    pushEditorUndo();
    if (idx >= 0) d.objects.splice(idx, 1); // замена другого объекта на заход
    d.objects.push({ id: newObjectId(), kind: 'entry', c, r, pos: 'center', dir });
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
    return true;
  };

  const renameEditorZone = (id: string, name: string) => {
    const d = editorRef.current;
    if (!d) return;
    const z = d.zones.find((zz) => zz.id === id);
    if (!z) return;
    z.name = name.slice(0, TEST_MAP_LIMITS.nameMax);
    d.dirty = true;
    syncEditorView();
  };

  const undoEditor = () => {
    const d = editorRef.current;
    if (!d || d.undo.length === 0) return;
    const back = d.undo.pop()!;
    d.zones = back.zones.map((z) => ({ ...z }));
    d.objects = back.objects.map((o) => ({ ...o }));
    d.spawns = back.spawns.map((s) => ({ ...s }));
    d.elev = { ...back.elev };
    d.cols = back.cols;
    d.rows = back.rows;
    d.sel = d.sel.filter((id) => d.zones.some((z) => z.id === id));
    applyDraftPreview();
    syncEditorView();
  };

  const resetEditor = () => {
    const d = editorRef.current;
    if (!d) return;
    pushEditorUndo();
    const m = savedMapRef.current;
    d.zones = m.zones.map((z) => ({ ...z }));
    d.objects = (m.objects ?? []).map((o) => ({ ...o }));
    d.spawns = (m.spawns ?? []).map((s) => ({ ...s }));
    d.elev = { ...(m.elev ?? {}) };
    d.cols = m.cols;
    d.rows = m.rows;
    d.sel = [];
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
  };

  /** Предварительная проверка черновика — те же правила, что у сервера. */
  const editorDraftError = (): string | null => {
    const d = editorRef.current;
    if (!d) return null;
    // Кисть локации: PNG base64 обязан быть валидным и не слишком большим.
    if (d.pcv) {
      const perr = paintFormatError(encodeDraftPaint(d));
      if (perr) return perr === 'рисунок локации слишком велик' ? 'Рисунок локации слишком велик — сотрите лишнее и сохраните снова.' : perr;
    }
    if (d.pcv) {
      // С рисунком зоны не обязаны быть вовсе (форма — из пикселей), но бой
      // обязан быть: зоны с клетками или одиночные боевые клетки.
      const hasBattle =
        d.zones.some((z) => z.kind === 'cells') || d.objects.some((o) => o.kind === 'battle');
      if (!hasBattle) return 'Нужна хотя бы одна боевая клетка или зона с клетками — иначе бой не работает.';
      return null;
    }
    if (d.zones.length === 0) return 'Нужна хотя бы одна зона.';
    if (!d.zones.some((z) => z.kind === 'cells')) return 'Нужна хотя бы одна зона с клетками.';
    if (d.objects.length > TEST_MAP_LIMITS.objectsMax) return `Препятствий не больше ${TEST_MAP_LIMITS.objectsMax}.`;
    return testMapConnectivityError(d.zones);
  };

  const saveEditorMap = () => {
    const d = editorRef.current;
    const net = netRef.current;
    if (!d || !net) return;
    if (!net.ready) {
      setEditorMsg('Нет связи с сервером.');
      return;
    }
    const err = editorDraftError();
    if (err) {
      setEditorMsg(err);
      return;
    }
    try {
      localStorage.setItem(EDITOR_PASS_KEY, editorPass);
    } catch {
      /* приватный режим — просто не запоминаем */
    }
    net.emit('setmap', { pass: editorPass, map: draftMap(d) });
    setEditorMsg('Сохраняем…');
  };

  /**
   * Применить якорь атмосферы с сервера (снапшот, эхо нажатия или рассылка смены):
   * часы цикла, погода, кнопки панели и — если темп комнаты расходится с локальными
   * настройками — сами настройки (ползунки показывают общее значение комнаты).
   */
  const applyAtmoAnchor = useCallback((a: CoopAtmoAnchor) => {
    atmoAnchorRef.current = { cs: a.cs, pl: a.pl, wl: a.wl, w: a.w, ws: a.ws, srv: true };
    atmoStateRef.current = { dp: a.dp, w: a.w };
    setAtmoState({ dp: a.dp, w: a.w });
    atmoRef.current?.setWeather(a.w);
    const plMin = Math.round(a.pl / 60_000);
    const wlMin = Math.round(a.wl / 60_000);
    const cur = settingsRef.current.atmo;
    if (cur.phaseMin !== plMin || cur.weatherMin !== wlMin) {
      setSettings((p) => ({ ...p, atmo: { phaseMin: plMin, weatherMin: wlMin } }));
    }
  }, []);

  /** Оптимистичная перемотка (кнопки панели): якорь локально к середине части
   *  суток и погода сразу — серверное эхо подтвердит тем же якорем. */
  const applyAtmo = useCallback((next: CoopAtmo) => {
    const clk = atmoAnchorRef.current;
    const now = Date.now();
    const pl = clk.pl > 0 ? clk.pl : Math.round(settingsRef.current.atmo.phaseMin * 60_000);
    const idx = next.dp === 'morning' ? 0 : next.dp === 'day' ? 1 : next.dp === 'evening' ? 2 : 3;
    atmoAnchorRef.current = { ...clk, cs: now - (idx + 0.5) * pl, w: next.w, ws: now };
    atmoStateRef.current = next;
    setAtmoState(next);
    atmoRef.current?.setWeather(next.w);
  }, []);

  /** Сменить атмосферу комнаты: применяем сразу и шлём на сервер — эхо подтвердит всем. */
  const changeAtmo = useCallback(
    (dp: DayPart, w: WeatherKind) => {
      applyAtmo({ dp, w });
      netRef.current?.emit('atmo', { dp, w });
    },
    [applyAtmo],
  );

  /** Темп цикла атмосферы (длительности части суток и интервала погоды).
   *  Общий для комнаты: локально переклиниваем якорь с сохранением позиции суток
   *  (день не прыгает в ночь) и шлём «atmoset» — сервер подтвердит якорем всем. */
  const changeAtmoCfg = useCallback((phaseMin: number, weatherMin: number) => {
    const plMin = Math.min(120, Math.max(1, Math.round(phaseMin)));
    const wlMin = Math.min(240, Math.max(2, Math.round(weatherMin)));
    setSettings((p) => ({ ...p, atmo: { phaseMin: plMin, weatherMin: wlMin } }));
    const clk = atmoAnchorRef.current;
    const now = Date.now();
    const frac = clk.pl > 0 ? ((((now - clk.cs) / (clk.pl * 4)) % 1) + 1) % 1 : 1.5 / 4;
    const pl = plMin * 60_000;
    atmoAnchorRef.current = {
      ...clk,
      cs: now - frac * pl * 4,
      pl,
      wl: wlMin * 60_000,
      ws: now,
    };
    netRef.current?.emit('atmoset', { pl: plMin, wl: wlMin });
  }, []);

  useEffect(() => {
    if (!loaded || !netStarted) return;
    const pending = pendingJoinRef.current;
    const login = (pending?.login || nameFromUrl() || '').trim();
    // Сокет нужен уже на экране входа: он слушает состав комнат (roomsinfo),
    // пока игрок печатает имя. Вход без имени не делаем — join уйдёт из
    // pickRoom(), где имя берётся из pendingJoinRef (его кладёт joinFromEntry).
    if (login) setPlayerName(login);
    const client = createCoopClient({
      onOpen: () => {
        setNetStatus('соединение есть');
        // Состав комнат для выбора/модалки: спрашиваем сразу после соединения —
        // дальше экран выбора опрашивает сам по своему интервалу.
        client.requestRooms(wantedRoomIds());
      },
      onRooms: (list) => {
        setRoomsRows(list);
        setRoomsStale(false);
      },
      onYou: (cat) => {
        meIdRef.current = cat.id;
        setMeId(cat.id);
        setNetReady(true);
        freshJoinRef.current = true;
        const e = engineRef.current;
        const col = typeof cat.x === 'number' ? Math.max(0, cat.x - 1) : e.col;
        const row = typeof cat.y === 'number' ? Math.max(0, cat.y - 1) : e.row;
        e.col = col;
        e.row = row;
        // В «тесте» свободная позиция — серверная freemove-точка, а не логическая
        // клетка: точку сервер хранит в книге позиций и возвращает после рестарта,
        // поэтому ни вход, ни переподключение не сбрасывают кота на клетку спавна.
        if (cat.fm === 1 && Number.isFinite(cat.fx) && Number.isFinite(cat.fy)) {
          e.fx = cat.fx!;
          e.fy = cat.fy!;
        } else {
          e.fx = col;
          e.fy = row;
        }
        netMovesRef.current = { server: { col, row }, pending: [] };
        setNetStatus(`Вы — ${cat.login || 'кот'} (#${cat.id})`);
        if (cat.login) setPlayerName(cat.login);
        // После переподключения сервер завёл нового кота без блока: сообщаем стойку заново,
        // иначе удерживаемый К после обрыва перестал бы ловить удары в «Лапы».
        if (e.blocking) netRef.current?.emit('block', { on: true });
        // Броня — тоже: новый кот на сервере без брони, и входящий урон шёл бы целиком.
        netRef.current?.emit('armor', { armor: settingsRef.current.combat.armorLevel / 10 });
      },
      onField: (field) => {
        const cats = field.cats || [];
        const others = cats.filter((c) => c.id !== meIdRef.current);
        // Формат поля комнаты: «test» — лужайка/переход/закуток (камера, свободная ходьба).
        const fmt = field.format === 'test' ? 'test' : 'grid';
        if (fmt !== fieldFormatRef.current) {
          fieldFormatRef.current = fmt;
          setFieldFormat(fmt);
          // Ушли из «теста» (переход в другой комнате) — редактор закрывается сам.
          if (fmt !== 'test' && editorOpenRef.current) closeEditor();
        }
        // Конфиг локации «теста»: применяется до любой отрисовки — setTestMap
        // сбрасывает кэши, и поле рисуется уже по новому конфигу.
        if (field.map) {
          const checkedMap = sanitizeTestMap(field.map).map;
          if (checkedMap) {
            applyTestMap(checkedMap);
            showMapLoading();
          }
        }
        // Атмосфера комнаты — общая: якорь часов цикла и погода приходят в снапшоте
        // (вход, переподключение, сохранение локации).
        if (field.atmo) applyAtmoAnchor(field.atmo);
        camRef.current.init = false;
        remoteFreeRef.current.clear();
        remoteFmRef.current.clear();
        liveRemotesRef.current = others.map(catToDummy);
        // Кто из чужих котов идёт свободно (fm=1) — сеем плавную доведённую позицию.
        for (const c of others) {
          // Режим каждого чужого кота — для стрел/процентов: мирный кот стрелы не имеет.
          remoteFmRef.current.set(`p${c.id}`, c.fm === 1 ? 1 : 0);
          if (c.fm === 1 && Number.isFinite(c.fx) && Number.isFinite(c.fy)) {
            remoteFreeRef.current.set(`p${c.id}`, { x: c.fx!, y: c.fy!, tx: c.fx!, ty: c.fy! });
          }
        }
        // В «тесте» свежий вход — в мирном режиме (спавн на траве). Дальше
        // режимом управляет кнопка боя с клетки захода; страховка на боевых
        // клетках остаётся (см. игровой цикл). Правка локации (setmap) тоже
        // присылает field — гасить боевой режим у всех в этот момент нельзя:
        // принудительный мирный режим — только на самом входе в комнату (после you).
        if (fmt === 'test' && settingsRef.current.arrow.battleMode && freshJoinRef.current) {
          freshJoinRef.current = false;
          suppressExitTeleportRef.current = true;
          setSettings((p) => ({ ...p, arrow: { ...p.arrow, battleMode: false } }));
        }
        // Спавн-точка считаем «внутри зоны»: свежий вход в боевую зону срабатывает
        // только после реального выхода из неё (край, а не «пока внутри»).
        inZonePrevRef.current = true;
        // Кто из чужих котов держит блок — из снапшота комнаты (после обрыва тоже).
        remoteBlockRef.current = new Set(cats.filter((c) => c.blocking && c.id !== meIdRef.current).map((c) => c.id));
        // Кто из чужих котов держит пробел (присед) — тоже из снапшота комнаты.
        remoteSpaceRef.current.clear();
        for (const c of others) {
          if (c.sq === 1) remoteSpaceRef.current.set(`p${c.id}`, { holding: true, since: performance.now(), releaseAt: 0, charge: 0 });
        }
        remoteAimRef.current.clear();
        remoteDrawRef.current.clear();
        for (const d of liveRemotesRef.current) remoteDrawRef.current.set(d.id, seedRemoteDraw({ col: d.col, row: d.row }));
        const seenAt = performance.now();
        for (const d of liveRemotesRef.current) remoteAimRef.current.set(d.id, createRemoteAim(d.angle, seenAt));
        setPeerCount(cats.length || 1);
        if (field.room) setRoomCode(field.room);
        if (field.width && field.height) {
          setSettings((s) => ({
            ...s,
            field: { ...s.field, cols: field.width!, rows: field.height! },
          }));
        }
        const me = cats.find((c) => c.id === meIdRef.current);
        if (me && netMovesRef.current.pending.length === 0) {
          const col = Math.max(0, me.x - 1);
          const row = Math.max(0, me.y - 1);
          engineRef.current.col = col;
          engineRef.current.row = row;
          if (fmt === 'test' && me.fm === 1 && Number.isFinite(me.fx) && Number.isFinite(me.fy)) {
            // «Тест»: свою мирную точку берём из серверной freemove-позиции, а не из
            // логической клетки. Раньше каждый снапшот (сохранение локации,
            // переподключение) ставил кота на клетку сервера — при сохранении
            // локации все улетали на боевые клетки, а после рестарта — на спавн.
            engineRef.current.fx = me.fx!;
            engineRef.current.fy = me.fy!;
          } else {
            engineRef.current.fx = col;
            engineRef.current.fy = row;
          }
          netMovesRef.current.server = { col, row };
        }
        setNetStatus(`Вы в комнате ${roomTitle(field.room || 'demo')} · ${cats.length} на поле`);
        // Манекен и мишень — состояние комнаты: onField приходит при входе и после каждого переподключения.
        const fd = field.dummy;
        if (fd && fd.on && Number.isFinite(fd.x) && Number.isFinite(fd.y)) {
          const spr = SPRITES.find((sp) => sp.id === fd.sprite)?.id;
          applyDummy(true, { x: fd.x, y: fd.y }, spr);
          dummyGrabRef.current = fd.grab || null;
        } else {
          applyDummy(false, null);
          dummyGrabRef.current = null;
        }
        applyRab(!!field.rab?.on);
      },
      onMap: (map) => {
        // Кто-то сохранил локацию в редакторе (и мы сами — сервер шлёт map и автору).
        applyTestMap(map);
        showMapLoading();
        setEditorMsg('Локация обновлена.');
      },
      onCat: (cat) => {
        if (cat.x === 0 && cat.y === 0) {
          remoteAimRef.current.delete(`p${cat.id}`);
          remoteDrawRef.current.delete(`p${cat.id}`);
          remoteBlockRef.current.delete(cat.id);
          remoteSpaceRef.current.delete(`p${cat.id}`);
          remoteFmRef.current.delete(`p${cat.id}`);
          remoteFreeRef.current.delete(`p${cat.id}`);
          liveRemotesRef.current = liveRemotesRef.current.filter((d) => d.id !== `p${cat.id}`);
          setPeerCount(1 + liveRemotesRef.current.length);
          return;
        }
        // Режим чужого кота (fm из publicCat): 1 — мирный (без стрелы), 0 — боевой.
        if (typeof cat.fm === 'number') remoteFmRef.current.set(`p${cat.id}`, cat.fm === 1 ? 1 : 0);
        if (cat.id === meIdRef.current) {
          if (typeof cat.x === 'number' && typeof cat.y === 'number') {
            const col = Math.max(0, cat.x - 1);
            const row = Math.max(0, cat.y - 1);
            const verdict = applyOwnMoveAck(netMovesRef.current, { col, row }, {
              col: engineRef.current.col,
              row: engineRef.current.row,
            });
            if (verdict.type === 'reject') {
              // Сервер поставил другую клетку — догоняем его и забываем неподтверждённые шаги.
              engineRef.current.col = verdict.cell.col;
              engineRef.current.row = verdict.cell.row;
              engineRef.current.path = [];
              engineRef.current.step = null;
              // Короткая пауза на новый шаг: мгновенный перешаг после отката
              // уходил в серверный кулдаун и терялся — снова откат и телепорт.
              engineRef.current.moveLockUntil = performance.now() + NET_ROLLBACK_LOCK_MS;
            } else if (verdict.type === 'place') {
              engineRef.current.col = verdict.cell.col;
              engineRef.current.row = verdict.cell.row;
            }
          }
          const path = engineRef.current.path;
          if (path.length > 0 && path[0].c === engineRef.current.col && path[0].r === engineRef.current.row) {
            path.shift();
          }
          return;
        }
        // Блок чужого кота приходит и с move-пакетами (publicCat несёт blocking).
        if (cat.blocking === true) remoteBlockRef.current.add(cat.id);
        else if (cat.blocking === false) remoteBlockRef.current.delete(cat.id);
        const prev = liveRemotesRef.current.find((d) => d.id === `p${cat.id}`);
        const dummy = catToDummy({
          id: cat.id,
          login: cat.login || prev?.name,
          sprite: cat.sprite || prev?.sprite,
          x: typeof cat.x === 'number' ? cat.x : (prev?.col ?? 0) + 1,
          y: typeof cat.y === 'number' ? cat.y : (prev?.row ?? 0) + 1,
          deg: cat.deg ?? prev?.angle,
          // Рост обязан доехать до пересчёта модельки: если size в пакете нет —
          // держим прежний масштаб соседа, иначе catToDummy вернёт дефолтные 100%
          // и при каждом шаге сосед «вырастал» до максимума (баг «новичок не видит
          // истинный рост старых игроков»).
          size: cat.size ?? prev?.scale,
        });
        // «Тест»: чужой кот в свободной ходьбе — позиция едет в карту плавного
        // доведения, клетка сервера обновляется без анимации шага.
        if (cat.fm === 1 && Number.isFinite(cat.fx) && Number.isFinite(cat.fy)) {
          const fr = remoteFreeRef.current.get(dummy.id);
          if (fr) {
            fr.tx = cat.fx!;
            fr.ty = cat.fy!;
          } else {
            remoteFreeRef.current.set(dummy.id, { x: cat.fx!, y: cat.fy!, tx: cat.fx!, ty: cat.fy! });
          }
          if (prev) {
            prev.col = dummy.col;
            prev.row = dummy.row;
            prev.name = dummy.name;
            prev.sprite = dummy.sprite;
            prev.angle = dummy.angle;
            // Рост — как в боевом ходе ниже: только когда он реально приехал в пакете.
            if (typeof cat.size === 'number' && Number.isFinite(Number(cat.size))) prev.scale = dummy.scale;
          } else {
            // Новый кот сразу в мирном режиме (fm=1 со спавна): ветка боевого
            // добавления не выполняется — добавляем его здесь, иначе соседи
            // не увидят его до первого боевого cellsync.
            rememberRemoteCell(remoteDrawRef.current, dummy.id, dummy.col, dummy.row);
            liveRemotesRef.current = [...liveRemotesRef.current, dummy];
            setPeerCount(1 + liveRemotesRef.current.length);
          }
          const visF = remoteDrawRef.current.get(dummy.id);
          if (visF) {
            visF.col = dummy.col;
            visF.row = dummy.row;
            visF.queue = [];
          }
          return;
        }
        remoteFreeRef.current.delete(dummy.id);
        // Сетевой угол пишем в тот же объект, без setState. На кадре рисуем
        // не его, а сглаженный display. Клетка сервера — в col/row сразу,
        // картинка догоняет её по одной за кадр (remoteDrawRef.current).
        const seenAt = performance.now();
        remoteAimRef.current.set(dummy.id, noteRemoteAim(remoteAimRef.current.get(dummy.id), dummy.angle, seenAt, !prev));
        if (prev) {
          const moved = prev.col !== dummy.col || prev.row !== dummy.row;
          prev.col = dummy.col;
          prev.row = dummy.row;
          prev.angle = dummy.angle;
          prev.name = dummy.name;
          prev.sprite = dummy.sprite;
          // Рост обновляем только когда он реально пришёл в пакете (иначе сбросили бы
          // выбранный при спавне размер до дефолта).
          if (typeof cat.size === 'number' && Number.isFinite(Number(cat.size))) prev.scale = dummy.scale;
          if (moved) rememberRemoteCell(remoteDrawRef.current, prev.id, dummy.col, dummy.row);
          return;
        }
        rememberRemoteCell(remoteDrawRef.current, dummy.id, dummy.col, dummy.row);
        liveRemotesRef.current = [...liveRemotesRef.current, dummy];
        setPeerCount(1 + liveRemotesRef.current.length);
      },
      onBlock: (info) => {
        // Стойка блока чужого кота: нужна бьющему, чтобы проводить удары в «Лапы»
        // (кроме хвоста — удар в хвост блок не ловит).
        if (info.id === meIdRef.current) return;
        if (info.on) remoteBlockRef.current.add(info.id);
        else remoteBlockRef.current.delete(info.id);
      },
      onSpace: (info) => {
        // Присед-желе чужого кота: времена якорим к локальным часам, а длительность
        // удержания приходит в пакете отпускания — заряд считается без синхронизации
        // часов клиентов. Своему коту анимация и так рисуется локально (эхо не шлём).
        if (info.id === meIdRef.current) return;
        const key = `p${info.id}`;
        if (info.on) {
          remoteSpaceRef.current.set(key, { holding: true, since: performance.now(), releaseAt: 0, charge: 0 });
          return;
        }
        if (info.cancel) {
          // Окно отправителя потеряло фокус — чужой кот просто выпрямляется.
          remoteSpaceRef.current.set(key, { holding: false, since: 0, releaseAt: 0, charge: 0 });
          return;
        }
        const hold = Math.max(0, Math.min(4000, Math.round(info.hold ?? 0)));
        remoteSpaceRef.current.set(key, {
          holding: false,
          since: 0,
          releaseAt: performance.now(),
          charge: 0.15 + 0.85 * (hold / 4000),
        });
      },
      onFreeMove: (m) => {
        // Чужой кот идёт свободно («тест», мирный режим): обновляем цель доведения
        // и логическую клетку — по ней работают удары и препятствия. Режим — мирный:
        // стрела и проценты у такого кота не рисуются. sp — чужой спринт: под этим
        // котом сыплются комочки земли/травы (см. игровой цикл).
        const key = `p${m.id}`;
        remoteFmRef.current.set(key, 1);
        const fr = remoteFreeRef.current.get(key);
        if (fr) {
          fr.tx = m.x;
          fr.ty = m.y;
          fr.sp = m.sp;
          // jp — чужой кот в прыжке: одна дуга на прыжок (пакеты внутри прыжка
          // продлевают текущую дугу только когда она уже закончилась)
          if (m.jp) {
            const nowJp = performance.now();
            if (!fr.jpUntil || nowJp >= fr.jpUntil) fr.jpUntil = nowJp + 430;
          }
        } else {
          remoteFreeRef.current.set(key, { x: m.x, y: m.y, tx: m.x, ty: m.y, sp: m.sp, jpUntil: m.jp ? performance.now() + 430 : undefined });
        }
        if (m.cx != null && m.cy != null) {
          const prev = liveRemotesRef.current.find((d) => d.id === key);
          if (prev) {
            prev.col = m.cx - 1;
            prev.row = m.cy - 1;
          }
          const vis = remoteDrawRef.current.get(key);
          if (vis) {
            vis.col = m.cx - 1;
            vis.row = m.cy - 1;
            vis.queue = [];
          }
        }
      },
      onFight: (fight) => applyNetFight(fight),
      onChat: (message) => {
        setChatLines((prev) => {
          if (prev.some((line) => line.seq === message.seq)) return prev;
          return [...prev, message].slice(-80);
        });
      },
      onChatLog: (messages) => setChatLines(messages.slice(-80)),
      onInfo: (text) => {
        setNetStatus(text);
        // Совместимость со старым сервером без refuse-кодов: откат предикта по тексту.
        if (
          !text.includes('Клетка занята') &&
          !text.includes('Край поля') &&
          !text.includes('Слишком быстро') &&
          !text.includes('Обрыв')
        )
          return;
        const cell = rejectOwnMove(netMovesRef.current);
        if (cell) {
          engineRef.current.col = cell.col;
          engineRef.current.row = cell.row;
        }
        engineRef.current.path = [];
        engineRef.current.step = null;
        engineRef.current.moveLockUntil = performance.now() + NET_ROLLBACK_LOCK_MS;
      },
      onRefuse: (refuse) => {
        if (refuse?.text) setNetStatus(refuse.text);
        // Основной путь — код отказа: редактура русских текстов на сервере
        // больше не ломает откат предикта. cliff — обрыв: шаг на клетку с
        // перепадом больше 1 отвергнут (нужен прыжок), предикт откатывается.
        if (
          refuse?.code !== 'cell_busy' &&
          refuse?.code !== 'edge' &&
          refuse?.code !== 'cooldown' &&
          refuse?.code !== 'cliff'
        )
          return;
        const cell = rejectOwnMove(netMovesRef.current);
        if (cell) {
          engineRef.current.col = cell.col;
          engineRef.current.row = cell.row;
        }
        engineRef.current.path = [];
        engineRef.current.step = null;
        engineRef.current.moveLockUntil = performance.now() + NET_ROLLBACK_LOCK_MS;
      },
      onNoplace: (payload) =>
        setNetStatus(payload?.reason || 'Комната полная (макс. 30). Смените ?room='),
      onDummyState: (state) => {
        // Авторитет сервера: подтверждает optimistic-тумблер и синхронизирует остальных.
        const spr = SPRITES.find((sp) => sp.id === state.sprite)?.id;
        applyDummy(state.on, state.on ? { x: state.x, y: state.y } : null, spr);
        dummyGrabRef.current = state.on ? state.grab || null : null;
      },
      onDummyMove: (pos) => {
        // Чужой тащит манекен: позиция на кадр, скорость сдвига раскачивает «желе».
        const prev = dummyPosRef.current;
        const nowMs = performance.now();
        if (prev) {
          const s0 = settingsRef.current;
          const dist = Math.hypot((pos.x - prev.x) * s0.field.cellW, (pos.y - prev.y) * s0.field.cellH);
          const speed = dist / Math.max(1, nowMs - dummySeenRef.current);
          jellyRef.current[DUMMY_ID] = Math.max(jellyRef.current[DUMMY_ID] ?? 0, Math.min(1, speed / 2.2));
        }
        dummySeenRef.current = nowMs;
        dummyPosRef.current = { x: pos.x, y: pos.y };
      },
      onDummyGrab: (info) => {
        // Обозначение «кто тащит»: курсор с именем игрока над манекеном.
        dummyGrabRef.current = info.login;
      },
      onDummyDrop: () => {
        dummyGrabRef.current = null;
      },
      onRabState: (state) => {
        // Авторитет сервера: подтверждает optimistic-тумблер мишени РАБ.
        applyRab(state.on);
      },
      onAtmo: (info) => {
        // Якорь атмосферы: смена времени суток/погоды/темпа (уходит и тому, кто
        // сменил — эхо-подтверждение) и стартовые часы при входе.
        applyAtmoAnchor(info);
      },
      onRabHit: (info) => {
        // Чужой удар по РАБу — та же анимация, что видит бьющий: качание «желе»
        // и всплывающий урон над мишенью. Свой удар анимируется локально в момент
        // попадания (эхо сервером не возвращается), так что задвоения нет.
        const s = settingsRef.current;
        const e = engineRef.current;
        const zone = s.combat.zones.find((z) => z.id === info.zone);
        const dmg = Math.max(0, Math.round(Number(info.damage) || 0));
        e.labels.push({
          x: RAB_POS.col * s.field.cellW + s.field.cellW / 2,
          y: RAB_POS.row * s.field.cellH + s.field.cellH / 2 - s.field.cellH * 0.35,
          born: performance.now(),
          text: `${info.part || info.zone || 'удар'} -${dmg}%`,
          color: zone?.color || '#ffd60a',
        });
        jellyRef.current[RAB_ID] = 1;
      },
      onClose: (info) => {
        setNetReady(false);
        // При обрыве клиент сам переподключается с backoff и повторным join:
        // движение в это время заблокировано (requestStep), состояние вернут you/field.
        if (info?.retrying) {
          setNetStatus(`Связь потеряна — переподключаемся (попытка ${info.attempt})…`);
        } else {
          setNetStatus('Сокет закрыт. Обновите страницу.');
        }
      },
    });
    setChatLines([]);
    setNetReady(false);
    setMeId(null);
    netRef.current = client;
    // Слушающий режим: без room — join не шлём, ждём выбора комнаты (pickRoom).
    client.connect({
      login,
      sprite: pending?.sprite || settingsRef.current.character.sprite,
    });
    return () => {
      liveRemotesRef.current = [];
      remoteAimRef.current.clear();
      remoteDrawRef.current.clear();
      remoteFreeRef.current.clear();
      remoteFmRef.current.clear();
      battleEntryRef.current = null;
      battleExitRef.current = null;
      entryAnchorRef.current = null;
      fieldFormatRef.current = 'grid';
      setFieldFormat('grid');
      camRef.current.init = false;
      netMovesRef.current = { server: null, pending: [] };
      applyDummy(false, null);
      dummySeenRef.current = 0;
      dummySyncRef.current.at = 0;
      dummyGrabRef.current = null;
      applyRab(false);
      const sync = aimSyncRef.current;
      if (sync.timer) clearTimeout(sync.timer);
      sync.timer = null;
      sync.pending = null;
      client.close();
      netRef.current = null;
    };
  }, [loaded, netStarted, applyNetFight, wantedRoomIds]);

  /** Обновление ?room=/&name= в адресной строке после выбора/смены комнаты: ссылкой
   *  можно вернуться прямо в тот же грот (и имя подставится в пикер персонажа). */
  const shareUrl = useCallback((nextRoom: string, nextName: string) => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('room', nextRoom || 'demo');
      if (nextName) url.searchParams.set('name', nextName);
      else url.searchParams.delete('name');
      history.replaceState(null, '', url);
    } catch {
      /* ignore */
    }
  }, []);

  /**
   * Зайти в выбранный грот: первый вход с экрана выбора или переход из модалки.
   * Сокет уже открыт — join уходит в ту же связь, сервер сам выведет кота из прежней
   * комнаты (комната увидит исчезновение) и заведёт в новую. Состояние комнаты
   * (соседи, манекен, мишень, чат) придёт заново с you/field.
   */
  const pickRoom = useCallback(
    (roomId: string) => {
      const net = netRef.current;
      if (!net) return;
      const pending = pendingJoinRef.current;
      const login = (pending?.login || playerName || nameFromUrl() || '').trim().slice(0, 24);
      const sprite = pending?.sprite || settingsRef.current.character.sprite;
      // Рост модельки, выбранный при спавне: едет в join (size), чтобы комнату
      // видели все с этим ростом, а не только сам игрок.
      const scale = Math.min(100, Math.max(60, Math.round(pending?.scale ?? settingsRef.current.character.spriteScale)));
      pendingJoinRef.current = { room: roomId, login, sprite, scale };
      setChatLines([]);
      setRoomsStale(false);
      setSwitchOpen(false);
      setRoomCode(roomId);
      setPlayerName(login);
      setNetReady(false);
      setNetStatus(`Заходим в ${roomTitle(roomId)}…`);
      shareUrl(roomId, login);
      if (!enteredRef.current) {
        enteredRef.current = true;
        setStage('field');
      }
      net.joinRoom({ room: roomId, login, sprite, size: scale });
    },
    [playerName, shareUrl],
  );

  /** Пока открыт экран входа или модалка смены комнаты — опрашиваем состав гротов.
   *  Сервер отвечает roomsinfo; если дольше 5 с ответа нет — помечаем «данные недоступны». */
  useEffect(() => {
    if (!netStarted || (stage !== 'entry' && !switchOpen)) return;
    setRoomsStale(false);
    const ask = () => netRef.current?.requestRooms(wantedRoomIds());
    ask();
    const iv = setInterval(ask, 2500);
    const staleT = setTimeout(() => setRoomsStale(true), 5000);
    return () => {
      clearInterval(iv);
      clearTimeout(staleT);
    };
  }, [netStarted, stage, switchOpen, wantedRoomIds]);

  /** Скин своего кота уходит в комнату сразу, без повторного входа. */
  useEffect(() => {
    if (!loaded || !netReady) return;
    netRef.current?.emit('sprite', { sprite: settings.character.sprite });
  }, [loaded, netReady, settings.character.sprite]);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(COMBAT_KEY, JSON.stringify(combat));
    } catch {
      /* хранилище может быть недоступно */
    }
  }, [combat, loaded]);

  /* ---------- спрайты ---------- */

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

  /* ---------- геометрия ---------- */

  // При изменении размеров поля — клэмп позиции и очистка вышедших за поле маршрутов
  useEffect(() => {
    const e = engineRef.current;
    const s = settingsRef.current;
    e.col = Math.max(0, Math.min(e.col, s.field.cols - 1));
    e.row = Math.max(0, Math.min(e.row, s.field.rows - 1));
    e.fx = Math.max(0, Math.min(e.fx, s.field.cols - 1));
    e.fy = Math.max(0, Math.min(e.fy, s.field.rows - 1));
    if (mainSavedRef.current) {
      mainSavedRef.current.col = Math.max(0, Math.min(mainSavedRef.current.col, s.field.cols - 1));
      mainSavedRef.current.row = Math.max(0, Math.min(mainSavedRef.current.row, s.field.rows - 1));
    }
    e.path = e.path.filter((p) => p.c < s.field.cols && p.r < s.field.rows);
  }, [settings.field.cols, settings.field.rows, settings.field.cellW, settings.field.cellH]);

  /**
   * Комната «тест»: переход мирная ходьба ↔ боевой режим. Режим включается кнопкой
   * (или B) с клетки захода — тогда привязка идёт к самой клетке захода; страховка
   * (спавн в зоне, правка локации под котом) — к ближайшей боевой клетке. Выход
   * телепортирует кота на клетку захода (battleExitRef), если он стоит в зоне.
   */
  /** Каким был боевой режим на прошлом срабатывании эффекта ниже: отличаем
   *  настоящий выход из боя (телепорт на заход) от простых перерисовок. */
  const prevBattleModeRef = useRef(false);
  /** Принудительное выключение боя на входе в комнату (свежий спавн) — это не
   *  «выход из боя», телепорт на клетку выхода не нужен. */
  const suppressExitTeleportRef = useRef(false);
  useEffect(() => {
    if (fieldFormat !== 'test') return;
    const e = engineRef.current;
    const net = netRef.current;
    e.hover = null;
    const wasBattle = prevBattleModeRef.current;
    prevBattleModeRef.current = settings.arrow.battleMode;
    if (settings.arrow.battleMode) {
      const forced = battleEntryRef.current;
      battleEntryRef.current = null;
      const cell = forced ?? nearestWalkableCell(e.fx, e.fy);
      e.col = cell.c;
      e.row = cell.r;
      e.fx = cell.c;
      e.fy = cell.r;
      e.step = null;
      e.path = [];
      e.ptarget = null;
      netMovesRef.current = { server: { col: cell.c, row: cell.r }, pending: [] };
      net?.emit('cellsync', { x: cell.c + 1, y: cell.r + 1 });
    } else {
      const exit = battleExitRef.current;
      battleExitRef.current = null;
      if (exit) {
        e.col = exit.c;
        e.row = exit.r;
      }
      const skipTeleport = suppressExitTeleportRef.current;
      suppressExitTeleportRef.current = false;
      // Телепорт на клетку выхода — только при настоящем выходе из боя. При
      // простом перерасчёте эффекта (вход в комнату, загрузка настроек) мирную
      // точку не трогаем: сброс в e.col/e.row телепортировал кота, стоящего
      // «в lean» у кромки боевой зоны, внутрь клетки — и страховка сразу
      // вгоняла его в бой (баг «сохранение локации перебрасывает в бой»).
      if (wasBattle && !skipTeleport) {
        e.fx = e.col;
        e.fy = e.row;
      }
      e.step = null;
      e.path = [];
      freeSyncRef.current.moving = false;
      net?.emit('freemove', { x: round2(e.fx), y: round2(e.fy), stop: true });
    }
  }, [fieldFormat, settings.arrow.battleMode]);

  /** Короткая подсказка над полем (гаснет сама). */
  const flashBattleHint = useCallback((text: string) => {
    setBattleHint(text);
    if (battleHintTimerRef.current) clearTimeout(battleHintTimerRef.current);
    battleHintTimerRef.current = setTimeout(() => setBattleHint(null), 3400);
  }, []);
  useEffect(
    () => () => {
      if (battleHintTimerRef.current) clearTimeout(battleHintTimerRef.current);
    },
    [],
  );

  /**
   * Тумблер боя (кнопка в шапке и клавиша B). В «тесте» — правила заходов:
   *  включение — только стоя на клетке захода; выключение на боевой клетке
   *  телепортирует на клетку захода (ту же, через которую вошли). В обычных
   *  комнатах B — прежний прямой тумблер.
   */
  const toggleBattleMode = useCallback(() => {
    if (fieldFormatRef.current !== 'test') {
      setSettings((p) => ({ ...p, arrow: { ...p.arrow, battleMode: !p.arrow.battleMode } }));
      return;
    }
    const s = settingsRef.current;
    if (s.controlled !== 'main') {
      flashBattleHint('Переключить бой можно только управляя своим котом.');
      return;
    }
    const e = engineRef.current;
    if (!s.arrow.battleMode) {
      // Вход в бой: ищем клетку захода под котом (в бою — по клетке, в миру — по точке опоры).
      const hb = peaceHalfBox(s, spritesRef.current[s.character.sprite]);
      const cc = Math.floor(e.fx + hb.dx);
      const cr = Math.floor(e.fy + hb.dy);
      const on = testEntryAt(cc, cr) ? { c: cc, r: cr } : null;
      if (!on) {
        flashBattleHint(
          testEntryStrict()
            ? 'Встаньте на клетку захода (две белые галочки у боевой зоны) и нажмите ещё раз.'
            : 'На локации нет ни одной клетки захода — поставьте её в редакторе рядом с боевой зоной.',
        );
        return;
      }
      battleEntryRef.current = on;
      entryAnchorRef.current = on;
      setSettings((p) => ({ ...p, arrow: { ...p.arrow, battleMode: true } }));
      return;
    }
    // Выход из боя. С клетки захода — просто выйти; с боевой клетки — телепорт на заход.
    if (!testEntryAt(e.col, e.row)) {
      const anchor = entryAnchorRef.current;
      const exit = anchor && testEntryAt(anchor.c, anchor.r) ? anchor : nearestEntryCell(e.col, e.row);
      if (exit) {
        battleExitRef.current = exit;
        entryAnchorRef.current = exit;
        flashBattleHint('Бой выключен — возврат на клетку захода.');
      } else {
        flashBattleHint('Бой выключен. Клеток захода на локации нет — вы на месте.');
      }
    }
    setSettings((p) => ({ ...p, arrow: { ...p.arrow, battleMode: false } }));
  }, [flashBattleHint]);

  const battleToggleRef = useRef<() => void>(() => {});
  useEffect(() => {
    battleToggleRef.current = toggleBattleMode;
  }, [toggleBattleMode]);

  /* ---------- слой атмосферы (PixiJS) ---------- */

  // Слой создаётся один раз на экране поля: Pixi-канвас поверх игрового холста
  // (цветокоррекция времени суток, тени облаков, дождь). Модуль грузим динамически:
  // pixi.js не попадает в основной бандл, а без WebGL игра просто остаётся
  // на чистом 2D-канвасе — без атмосферы, но без ошибок.
  useEffect(() => {
    if (stage !== 'field') return;
    const el = pixiRef.current;
    const worldCv = canvasRef.current;
    if (!el || !worldCv) return;
    let dead = false;
    import('@/lib/sim/atmosphere')
      .then(({ Atmosphere }) => Atmosphere.create(el, worldCv))
      .then((a) => {
        if (dead) {
          a.destroy();
          return;
        }
        atmoRef.current = a;
        a.setDaypart(atmoStateRef.current.dp);
        a.setWeather(atmoStateRef.current.w);
      })
      .catch(() => {
        /* без WebGL — работает прежний 2D-рендер */
      });
    return () => {
      dead = true;
      atmoRef.current?.destroy();
      atmoRef.current = null;
    };
  }, [stage]);

  /* ---------- игровой цикл ---------- */

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let prev = performance.now();

    // Колесо мыши над полем «теста» — зум вида: вверх — приблизить, вниз — отдалить.
    // Множитель живёт в camUserZoomRef, камера сама плавно доезжает до нового зума.
    // В редакторе колесо меняет размер ставящегося объекта (+/− по 0.1), если он есть.
    const onWheelZoom = (ev: WheelEvent) => {
      if (fieldFormatRef.current !== 'test') return;
      if (editorOpenRef.current) {
        const d = editorRef.current;
        // Кисть локации: колесо меняет диаметр круглой кисти (2–200 px, шаг ~10%).
        if (d && d.tool === 'paint') {
          ev.preventDefault();
          const k = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
          d.psize = Math.min(200, Math.max(1, Math.round(d.psize * k)));
          syncEditorView();
          return;
        }
        const p = editorPlaceRef.current;
        if (p) {
          ev.preventDefault();
          const step = ev.deltaY < 0 ? 0.1 : -0.1;
          patchEditorPlace({ s: Math.min(OBJECT_SCALE_MAX, Math.max(OBJECT_SCALE_MIN, Math.round((p.s + step) * 100) / 100)) });
        }
        return;
      }
      if (ev.ctrlKey) return; // пинч-жест оставляем браузеру
      ev.preventDefault();
      const dir = ev.deltaY < 0 ? CAM_USER_ZOOM_STEP : 1 / CAM_USER_ZOOM_STEP;
      const next = Math.min(CAM_USER_ZOOM_MAX, Math.max(CAM_USER_ZOOM_MIN, camUserZoomRef.current * dir));
      camUserZoomRef.current = next;
    };
    cv.addEventListener('wheel', onWheelZoom, { passive: false });

    // Флаги редактора обновляются каждый кадр: update и draw видят одно и то же.
    const editorState = () => ({
      on: editorOpenRef.current && editorRef.current !== null,
      draft: editorRef.current,
    });

    /** Прогноз посадки прыжка с данным зарядом (0.15..1): мирный режим ищет точку
     *  вдоль направления бега или — если есть прицел — к точке под мышкой
     *  (игрок сам выбирает дистанцию, максимум — три клетки), боевой — клетки
     *  вдоль стрелы. Один и тот же поиск работает и на сам прыжок
     *  (consumeLeapRequest в update), и на маркер посадки в отрисовке: во время
     *  приседа-заряда и полёта видно, куда кот приземлится, в том числе на
     *  возвышенности и вниз с обрыва (маркер лежит на поднятой земле).
     *  aim — точка курсора в px мира (уже с поправкой на подъём земли).
     *  sx/sy — точка опоры (низ-центр модельки) в клеточных долях; l1 — подъём
     *  земли в точке посадки (px мира). */
    const leapLandingAt = (
      charge: number,
      aim?: { x: number; y: number } | null,
    ): { sx: number; sy: number; x1: number; y1: number; l1: number; dur: number; zH: number; deg: number; battle: boolean; cell: { c: number; r: number } | null } | null => {
      const s = settingsRef.current;
      const e = engineRef.current;
      const testMode = fieldFormatRef.current === 'test';
      const editorOn = editorState().on;
      if (e.leap || e.blocking) return null;
      if (performance.now() < e.moveLockUntil) return null;
      if (!testMode || editorOn) return null; // вне «теста» и в редакторе — только желейный присед
      if (s.controlled !== 'main') return null; // прыгает только свой кот под управлением
      // Перепад, который берёт заряд: тап уже закидывает на уступ в 1 уровень
      // (раньше тап был бессилен — кот «упирался в стенку»), полный заряд — 3.
      const maxDrop = 1 + Math.min(TERRAIN_MAX_LEVEL - 1, Math.floor(charge * 2.99)); // 1..3
      if (!s.arrow.battleMode) {
        const hb = peaceHalfBox(s, spritesRef.current[s.character.sprite]);
        const ax = e.fx + hb.dx;
        const ay = e.fy + hb.dy * 2; // точка опоры (низ-центр модельки)
        const curLevel = elevLevelAt(Math.floor(ax), Math.floor(ay));
        // направление: к прицелу (если курсор на поле), иначе — последнее
        // направление бега, без него — куда смотрит моделька
        let deg: number;
        if (aim) {
          const adx = (aim.x / s.field.cellW - ax) * s.field.cellW;
          const ady = (aim.y / s.field.cellH - ay) * s.field.cellH;
          if (Math.hypot(adx, ady) >= 4) deg = wrap360((Math.atan2(ady, adx) * 180) / Math.PI);
          else deg = e.lastDir ?? (e.face === -1 ? 0 : 180);
        } else {
          deg = e.lastDir ?? (e.face === -1 ? 0 : 180);
        }
        const rad = (deg * Math.PI) / 180;
        const wl = Math.hypot(Math.cos(rad) * s.field.cellW, Math.sin(rad) * s.field.cellH) || 1;
        const ux = (Math.cos(rad) * s.field.cellW) / wl;
        const uy = (Math.sin(rad) * s.field.cellH) / wl;
        // Дальность выбирает игрок прицелом (до трёх клеток); без прицела —
        // как раньше, из заряда (тап ≈ полторы клетки, полный заряд — три).
        const maxCells = aim
          ? Math.min(3, Math.max(0.3, Math.hypot(aim.x / s.field.cellW - ax, aim.y / s.field.cellH - ay)))
          : 1.25 + charge * 1.75;
        const strict = testEntryStrict();
        let bestD = 0;
        let bestLvl = curLevel;
        for (let d = maxCells; d >= 0.3; d -= 0.05) {
          const px = ax + ux * d;
          const py = ay + uy * d;
          if (!testPeacePointFree(px, py)) continue;
          if (!testPeaceObjectsFree(px, py, s.field.cellW, s.field.cellH)) continue;
          // со строгими заходами посадка на боевых клетках заперта (как и ходьба)
          if (strict && testPeaceBattleBlocked(px, py)) continue;
          const lvl = elevLevelAt(Math.floor(px), Math.floor(py));
          if (Math.abs(lvl - curLevel) > maxDrop) continue;
          bestD = d;
          bestLvl = lvl;
          break;
        }
        if (bestD < 0.3) return null; // садиться некуда — остаётся присед-желе на месте
        return {
          sx: ax + ux * bestD,
          sy: ay + uy * bestD,
          x1: ax + ux * bestD - hb.dx,
          y1: ay + uy * bestD - hb.dy * 2,
          l1: bestLvl * TERRAIN_LIFT_PX,
          dur: 340 + bestD * 130,
          zH: 22 + bestD * 18 + Math.abs(bestLvl - curLevel) * 10,
          deg,
          battle: false,
          cell: null,
        };
      }
      // Боевой режим «теста»: прыжок по прямой вдоль стрелы (8 направлений),
      // через непроходимые/высокие промежуточные клетки. Сеть обязательна:
      // клетку подтверждает сервер (событие jump — зеркальные проверки).
      const net = netRef.current;
      if (!net?.ready) return null;
      const book = netMovesRef.current;
      if (book.pending.length > 0 || !book.server) return null;
      const deg8 = (Math.round(wrap360(e.angle) / 45) * 45) % 360;
      const d8 = dirByDeg(deg8);
      const maxR = 1 + Math.round(charge * 2); // 1..3 клетки
      const fromEntry = !!testEntryAt(e.col, e.row);
      const curL = elevLevelAt(e.col, e.row);
      for (let r = maxR; r >= 1; r--) {
        const tc = e.col + d8.dx * r;
        const tr = e.row + d8.dy * r;
        if (tc < 0 || tc >= s.field.cols || tr < 0 || tr >= s.field.rows) continue;
        if (!testWalkableCell(tc, tr) && !testEntryAt(tc, tr)) continue;
        if (isBlockedCell(s, 'main', null, tc, tr, liveRemotesRef.current, objectExtras())) continue;
        const toEntry = !!testEntryAt(tc, tr);
        if (!fromEntry && !toEntry && Math.abs(elevLevelAt(tc, tr) - curL) > maxDrop) continue;
        return {
          sx: tc + 0.5,
          sy: tr + 0.5,
          x1: tc * s.field.cellW,
          y1: tr * s.field.cellH,
          l1: elevLevelAt(tc, tr) * TERRAIN_LIFT_PX,
          dur: 300 + r * 90,
          zH: 26 + r * 14 + Math.abs(elevLevelAt(tc, tr) - curL) * 10,
          deg: deg8,
          battle: true,
          cell: { c: tc, r: tr },
        };
      }
      return null;
    };

    const update = (now: number, dt: number) => {
      stepRemoteDraws(liveRemotesRef.current, remoteDrawRef.current, now);
      const s = settingsRef.current;
      const e = engineRef.current;
      // Комната «тест» и мирный режим: свободная ходьба по всей локации вместо клеток.
      // В редакторе ходьба останавливается: кот стоит на месте, мышь рисует зоны.
      const testMode = fieldFormatRef.current === 'test';
      const editorOn = editorState().on;
      const peaceWalk = testMode && !s.arrow.battleMode && s.controlled === 'main' && !editorOn;
      // Блок (удержание К): двигаться, крутить стрелу и бить нельзя. Гасим всё,
      // что могло прийти, пока блок держится (цель клика, удержания).
      if (e.blocking) {
        e.held = [];
        e.path = [];
        e.ptarget = null;
        e.rot = 0;
        e.strikeHeld = false;
        e.step = null;
      }

      /* ---------- прыжок через обрыв ---------- */

      /** Забрать запрос прыжка (заряд 0.15..1 из отпускания Пробела) и запустить
       *  рывок: мирный — к точке под мышкой (если курсор на поле; она и есть
       *  конечная точка прыжка, игрок сам выбирает дистанцию) или вдоль
       *  направления бега, боевой — по клеткам вдоль стрелы. */
      const consumeLeapRequest = () => {
        const charge = leapRequestRef.current;
        leapRequestRef.current = null;
        if (charge == null || e.leap || e.blocking) return;
        if (performance.now() < e.moveLockUntil) return;
        if (!testMode || editorOn) return; // вне «теста» и в редакторе — только желейный присед
        if (s.controlled !== 'main') return; // прыгает только свой кот под управлением
        // Прицел мышкой: мирная точка посадки — под курсором (в пределах максимума);
        // в бою прицел не участвует — там рулит стрела и серверные клетки.
        const aimCursor = !s.arrow.battleMode ? cursorWorldRef.current : null;
        const land = leapLandingAt(charge, aimCursor);
        if (!land) return; // садиться некуда — остаётся присед-желе на месте
        if (!land.battle) {
          e.leap = {
            battle: false,
            t0: now,
            dur: land.dur,
            x0: e.fx,
            y0: e.fy,
            x1: land.x1,
            y1: land.y1,
            l0: e.liftV,
            l1: land.l1,
            zH: land.zH,
          };
          e.lastDir = (Math.round(wrap360(land.deg) / 45) * 45) % 360;
          e.ptarget = null;
          e.path = [];
          e.pvx = 0;
          e.pvy = 0;
          return;
        }
        const net = netRef.current;
        if (!net?.ready) return;
        const book = netMovesRef.current;
        const tc = land.cell!.c;
        const tr = land.cell!.r;
        net.emit('jump', { x: tc + 1, y: tr + 1, deg: Math.round(wrap360(e.angle) * 10) / 10 });
        book.pending.push({ col: tc, row: tr });
        e.leap = {
          battle: true,
          t0: now,
          dur: land.dur,
          x0: e.col * s.field.cellW,
          y0: e.row * s.field.cellH,
          x1: land.x1,
          y1: land.y1,
          l0: elevLevelAt(e.col, e.row) * TERRAIN_LIFT_PX,
          l1: land.l1,
          zH: land.zH,
        };
        e.col = tc;
        e.row = tr;
        e.step = { dir: land.deg, sd: 0, start: now, dur: 430 }; // длинный кулдаун прыжка
        e.lastDir = land.deg;
        e.path = [];
      };
      consumeLeapRequest();

      /** Дуга прыжка: позиция/высота на кадр; мирный режим ещё и шлёт freemove (jp=1). */
      const stepLeap = () => {
        const lp = e.leap;
        if (!lp) {
          e.leapZ = 0;
          return;
        }
        const t = (now - lp.t0) / lp.dur;
        if (t >= 1) {
          if (!lp.battle) {
            e.fx = lp.x1;
            e.fy = lp.y1;
            const net = netRef.current;
            if (net?.ready) net.emit('freemove', { x: round2(e.fx), y: round2(e.fy), stop: true });
            freeSyncRef.current.moving = false;
          }
          e.leap = null;
          e.leapZ = 0;
          return;
        }
        if (!lp.battle) {
          e.fx = lp.x0 + (lp.x1 - lp.x0) * t;
          e.fy = lp.y0 + (lp.y1 - lp.y0) * t;
          e.liftV = lp.l0 + (lp.l1 - lp.l0) * t;
          const net = netRef.current;
          if (net?.ready && now - freeSyncRef.current.at >= FREE_EMIT_MS) {
            freeSyncRef.current.at = now;
            net.emit('freemove', { x: round2(e.fx), y: round2(e.fy), jp: 1 });
          }
          freeSyncRef.current.moving = true;
        }
        e.leapZ = Math.sin(Math.PI * t) * lp.zH;
      };
      stepLeap();

      /** Сглаженный подъём земли под своим котом: цель — уровень его клетки
       *  (в бою) или точки опоры (в миру). Шаг на уступ поднимает модельку
       *  плавно, а не скачком; в прыжке высоту ведёт сама дуга. */
      if (!e.leap) {
        const hbL = peaceHalfBox(s, spritesRef.current[s.character.sprite]);
        const targetLift = testMode
          ? (s.arrow.battleMode
              ? elevLevelAt(e.col, e.row)
              : elevLevelAt(Math.floor(e.fx + hbL.dx), Math.floor(e.fy + hbL.dy * 2))) * TERRAIN_LIFT_PX
          : 0;
        e.liftV += (targetLift - e.liftV) * (1 - Math.exp(-dt / 110));
        if (Math.abs(targetLift - e.liftV) < 0.4) e.liftV = targetLift;
      }

      const cx = (c: number) => c * s.field.cellW + s.field.cellW / 2;
      const cy = (r: number) => r * s.field.cellH + s.field.cellH / 2;

      const beginStep = (dirDeg: number, tc: number, tr: number) => {
        const sd = slowdownFor(dirDeg, e.angle, s);
        const dur = stepDuration(s.character.stepMs, sd);
        // мгновенное перемещение: персонаж сразу оказывается в целевой клетке,
        // длительность шага работает как кулдаун до следующего прыжка
        e.col = tc;
        e.row = tr;
        e.step = { dir: dirDeg, sd, start: now, dur };
        e.lastDir = dirDeg;
        e.lastSpeed = speedFor(sd);
        if (s.slowdown.showStepLabel) {
          e.labels.push({
            x: cx(tc),
            y: cy(tr) - s.field.cellH * 0.75,
            born: now,
            text: `${speedFor(sd)}%`,
            color: tierColor(sd),
          });
        }
      };

      // старт шага из обработчика клавиш: первое нажатие срабатывает сразу, но новый
      // шаг начинается только после завершения кулдауна предыдущего — правила замедления
      // действуют всегда, и спам кнопок не может их «пересилить»
      const requestStep = (dirDeg: number, tc: number, tr: number) => {
        if (s.controlled === 'main') {
          const net = netRef.current;
          // В комнате без связи шагов нет: локальное движение превратило бы кота
          // в «зомби», которого никто, кроме нас, не видит.
          if (!net?.ready) return 'blocked';
          const book = netMovesRef.current;
          // Пока сервер не назвал клетку, шаг не рисуем: иначе «you» вернёт кота на спавн.
          if (!book.server) return 'wait';
          // Один неподтверждённый шаг: следующий не отправляем и не рисуем, пока
          // сервер не подтвердил предыдущий. Иначе при гонке за клетку предикт
          // разъезжался с сервером на клетку, и отказ возвращал кота «куда-то
          // рядом» — выглядело как вытеснение его другим игроком.
          if (book.pending.length > 0) return 'wait';
          const dd = dirByDeg(dirDeg);
          const deg = Math.round(wrap360(e.angle) * 10) / 10;
          net.emit('move', { x: dd.dx, y: dd.dy, deg });
          const sync = aimSyncRef.current;
          if (sync.timer) {
            clearTimeout(sync.timer);
            sync.timer = null;
          }
          sync.pending = null;
          sync.deg = deg;
          sync.at = performance.now();
          // Клетка на экране меняется сразу. Сервер остаётся источником правды:
          // подтверждение снимет шаг с очереди, отказ вернёт на book.server.
          book.pending.push({ col: tc, row: tr });
          beginStep(dirDeg, tc, tr);
          return 'net';
        }
        beginStep(dirDeg, tc, tr);
        return 'local';
      };

      /** План боевого шага «теста»/поля: на клетке захода ЛЮБАЯ клавиша переносит
       *  кота по направлению захода (в боевую зону — «после шага»), иначе — шаг в
       *  соседнюю клетку по клавише. Из боевой зоны шаг «в траву» возможен только
       *  на клетку захода (обратный выход); при открытой логике (на локации нет
       *  ни одного захода) трава выключает бой, как раньше. null — шаг запрещён. */
      const planBattleStep = (dir: number): { tc: number; tr: number; deg: number } | null => {
        const self = s.controlled;
        const mp = self === 'main' ? null : mainSavedRef.current;
        const entry = testMode ? testEntryAt(e.col, e.row) : null;
        let dx: number;
        let dy: number;
        let deg: number;
        if (entry?.dir) {
          const dv = entryDirDelta(entry.dir);
          dx = dv.dx;
          dy = dv.dy;
          deg = dv.dx === 1 ? 0 : dv.dx === -1 ? 180 : dv.dy === 1 ? 90 : 270;
        } else {
          const d = dirByDeg(dir);
          dx = d.dx;
          dy = d.dy;
          deg = d.deg;
        }
        const tc = e.col + dx;
        const tr = e.row + dy;
        // клетки остальных персонажей — физические препятствия: шагнуть в них нельзя
        if (isBlockedCell(s, self, mp, tc, tr, liveRemotesRef.current, objectExtras())) return null;
        if (tc < 0 || tc >= s.field.cols || tr < 0 || tr >= s.field.rows) return null;
        if (testMode && !testWalkableCell(tc, tr)) {
          if (testEntryAt(tc, tr)) {
            // шаг на клетку захода — легальный путь из зоны (или на неё с травы)
          } else if (!testEntryStrict()) {
            // открытая логика: за клетками трава — выход в мирный режим,
            // зажатая клавиша унесёт кота по пикселям
            if (!testPointInCellsZone(tc + 0.5, tr + 0.5) && testPointInIsland(tc + 0.5, tr + 0.5)) {
              inZonePrevRef.current = true;
              setSettings((p) => ({ ...p, arrow: { ...p.arrow, battleMode: false } }));
            }
            return null;
          } else {
            // строгий режим: из боевой зоны наружу — только через клетку захода
            return null;
          }
        }
        // обрыв: перепад высот больше 1 шагом не проходится (переходы через
        // клетку захода перепадом не считаются — сервер проверяет так же).
        // Большой перепад перепрыгивается зарядом Пробела.
        if (
          testMode &&
          !entry?.dir &&
          !testEntryAt(tc, tr) &&
          Math.abs(elevLevelAt(tc, tr) - elevLevelAt(e.col, e.row)) > 1
        ) {
          return null;
        }
        return { tc, tr, deg };
      };

      startStepRef.current = (dir: number) => {
        if (peaceWalk) return; // в мирном «тесте» движение свободное, шаги по клеткам отключены
        if (e.step) return; // предыдущий шаг ещё в кулдауне — спам не ускоряет движение
        if (performance.now() < e.moveLockUntil) return; // только что был откат — даём серверу догнать
        const plan = planBattleStep(dir);
        if (!plan) return;
        // Шаг с захода в зону запоминаем: выключение боя вернёт кота на этот же заход.
        if (testMode && testEntryAt(e.col, e.row)?.dir) entryAnchorRef.current = { c: e.col, r: e.row };
        requestStep(plan.deg, plan.tc, plan.tr);
      };

      // ручное вращение стрелы: J — против часовой, L — по часовой.
      // Угол считается от «якоря» по абсолютному времени кадра, а не суммой приращений:
      // затянутые/пропущенные кадры (перерисовки, сборка мусора) больше не тормозят
      // и не дёргают стрелу — она всегда стоит ровно на своём угле.
      if (e.rot !== 0) {
        if (e.rotActive !== e.rot || e.rotPeriod !== s.arrow.periodSec) {
          e.rotActive = e.rot;
          e.rotPeriod = s.arrow.periodSec;
          e.rotBase = e.angle;
          e.rotBaseT = now;
        }
        if (s.arrow.battleMode) {
          e.angle = wrap360(
            e.rotBase + e.rot * ((now - e.rotBaseT) / 1000) * (360 / Math.max(0.1, s.arrow.periodSec)),
          );
          publishAimRef.current(e.angle, false);
        } else {
          e.rotActive = 0; // в мирном режиме вращение недоступно
        }
      } else if (e.rotActive !== 0) {
        e.rotActive = 0;
        publishAimRef.current(e.angle, true);
      }

      // старт шага при удержании клавиш движения / маршрут по клику: следующий шаг
      // начинается сразу после кулдауна предыдущего, то есть удержание движется
      // с интервалом stepMs (120 мс по умолчанию), растянутым замедлением.
      // В мирном «тесте» вместо этого — свободная ходьба (ниже).
      if (!peaceWalk && !e.step) {
        const self = s.controlled;
        const mp = self === 'main' ? null : mainSavedRef.current;
        // С клетки захода маршрут по клику не ведётся: оттуда один шаг —
        // по направлению захода (перенос в боевую зону).
        if (testMode && testEntryAt(e.col, e.row)) e.path = [];
        if (e.held.length > 0) {
          const plan = planBattleStep(e.held[e.held.length - 1]);
          if (plan) {
            if (testMode && testEntryAt(e.col, e.row)?.dir) entryAnchorRef.current = { c: e.col, r: e.row };
            requestStep(plan.deg, plan.tc, plan.tr);
          }
        } else if (e.path.length > 0) {
          const nx = e.path[0];
          const d = DIRECTIONS.find((q) => q.dx === Math.sign(nx.c - e.col) && q.dy === Math.sign(nx.r - e.row));
          const cliffAhead =
            testMode &&
            !testEntryAt(e.col, e.row) &&
            !testEntryAt(nx.c, nx.r) &&
            Math.abs(elevLevelAt(nx.c, nx.r) - elevLevelAt(e.col, e.row)) > 1;
          if (
            d &&
            nx.c === e.col + d.dx &&
            nx.r === e.row + d.dy &&
            !isBlockedCell(s, self, mp, nx.c, nx.r, liveRemotesRef.current, objectExtras()) &&
            !cliffAhead &&
            (!testMode || testWalkableCell(nx.c, nx.r) || !!testEntryAt(nx.c, nx.r))
          ) {
            const mode = requestStep(d.deg, nx.c, nx.r);
            if (mode === 'local' || mode === 'net') e.path.shift();
          } else {
            e.path = []; // маршрут упёрся в обрыв/занятую клетку — переложить заново
          }
        }
      }

      // «Тест», мирный режим: свободная ходьба по пикселям. Привязки к клеткам и
      // якорным точкам нет: зажатые клавиши двигают кота по всем направлениям ровно
      // столько, сколько держат; клик пускает ходьбу до точки (прямой линией,
      // стены обкатываются скольжением по осям). Препятствия: кромка локации,
      // камни/деревья, клетки остальных котов и обрывы рельефа (перепад больше
      // 1 — только прыжком). В прыжке обычная ходьба выключена: позицией ведёт
      // дуга (stepLeap). Вход в боевую зону переключает режим — см. ниже.
      if (peaceWalk && !e.leap) {
        const net = netRef.current;
        const cellW = s.field.cellW;
        const cellH = s.field.cellH;
        const hb = peaceHalfBox(s, spritesRef.current[s.character.sprite]);
        // вектор направления: зажатые клавиши (8 направлений) или цель клика
        let vx = 0;
        let vy = 0;
        for (const dir of e.held) {
          const d = dirByDeg(dir);
          vx += d.dx;
          vy += d.dy;
        }
        if (vx !== 0 || vy !== 0) e.ptarget = null; // клавиши перебивают клик-цель
        if ((vx === 0 && vy === 0) && e.ptarget) {
          const dx = e.ptarget.x - e.fx;
          const dy = e.ptarget.y - e.fy;
          const distPx = Math.hypot(dx * cellW, dy * cellH);
          if (distPx <= 3) {
            e.ptarget = null; // дошли
          } else {
            vx = dx;
            vy = dy;
            // нет прогресса (упёрлись в стену) — отменяем цель
            if (distPx >= e.ptarget.lastD - 0.5) {
              e.ptarget.stuck += dt;
              if (e.ptarget.stuck >= PEACE_STUCK_MS) e.ptarget = null;
            } else {
              e.ptarget.stuck = 0;
              e.ptarget.lastD = distPx;
            }
          }
        }
        const sprint = sprintRef.current;
        // Инерция мирной ходьбы: скорость приближается к желаемой — на разгоне
        // быстро (полсотни мс), на выбегании плавно: кот не встаёт как вкопанный,
        // а мягко докатывается. После спринта выбегание дольше — инерция заметнее.
        const hasInput = vx !== 0 || vy !== 0;
        const tSpd = (s.character.peaceSpeed || PEACE_SPEED_DEFAULT) * (sprint ? SPRINT_MULT : 1);
        let tvx = 0;
        let tvy = 0;
        if (hasInput) {
          const wxI = vx * cellW;
          const wyI = vy * cellH;
          const lenI = Math.hypot(wxI, wyI) || 1;
          tvx = (wxI / lenI) * tSpd;
          tvy = (wyI / lenI) * tSpd;
        }
        const tau = hasInput ? 45 : now - e.lastSprint < 280 ? 300 : 180;
        const kv = 1 - Math.exp(-dt / tau);
        e.pvx += (tvx - e.pvx) * kv;
        e.pvy += (tvy - e.pvy) * kv;
        if (!hasInput && Math.hypot(e.pvx, e.pvy) < 6) {
          e.pvx = 0;
          e.pvy = 0;
        }
        const moving = hasInput || Math.hypot(e.pvx, e.pvy) > 6;
        if (moving) {
          // шаг кадра — из текущей скорости (px/с → клеточные доли по осям);
          // по вертикали делим ещё и на сжатие земли — экранный шаг равномерный
          const stepFx = (e.pvx * dt) / 1000 / cellW;
          const stepFy = ((e.pvy * dt) / 1000 / cellH) / Math.max(0.5, camFxRef.current.sq);
          // разворот «лицом» по направлению ходьбы (для бейджа и привычки глаза)
          if (hasInput) {
            const wx = vx * cellW;
            const wy = vy * cellH;
            const len = Math.hypot(wx, wy) || 1;
            const deg = wrap360((Math.atan2(wy, wx) * 180) / Math.PI);
            e.lastDir = (Math.round(deg / 45) * 45) % 360;
          }
          // столкновения с раздельной проверкой осей: у стены кот скользит вдоль неё.
          // Со строгими заходами боевые клетки заперты и для мирной ходьбы —
          // случайно забежать в зону нельзя (вход — только через клетку захода).
          // Препятствия (камень/дерево) — по точке опоры и их настоящим размерам:
          // тело спрайта у земли, не вся клетка — свободную часть клетки можно
          // обходить (см. testPeaceObjectsFree).
          // Соседи — тоже физические тела: у мирного кота круг у земли, радиус
          // растёт вместе с ростом модельки (scale), поэтому наложиться друг на
          // друга игроки не могут ни при каком росте. Боевые коты (fm=0) и общие
          // предметы комнаты остаются клеточными препятствиями: их клетки
          // раздаёт сервер, там наложений нет и так.
          const strictEntries = testEntryStrict();
          const others = othersOf(s, s.controlled, mainSavedRef.current, liveRemotesRef.current, objectExtras());
          const bodies: { x: number; y: number; r: number; cell: { col: number; row: number } | null }[] = [];
          for (const t of others) {
            const key = t.id.startsWith('p') ? t.id : null;
            const fr = key ? remoteFreeRef.current.get(key) : undefined;
            if (key && fr && remoteFmRef.current.get(key) === 1) {
              // мирный сосед: тело — круг у точки опоры его модельки
              const imgT = spritesRef.current[t.sprite];
              const aspectT = imgT && imgT.height > 0 ? imgT.width / imgT.height : 2 / 3;
              const boxT = spriteBoxOf(s, aspectT, 0, 0, t.scale);
              bodies.push({ x: fr.x * cellW + boxT.w / 2, y: fr.y * cellH + boxT.h, r: peaceBodyRadius(boxT.w), cell: null });
            } else {
              bodies.push({ x: 0, y: 0, r: 0, cell: { col: t.col, row: t.row } });
            }
          }
          const myR = peaceBodyRadius(hb.dx * 2 * cellW);
          // Обрывы рельефа: перепад между клеткой точки опоры и целевой больше 1 —
          // стенка (шаг на уступ в 1 уровень — обычный шаг). В прыжке правило
          // отключено: дуга несёт кота через обрыв. Выталкивание ходит через тот
          // же blocked, поэтому мягкое выталкивание не закинет кота на скалу.
          const elevWalkBlocked = (fxT: number, fyT: number): boolean =>
            Math.abs(
              elevLevelAt(Math.floor(fxT + hb.dx), Math.floor(fyT + hb.dy * 2)) -
                elevLevelAt(Math.floor(e.fx + hb.dx), Math.floor(e.fy + hb.dy * 2)),
            ) > 1;
          // Стенка боевых зон для мирной ходьбы — по глубине внутри зоны вдоль оси
          // движения. По горизонтали стенка на кромке (depth > 0 нельзя), по вертикали
          // центр может углубиться на PEACE_BATTLE_LEAN_Y: перспектива сжимает землю,
          // и без этого видимый заход сверху/снизу заметно мельче бокового.
          const battleWall = (fxT: number, fyT: number, axis: 'x' | 'y') =>
            strictEntries && testPeaceBattleDepth(fxT, fyT, axis) > (axis === 'y' ? PEACE_BATTLE_LEAN_Y : 0);
          const blocked = (fxT: number, fyT: number, axis: 'x' | 'y') => {
            const px = fxT + hb.dx;
            const py = fyT + hb.dy;
            if (!testPeacePointFree(px, py)) return true;
            if (battleWall(px, py, axis)) return true;
            if (elevWalkBlocked(fxT, fyT)) return true;
            if (!testPeaceObjectsFree(fxT + hb.dx, fyT + hb.dy * 2, cellW, cellH)) return true;
            const feetX = (fxT + hb.dx) * cellW;
            const feetY = (fyT + hb.dy * 2) * cellH;
            for (const b of bodies) {
              if (b.cell) {
                if (px >= b.cell.col && px <= b.cell.col + 1 && py >= b.cell.row && py <= b.cell.row + 1) return true;
              } else {
                const rr2 = (myR + b.r) * 0.92;
                if ((feetX - b.x) * (feetX - b.x) + (feetY - b.y) * (feetY - b.y) < rr2 * rr2) return true;
              }
            }
            return false;
          };
          const nxT = e.fx + stepFx;
          const nyT = e.fy + stepFy;
          if (!blocked(nxT, e.fy, 'x')) e.fx = nxT;
          else e.pvx = 0; // упёрлись — инерция по оси гасится, скольжение продолжается
          if (!blocked(e.fx, nyT, 'y')) e.fy = nyT;
          else e.pvy = 0;
          // Расталкивание: если тела уже пересекаются (спавн рядом, телепорт с
          // клетки захода, правка локации под котами) — мягко выталкиваем своего
          // кота из чужого тела вдоль линии центров, по осям и с проверкой blocked,
          // чтобы выталкивание не закинуло кота в кромку или препятствие.
          for (const b of bodies) {
            if (b.cell || b.r <= 0) continue;
            const ddx = (e.fx + hb.dx) * cellW - b.x;
            const ddy = (e.fy + hb.dy * 2) * cellH - b.y;
            const dist = Math.hypot(ddx, ddy);
            const min = (myR + b.r) * 1.02;
            if (dist >= min || dist === 0) continue;
            const k = (min - dist) / dist;
            const pushFx = (ddx * k) / cellW;
            const pushFy = (ddy * k) / cellH;
            if (!blocked(e.fx + pushFx, e.fy, 'x')) e.fx += pushFx;
            if (!blocked(e.fx, e.fy + pushFy, 'y')) e.fy += pushFy;
          }
          // спринтим — копим темп и рождаем комочки земли/травы из-под лап:
          // летят против бега веером, гравитация гасит (физика и рисование ниже)
          if (sprint) {
            e.lastSprint = now;
            sprintAccRef.current += dt;
            const feetX = (e.fx + hb.dx) * cellW;
            const feetY = (e.fy + hb.dy * 2) * cellH;
            const spdNow = Math.hypot(e.pvx, e.pvy) || 1;
            const bdx = e.pvx / spdNow;
            const bdy = e.pvy / spdNow;
            while (sprintAccRef.current >= SPRINT_SPAWN_MS) {
              sprintAccRef.current -= SPRINT_SPAWN_MS;
              spawnSprintPart(sprintPartsRef.current, feetX, feetY, bdx, bdy);
            }
          } else {
            sprintAccRef.current = 0;
          }
          // Флип «лицом» по горизонтали бега: спрайты котов смотрят влево «как
          // нарисованы», поэтому бег вправо зеркалит модельку (flip=-1), бег влево —
          // нет. Разворот триггерит лёгкое «желе» — качнётся и успокоится (см.
          // drawChar). Чисто локальная картинка, по сети не ходит.
          if (e.pvx > 14 || e.pvx < -14) {
            const f: 1 | -1 = e.pvx > 0 ? -1 : 1;
            if (f !== e.face) {
              e.face = f;
              jellyRef.current.main = Math.max(jellyRef.current.main ?? 0, 0.5);
            }
          }
          freeSyncRef.current.moving = true;
          if (net?.ready && now - freeSyncRef.current.at >= FREE_EMIT_MS) {
            freeSyncRef.current.at = now;
            // sp — флаг спринта: чужие клиенты рисуют комочки из-под лап этого кота
            net.emit('freemove', { x: round2(e.fx), y: round2(e.fy), sp: sprint ? 1 : 0 });
          }
        } else if (freeSyncRef.current.moving) {
          e.pvx = 0;
          e.pvy = 0;
          freeSyncRef.current.moving = false;
          net?.emit('freemove', { x: round2(e.fx), y: round2(e.fy), stop: true });
        }
      }

      // Физика частиц спринта (даже когда бег кончился — комочки в полёте):
      // полёт по инерции, гравитация тянет вниз, приземлившиеся и отжившие — долой.
      const parts = sprintPartsRef.current;
      if (parts.length > 0) {
        const dts = dt / 1000;
        let alive = 0;
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          p.life += dt;
          if (p.life >= p.ttl) continue;
          p.x += p.vx * dts;
          p.y += p.vy * dts;
          p.z += p.vz * dts;
          p.vz -= SPRINT_GRAVITY * dts;
          if (p.z <= 0) continue; // приземлился в траву
          parts[alive++] = p;
        }
        parts.length = alive;
      }

      // Режим «теста» — страховка от «не туда»: бой включается кнопкой с клетки
      // захода, поэтому здесь остаются только аварийные случаи (спавн в зоне,
      // правка локации под котом): мирный кот на боевой клетке — бой включается,
      // боевой кот вне зоны и вне захода — выключается. Стоя на заходе, кот
      // волен быть в любом режиме — это законная точка обоих миров.
      // В прыжке проверка выключена: дуга летит над зоной/обрывом, не по земле.
      if (testMode && !editorOn && s.controlled === 'main' && !e.leap) {
        const hbR = peaceHalfBox(s, spritesRef.current[s.character.sprite]);
        const ccR = s.arrow.battleMode ? e.col : Math.floor(e.fx + hbR.dx);
        const crR = s.arrow.battleMode ? e.row : Math.floor(e.fy + hbR.dy);
        const onBattle = testWalkableCell(ccR, crR);
        // Мирный кот у кромки теперь легально углубляется центром на
        // PEACE_BATTLE_LEAN_Y (компенсация перспективы) — аварией считаем только
        // кота в глубине зоны: боевые и чуть выше, и чуть ниже центра. Кот у самой
        // кромки от такой проверки бой не ловит, а заброшенный в середину зоны — да.
        const deepInBattle =
          testWalkableCell(ccR, Math.floor(e.fy + hbR.dy - 0.25)) &&
          testWalkableCell(ccR, Math.floor(e.fy + hbR.dy + 0.25));
        const onEntry = !!testEntryAt(ccR, crR);
        if (!s.arrow.battleMode && deepInBattle && !onEntry) {
          inZonePrevRef.current = true;
          e.ptarget = null;
          setSettings((p) => ({ ...p, arrow: { ...p.arrow, battleMode: true } }));
        } else if (s.arrow.battleMode && !onBattle && !onEntry) {
          inZonePrevRef.current = false;
          setSettings((p) => ({ ...p, arrow: { ...p.arrow, battleMode: false } }));
        } else {
          inZonePrevRef.current = onBattle;
        }
      }

      // Чужие коты в свободной ходьбе («тест»): плавное доведение до последней позиции;
      // попутно ловим флип — чужая моделька разворачивается по горизонтали их бега
      // (с лёгким «желе», локально, как у своего кота).
      if (remoteFreeRef.current.size > 0) {
        const kf = 1 - Math.exp(-dt / 80);
        for (const [idF, fr] of remoteFreeRef.current) {
          const before = fr.x;
          fr.x += (fr.tx - fr.x) * kf;
          fr.y += (fr.ty - fr.y) * kf;
          if (fr.tx - before > 0.015 || fr.tx - before < -0.015) {
            // Чужой кот бежит вправо — зеркалим (flip=-1), влево — как нарисован (1).
            const f: 1 | -1 = fr.tx >= before ? -1 : 1;
            if (f !== (fr.face ?? 1)) {
              fr.face = f;
              jellyRef.current[idF] = Math.max(jellyRef.current[idF] ?? 0, 0.4);
            }
          }
        }
      }

      // Чужой спринт: комочки земли/травы из-под лап котов с флагом sp (freemove).
      // Позиция — текущая доведённая (экранная), направление — к цели доведения;
      // темп тот же, что у своего спринта (~1 комочек на SPRINT_SPAWN_MS).
      if (testMode && remoteFreeRef.current.size > 0) {
        const cellWR = s.field.cellW;
        const cellHR = s.field.cellH;
        for (const [key, fr] of remoteFreeRef.current) {
          if (!fr.sp) continue;
          const rem = liveRemotesRef.current.find((t) => t.id === key);
          const imgR = spritesRef.current[rem?.sprite ?? s.character.sprite];
          const aspectR = imgR && imgR.height > 0 ? imgR.width / imgR.height : 2 / 3;
          const boxR = spriteBoxOf(s, aspectR, 0, 0, rem?.scale ?? s.character.spriteScale);
          const feetX = fr.x * cellWR + boxR.w / 2;
          const feetY = fr.y * cellHR + boxR.h;
          const dvx = (fr.tx - fr.x) * cellWR;
          const dvy = (fr.ty - fr.y) * cellHR;
          const dl = Math.hypot(dvx, dvy);
          if (dl < 2) continue; // стоит на месте (доведение дотухло) — комочков нет
          if (Math.random() < dt / SPRINT_SPAWN_MS) {
            spawnSprintPart(sprintPartsRef.current, feetX, feetY, dvx / dl, dvy / dl);
          }
        }
      }

      // Плавная камера «теста»: догоняет своего кота, упирается в кромку локации.
      // В мирном режиме добавляются зум и наклон земли (псевдо-3D), переход туда
      // и обратно — с той же экспоненциальной плавностью, что и сама камера.
      if (testMode) {
        const vw = cv.clientWidth || 1;
        const vh = cv.clientHeight || 1;
        const cellW = s.field.cellW;
        const cellH = s.field.cellH;
        const kz = 1 - Math.exp(-dt / CAMZOOM_TAU_MS);
        if (editorOn) {
          // Редактор: камера отъезжает, чтобы весь мир был виден целиком, вид — сверху.
          const bbE = testFieldGeometry(cellW, cellH).bboxPx;
          const pad = 90;
          const zT = Math.max(0.1, Math.min(1.15, Math.min(vw / (bbE.x1 - bbE.x0 + pad), vh / (bbE.y1 - bbE.y0 + pad))));
          camFxRef.current.z += (zT - camFxRef.current.z) * kz;
          camFxRef.current.sq += (1 - camFxRef.current.sq) * kz;
          camFxRef.current.dp += (0 - camFxRef.current.dp) * kz;
          const cxT = (bbE.x0 + bbE.x1) / 2;
          const cyT = (bbE.y0 + bbE.y1) / 2;
          if (!camRef.current.init) {
            camRef.current.x = cxT;
            camRef.current.y = cyT;
            camRef.current.init = true;
          } else {
            const kcE = 1 - Math.exp(-dt / CAMERA_TAU_MS);
            camRef.current.x += (cxT - camRef.current.x) * kcE;
            camRef.current.y += (cyT - camRef.current.y) * kcE;
          }
        } else {
          // Базовый зум вида: в мирном режиме с включённой перспективой поле
          // приближено (Don't Starve), иначе — вид сверху; поверх — зум колесом.
          const pv = s.character.peaceView;
          const zBase = (peaceWalk && pv ? PEACE_ZOOM : 1) * camUserZoomRef.current;
          camFxRef.current.z += (zBase - camFxRef.current.z) * kz;
          camFxRef.current.sq += ((peaceWalk && pv ? PEACE_TILT : 1) - camFxRef.current.sq) * kz;
          // перспектива (дальние объекты мельче) — только в мирном режиме с перспективой
          camFxRef.current.dp += ((peaceWalk && pv ? 1 : 0) - camFxRef.current.dp) * kz;
          const { z, sq } = camFxRef.current;
          const txP = peaceWalk ? e.fx * cellW + cellW / 2 : e.col * cellW + cellW / 2;
          const tyP = peaceWalk ? e.fy * cellH + (cellH - 10) / 2 : e.row * cellH + cellH / 2;
          const bb = testFieldGeometry(cellW, cellH).bboxPx;
          // видимое окно мира: зум сужает его, наклон дополнительно сжимает вертикаль
          const vwG = vw / z;
          const vhG = vh / (z * sq);
          const cxT =
            bb.x1 - bb.x0 >= vwG ? Math.min(Math.max(txP, bb.x0 + vwG / 2), bb.x1 - vwG / 2) : (bb.x0 + bb.x1) / 2;
          const cyT =
            bb.y1 - bb.y0 >= vhG ? Math.min(Math.max(tyP, bb.y0 + vhG / 2), bb.y1 - vhG / 2) : (bb.y0 + bb.y1) / 2;
          if (!camRef.current.init) {
            camRef.current.x = cxT;
            camRef.current.y = cyT;
            camRef.current.init = true;
          } else {
            const kc = 1 - Math.exp(-dt / CAMERA_TAU_MS);
            camRef.current.x += (cxT - camRef.current.x) * kc;
            camRef.current.y += (cyT - camRef.current.y) * kc;
          }
        }
      }

      // удержание клавиши удара (I): удары повторяются с интервалом отклика удара
      if (e.strikeHeld && now >= e.nextHoldStrike) {
        e.nextHoldStrike = now + strikeResponseMs(s);
        doStrikeRef.current?.();
      }

      // кулдаун шага (время прыжка с учётом замедления)
      if (e.step && now - e.step.start >= e.step.dur) e.step = null;

      // регенерация энергии: у всех, кто в боевом режиме (свой кот — когда включён
      // боережим, манекены — в нём всегда), энергия восстанавливается сама раз в интервал
      if (s.combat.regenEnabled && s.combat.regenAmount > 0) {
        const iv = Math.max(0.5, s.combat.regenIntervalSec) * 1000;
        e.regenAcc += dt;
        let ticks = 0;
        while (e.regenAcc >= iv && ticks < 12) {
          e.regenAcc -= iv;
          ticks += 1;
        }
        if (e.regenAcc > iv * 12) e.regenAcc = 0; // защита от бесконечного накопления
        if (ticks > 0) {
          const es = Math.max(1, s.combat.energyStart);
          const amt = s.combat.regenAmount * ticks;
          setCombat((prev) => {
            const pe = s.arrow.battleMode ? Math.min(es, prev.playerEnergy + amt) : prev.playerEnergy;
            const de = { ...prev.dummyEnergy };
            let changed = pe !== prev.playerEnergy;
            for (const d of s.dummies) {
              if (!d.present) continue;
              const cur = de[d.id] ?? es;
              const nv = Math.min(es, cur + amt);
              if (nv !== cur) {
                de[d.id] = nv;
                changed = true;
              }
            }
            for (const d of liveRemotesRef.current) {
              const cur = de[d.id] ?? es;
              const nv = Math.min(es, cur + amt);
              if (nv !== cur) {
                de[d.id] = nv;
                changed = true;
              }
            }
            // Мишень РАБ всегда в боевом режиме — её энергия восстанавливается сама.
            if (rabOnRef.current) {
              const cur = de[RAB_ID] ?? es;
              const nv = Math.min(es, cur + amt);
              if (nv !== cur) {
                de[RAB_ID] = nv;
                changed = true;
              }
            }
            return changed ? { ...prev, playerEnergy: pe, dummyEnergy: de } : prev;
          });
        }
      }

      e.labels = e.labels.filter((l) => now - l.born < 900);

      // Чужие стрелы догоняют последний сетевой угол каждый кадр. Свою не трогаем.
      if (liveRemotesRef.current.length > 0) {
        for (const d of liveRemotesRef.current) {
          const aim = remoteAimRef.current.get(d.id);
          if (aim) stepRemoteAim(aim, now, dt);
        }
      }

      // «желе» манекенов: дрожь гаснет со временем (у тащимого — медленнее, он «в руке»)
      const dg = dragRef.current;
      for (const jk of Object.keys(jellyRef.current)) {
        const cur = jellyRef.current[jk] ?? 0;
        if (cur <= 0.001) {
          jellyRef.current[jk] = 0;
          continue;
        }
        const tau = dg && dg.key === jk ? 420 : 200;
        jellyRef.current[jk] = cur * Math.exp(-dt / tau);
      }
    };

    // Тело стрелы: хвост (зелёная часть = остаток энергии, красная — потраченная,
    // растёт от наконечника, как на референсе) + тёмный наконечник; точка закрепления —
    // опциональна (прячется настройкой, сама стрела видна всегда).
    // Хвост рисуется двумя встык идущими отрезками: зелёным от закрепления до границы
    // энергии и красным дальше. Если красить сверху один сплошной зелёный хвост, круглая
    // шляпка у закрепления остаётся зелёной даже при нуле энергии — тот самый «зелёный
    // пиксель» в начале стрелы. Поэтому базовая шляпка красится цветом своего участка:
    // при полностью выбитой энергии вся стрела, включая наконечник и закрепление, красная.
    const drawArrowBody = (
      s: SimSettings,
      k: number,
      ax: number,
      ay: number,
      angleDeg: number,
      energyFrac = 1,
      showAnchor = true,
    ) => {
      const ctx2 = ctx;
      const a = (angleDeg * Math.PI) / 180;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const r1 = s.arrow.radius * k;
      const r2 = r1 + s.arrow.length * k;
      const tipLen = Math.min(s.arrow.tipSize * k, s.arrow.length * k * 0.5);
      const halfW = Math.max(2.5 * k, tipLen * 0.55);
      const shaftEnd = r2 - tipLen;
      const frac = Math.max(0, Math.min(1, energyFrac));
      const lw = s.arrow.width * k;
      const split = r1 + (shaftEnd - r1) * frac;
      // Цвет участка у закрепления: есть энергия — цвет стрелы, выбрана целиком — красный.
      const baseColor = frac > 0 ? s.arrow.color : SPENT_COLOR;
      // Наконечник темнее хвоста — читается на любом фоне.
      const tipColor = shadeHex(baseColor, ARROW_TIP_SHADE);

      ctx2.save();
      // зелёная часть хвоста (остаток энергии)
      ctx2.lineCap = 'butt';
      if (frac > 0 && split > r1) {
        ctx2.beginPath();
        ctx2.moveTo(ax + ca * r1, ay + sa * r1);
        ctx2.lineTo(ax + ca * split, ay + sa * split);
        ctx2.lineWidth = lw;
        ctx2.strokeStyle = s.arrow.color;
        ctx2.stroke();
      }
      // красная часть (потраченная энергия) — до наконечника
      if (frac < 1 && shaftEnd > split) {
        ctx2.beginPath();
        ctx2.moveTo(ax + ca * split, ay + sa * split);
        ctx2.lineTo(ax + ca * shaftEnd, ay + sa * shaftEnd);
        ctx2.lineWidth = lw;
        ctx2.strokeStyle = SPENT_COLOR;
        ctx2.stroke();
      }
      // круглая шляпка у закрепления — цветом участка, который начинается у базы
      ctx2.beginPath();
      ctx2.arc(ax + ca * r1, ay + sa * r1, lw / 2, 0, Math.PI * 2);
      ctx2.fillStyle = baseColor;
      ctx2.fill();
      // наконечник
      ctx2.beginPath();
      ctx2.moveTo(ax + ca * r2, ay + sa * r2);
      ctx2.lineTo(ax + ca * (r2 - tipLen) - sa * halfW, ay + sa * (r2 - tipLen) + ca * halfW);
      ctx2.lineTo(ax + ca * (r2 - tipLen) + sa * halfW, ay + sa * (r2 - tipLen) - ca * halfW);
      ctx2.closePath();
      ctx2.fillStyle = tipColor;
      ctx2.fill();
      // точка закрепления (масштабируется вместе с моделькой); прячется настройкой,
      // но стрела — линия с наконечником — рисуется в любом случае
      if (showAnchor) {
        ctx2.beginPath();
        ctx2.arc(ax, ay, 4 * k, 0, Math.PI * 2);
        ctx2.fillStyle = baseColor;
        ctx2.fill();
        ctx2.beginPath();
        ctx2.arc(ax, ay, 1.7 * k, 0, Math.PI * 2);
        ctx2.fillStyle = 'rgba(255,255,255,0.9)';
        ctx2.fill();
      }
      ctx2.restore();
    };

    /** Стрела того, кем сейчас управляем: сидит на его спрайте с его ростом,
     *  следует за перетаскиванием и показывает остаток ЕГО энергии. */
    const drawArrow = (s: SimSettings, e: Engine) => {
      const ctx2 = ctx;
      const selfId = s.controlled;
      const cfg = selfId === 'main' ? null : (s.dummies.find((d) => d.id === selfId) ?? null);
      const spriteId: SpriteId = cfg ? cfg.sprite : s.character.sprite;
      const scalePct = cfg ? cfg.scale : s.character.spriteScale;
      const sprA = spritesRef.current[spriteId] ?? Object.values(spritesRef.current)[0] ?? null;
      const dg = dragRef.current;
      // при перетаскивании управляемого манекена стрела следует за курсором;
      // в «тесте» стрела стоит на поднятой земле и летит вместе с боевым прыжком
      let px = dg && dg.key === selfId ? dg.x : e.col * s.field.cellW;
      let py = dg && dg.key === selfId ? dg.y : e.row * s.field.cellH;
      const testModeA = fieldFormatRef.current === 'test';
      if (testModeA && selfId === 'main') {
        const lpA = e.leap;
        if (lpA && lpA.battle) {
          const tA = Math.min(1, Math.max(0, (performance.now() - lpA.t0) / lpA.dur));
          px = lpA.x0 + (lpA.x1 - lpA.x0) * tA;
          py = lpA.y0 + (lpA.y1 - lpA.y0) * tA - (lpA.l0 + (lpA.l1 - lpA.l0) * tA) - e.leapZ;
        } else {
          py -= e.liftV + e.leapZ;
        }
      } else if (testModeA) {
        py -= elevLevelAt(e.col, e.row) * TERRAIN_LIFT_PX;
      }
      const { ax, ay, k } = anchorAtPx(s, sprA ? sprA.width / sprA.height : 2 / 3, px, py, scalePct);
      const r2 = s.arrow.radius * k + s.arrow.length * k;

      if (s.arrow.showOrbit) {
        ctx2.save();
        ctx2.setLineDash([4, 7]);
        ctx2.beginPath();
        ctx2.arc(ax, ay, r2, 0, Math.PI * 2);
        ctx2.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx2.lineWidth = 1;
        ctx2.stroke();
        ctx2.restore();
      }

      // дуга окна без замедления для последнего направления
      if (s.arrow.showWindowArc && e.lastDir !== null && s.arrow.battleMode) {
        const w: DirectionWindow | undefined =
          s.slowdown.windows[String(wrap360(e.lastDir)) as WindowKey];
        if (w) {
          const R = r2 + 8 * k;
          const a0 = (wrap360(w.start) * Math.PI) / 180;
          const a1 = (wrap360(w.end) * Math.PI) / 180;
          ctx2.save();
          ctx2.beginPath();
          ctx2.arc(ax, ay, R, a0, a1, false);
          ctx2.strokeStyle = 'rgba(78, 205, 110, 0.4)';
          ctx2.lineWidth = 5 * k;
          ctx2.stroke();
          // засечки границ окна
          for (const bb of [a0, a1]) {
            ctx2.beginPath();
            ctx2.moveTo(ax + Math.cos(bb) * (R - 7 * k), ay + Math.sin(bb) * (R - 7 * k));
            ctx2.lineTo(ax + Math.cos(bb) * (R + 7 * k), ay + Math.sin(bb) * (R + 7 * k));
            ctx2.strokeStyle = 'rgba(78, 205, 110, 0.7)';
            ctx2.lineWidth = 2 * k;
            ctx2.stroke();
          }
          ctx2.restore();
        }
      }

      // зелёная доля стрелы = остаток энергии управляемого персонажа (100% = полностью
      // зелёная); точка закрепления видна только когда включена настройка «Луч стрелы»
      const es = Math.max(1, s.combat.energyStart);
      const frac =
        (selfId === 'main' ? combatRef.current.playerEnergy : (combatRef.current.dummyEnergy[selfId] ?? es)) / es;
      drawArrowBody(s, k, ax, ay, e.angle, frac, s.arrow.showRay);
    };

    const drawHud = (s: SimSettings, e: Engine, screenW?: number) => {
      const ctx2 = ctx;
      const W = screenW ?? s.field.cols * s.field.cellW;
      const pw = 186;
      const ph = 208;
      const px = W - pw - 12;
      const py = 12;
      ctx2.save();
      rr(ctx2, px, py, pw, ph, 10);
      ctx2.fillStyle = 'rgba(10,12,15,0.82)';
      ctx2.fill();
      ctx2.strokeStyle = 'rgba(255,255,255,0.09)';
      ctx2.lineWidth = 1;
      ctx2.stroke();

      ctx2.textAlign = 'center';
      ctx2.textBaseline = 'middle';
      if (s.arrow.battleMode) {
        ctx2.font = 'bold 13px Inter, system-ui, sans-serif';
        ctx2.fillStyle = '#f4f4f5';
        ctx2.fillText(`Стрела: ${Math.round(wrap360(e.angle))}°`, px + pw / 2, py + 18);
      } else {
        ctx2.font = 'bold 13px Inter, system-ui, sans-serif';
        ctx2.fillStyle = '#a1a1aa';
        ctx2.fillText('Мирный режим', px + pw / 2, py + 18);
      }

      const ccx = px + pw / 2;
      const ccy = py + 88;
      const rad = 40;
      ctx2.beginPath();
      ctx2.arc(ccx, ccy, rad, 0, Math.PI * 2);
      ctx2.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx2.stroke();
      ctx2.beginPath();
      ctx2.arc(ccx, ccy, 2.5, 0, Math.PI * 2);
      ctx2.fillStyle = 'rgba(255,255,255,0.6)';
      ctx2.fill();

      // текущее направление стрелы
      const aa = (e.angle * Math.PI) / 180;
      ctx2.beginPath();
      ctx2.moveTo(ccx + Math.cos(aa) * 6, ccy + Math.sin(aa) * 6);
      ctx2.lineTo(ccx + Math.cos(aa) * 26, ccy + Math.sin(aa) * 26);
      ctx2.strokeStyle = s.arrow.color;
      ctx2.lineWidth = 3;
      ctx2.stroke();

      // 8 направлений с текущим замедлением
      for (const d of DIRECTIONS) {
        const sd = slowdownFor(d.deg, e.angle, s);
        const col = tierColor(sd);
        const da = (d.deg * Math.PI) / 180;
        const c1 = Math.cos(da);
        const s1 = Math.sin(da);
        ctx2.beginPath();
        ctx2.moveTo(ccx + c1 * (rad - 26), ccy + s1 * (rad - 26));
        ctx2.lineTo(ccx + c1 * (rad - 8), ccy + s1 * (rad - 8));
        ctx2.strokeStyle = col;
        ctx2.lineWidth = 3;
        ctx2.stroke();
        ctx2.font = 'bold 10px Inter, system-ui, sans-serif';
        ctx2.fillStyle = col;
        ctx2.fillText(`${sd}`, ccx + c1 * (rad + 16), ccy + s1 * (rad + 16));
      }

      ctx2.font = '9px Inter, system-ui, sans-serif';
      ctx2.fillStyle = '#71717a';
      ctx2.fillText('замедление, %', ccx, py + ph - 48);

      ctx2.font = '10.5px Inter, system-ui, sans-serif';
      ctx2.fillStyle = '#d4d4d8';
      ctx2.fillText(`Клетка: ${e.col + 1}, ${e.row + 1}`, px + pw / 2, py + ph - 34);
      ctx2.fillStyle = '#71717a';
      ctx2.fillText(
        `Вращение: ${Math.round(360 / Math.max(0.1, s.arrow.periodSec))}°/с · Шаг: ${Math.round(s.character.stepMs)}мс`,
        px + pw / 2,
        py + ph - 18,
      );
      ctx2.restore();
    };

    const draw = (now: number) => {
      const s = settingsRef.current;
      const e = engineRef.current;
      const W = s.field.cols * s.field.cellW;
      const H = s.field.rows * s.field.cellH;
      const testMode = fieldFormatRef.current === 'test';
      const { on: editorOn, draft: ed } = editorState();
      /** Глубинная очередь «теста»: персонажи, препятствия, плато рельефа и декор
       *  на них рисуются по дальности (кто ниже по полю — тот ближе и рисуется
       *  поверх). Объявлена до ветки «теста»: декор на плато кладёт себя в неё
       *  прямо из грунтового прохода. */
      const bills: { y: number; fn: () => void }[] = [];
      let vw = 0;
      let vh = 0;
      if (testMode) {
        // «Тест»: канвас — вьюпорт в мир. Занимает весь кадр, рисунок в мировых
        // координатах через камеру (translate), чёткость — через devicePixelRatio (кап 2).
        vw = cv.clientWidth || 1;
        vh = cv.clientHeight || 1;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const bw = Math.round(vw * dpr);
        const bh = Math.round(vh * dpr);
        if (cv.width !== bw || cv.height !== bh) {
          cv.width = bw;
          cv.height = bh;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // фон за кромкой локации — самый тёмный цвет темы
        const outside =
          getComputedStyle(document.documentElement).getPropertyValue('--sim-deep').trim() || '#09090b';
        ctx.fillStyle = outside;
        ctx.fillRect(0, 0, vw, vh);
        ctx.save();
        // камера «теста»: экран → зум → мир. В мирном режиме зум приближает поле,
        // а наклон (sq) сжимает землю по вертикали — псевдо-глубина 2.5D
        const fxc = camFxRef.current;
        ctx.translate(Math.round(vw / 2), Math.round(vh / 2));
        ctx.scale(fxc.z, fxc.z);
        ctx.translate(-Math.round(camRef.current.x), -Math.round(camRef.current.y));
        const geo = testFieldGeometry(s.field.cellW, s.field.cellH);
        // ГРУНТ — наклонённая плоскость: трава, доска с сеткой, кромка и якорные
        // точки лежат на земле и сжимаются по вертикали вместе с ней
        ctx.save();
        ctx.scale(1, fxc.sq);
        // Пиксельная отрисовка локации: рисунок кисти — и есть земля (канонические
        // px растягиваются на фактический размер клетки); прозрачные места —
        // пустота за кромкой. Прорисовка без сглаживания — пиксель-арт.
        const pcvG = paintReady() ? paintCanvas() : null;
        if (pcvG) {
          ctx.save();
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(pcvG, 0, 0, pcvG.width, pcvG.height, 0, 0, W, H);
          ctx.restore();
        } else {
          // трава локации: бесшовные тайлы пака (оливковая зелень с цветами);
          // пока текстура не догрузилась — прежний градиент тёмной зелени
          const gpat = grassPattern(ctx);
          if (gpat) {
            ctx.save();
            ctx.imageSmoothingEnabled = false;
            ctx.fillStyle = gpat;
            ctx.fill(geo.path);
            ctx.restore();
          } else {
            const grad = ctx.createLinearGradient(0, geo.bboxPx.y0, 0, geo.bboxPx.y1);
            grad.addColorStop(0, '#31511f');
            grad.addColorStop(0.55, '#2a461c');
            grad.addColorStop(1, '#233b18');
            ctx.fillStyle = grad;
            ctx.fill(geo.path);
          }
        }
        // проталины «земли» — наземный декор на самой почве: под сеткой, декором
        // и котами; на ходьбу не влияет, режется клипом по кромке локации.
        // Клетки плато (рельеф) рисуются из глубинной очереди — на поднятой земле.
        const mapObjects = currentTestMap().objects ?? [];
        const hasElev = elevAny();
        // С рисунком кисти проталины и покрытия не рисуются: они запечены в пиксели.
        if (!pcvG && mapObjects.some((o) => o.kind === 'dirt' && (!hasElev || elevLevelAt(o.c, o.r) === 0))) {
          ctx.save();
          ctx.clip(geo.path);
          for (const o of mapObjects) {
            if (o.kind !== 'dirt' || (hasElev && elevLevelAt(o.c, o.r) > 0)) continue;
            const poD = objectPosOffset(o);
            drawDirtPatch(
              ctx,
              s.field.cellW,
              s.field.cellH,
              (o.c + 0.5 + poD.dx) * s.field.cellW,
              (o.r + 0.5 + poD.dy) * s.field.cellH,
              hashStr(o.id) & 7,
            );
          }
          ctx.restore();
        }
        // покрытия земли (цветы/плитка/пол) — тот же слой грунта, что и проталины:
        // рисуются паттерном по клетке, ходьбе не мешают, режутся клипом по кромке
        if (!pcvG && mapObjects.some((o) => o.kind === 'ground' && (!hasElev || elevLevelAt(o.c, o.r) === 0))) {
          ctx.save();
          ctx.clip(geo.path);
          for (const o of mapObjects) {
            if (o.kind !== 'ground' || (hasElev && elevLevelAt(o.c, o.r) > 0)) continue;
            drawGroundCover(ctx, o, s.field.cellW, s.field.cellH);
          }
          ctx.restore();
        }
        // клетки захода — тоже наземная разметка: градиент от боевой клетки и
        // две галочки по центру (вход в бой); режется клипом по кромке локации
        const entryObjs = mapObjects.filter((o) => o.kind === 'entry' && o.dir && (!hasElev || elevLevelAt(o.c, o.r) === 0));
        if (entryObjs.length > 0) {
          ctx.save();
          ctx.clip(geo.path);
          for (const o of entryObjs) {
            if (!o.dir) continue;
            // только градиент и ребро; галочки накладываются отдельным проходом
            // поверх котов и препятствий (см. проход после глубинной очереди)
            drawEntryMark(
              ctx,
              s.field.cellW,
              s.field.cellH,
              (o.c + 0.5) * s.field.cellW,
              (o.r + 0.5) * s.field.cellH,
              o.dir,
              false,
            );
          }
          ctx.restore();
        }
        // маркер посадки прыжка: во время приседа-заряда — точка, куда кот
        // приземлится (прицел — под мышкой, кольцо следует за курсором; если
        // туда не долететь — кольцо встаёт на крайшую достижимую точку и краснеет),
        // в полёте — точка, куда кот опустится. Лежит на поднятой земле (l1),
        // поэтому прыжок вверх-вниз читается: кольцо показывает, на какой уровень
        // кот прилетит. Рисуется в плоскости грунта — под котами.
        if (testMode && !editorOn && s.controlled === 'main') {
          const spH = spaceHoldRef.current;
          const lpM = e.leap;
          let mx = -1;
          let my = -1;
          let mlift = 0;
          let shortM = false; // посадка не долетает до прицела — предупредить цветом
          if (lpM) {
            // полёт: точка посадки известна заранее
            if (lpM.battle) {
              mx = (lpM.x1 + s.field.cellW / 2) * 1;
              my = lpM.y1 + s.field.cellH / 2;
            } else {
              const hbM = peaceHalfBox(s, spritesRef.current[s.character.sprite]);
              mx = (lpM.x1 + hbM.dx) * s.field.cellW;
              my = (lpM.y1 + hbM.dy * 2) * s.field.cellH;
            }
            mlift = lpM.l1;
          } else if (spH.holding) {
            // заряд: прогноз по текущему заряду приседа; прицел — курсор.
            // Посадиться некуда — кольцо встаёт у лап и краснеет: сюда прыжок не выйдет.
            const chM = 0.15 + 0.85 * Math.min(1, (performance.now() - spH.since) / 4000);
            const aimM = !s.arrow.battleMode ? cursorWorldRef.current : null;
            const landM = leapLandingAt(chM, aimM);
            if (landM) {
              mx = landM.sx * s.field.cellW;
              my = landM.sy * s.field.cellH;
              mlift = landM.l1;
              if (aimM) {
                const shortPx = Math.hypot(aimM.x - mx, aimM.y - my);
                shortM = shortPx > s.field.cellH * 0.45;
              }
            } else {
              // Посадиться некуда: кольцо у лап (мирный — свободная позиция,
              // боевой — клетка) и красным: отсюда прыжок не выйдет.
              if (s.arrow.battleMode) {
                mx = (e.col + 0.5) * s.field.cellW;
                my = (e.row + 0.5) * s.field.cellH;
                mlift = elevLevelAt(e.col, e.row) * TERRAIN_LIFT_PX;
              } else {
                const hbM = peaceHalfBox(s, spritesRef.current[s.character.sprite]);
                mx = (e.fx + hbM.dx) * s.field.cellW;
                my = (e.fy + hbM.dy * 2) * s.field.cellH;
                mlift = e.liftV;
              }
              shortM = true;
            }
          }
          if (mx >= 0) {
            const pulse = 0.75 + 0.25 * Math.sin(now * 0.012);
            const rrM = 9 * pulse;
            ctx.save();
            ctx.translate(mx, my - mlift);
            ctx.fillStyle = shortM ? 'rgba(255, 178, 126, 0.22)' : 'rgba(126, 247, 156, 0.2)';
            ctx.beginPath();
            ctx.arc(0, 0, rrM, 0, Math.PI * 2);
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = shortM ? 'rgba(255, 205, 178, 0.9)' : 'rgba(214, 255, 226, 0.85)';
            ctx.stroke();
            ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
            ctx.beginPath();
            ctx.arc(0, 0, 2.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }
        // боевые зоны: мягкая жёлтая подсветка + жёлтая сетка, которые видны
        // всегда — внутри зоны кот в бою привязан к клеткам (как на обычном
        // поле). Сетка режется клипом по кромке: сглаженный край подрезает углы
        // зон, и ничего не вылезает за нарисованный островок.
        ctx.save();
        ctx.clip(geo.path);
        const mapZones = currentTestMap().zones;
        // Объединение всех боевых зон в одно множество клеток: каждая клетка
        // красится и прочерчивается ровно один раз, поэтому перекрытие зон
        // больше не наслаивает заливки — вся боевая область одного цвета.
        const battleCells = new Set<string>();
        for (const z of mapZones) {
          if (z.kind !== 'cells') continue;
          for (let r = z.r0; r <= z.r1; r++) {
            for (let c = z.c0; c <= z.c1; c++) battleCells.add(`${c},${r}`);
          }
        }
        // одиночные боевые клетки (объекты kind «battle») — та же боевая область
        for (const o of mapObjects) {
          if (o.kind !== 'battle') continue;
          battleCells.add(`${o.c},${o.r}`);
        }
        if (battleCells.size > 0) {
          const cw = s.field.cellW;
          const chh = s.field.cellH;
          // боевая область — только тонировка: никакой светлой подложки, трава
          // просвечивает сквозь 10% тёплой вуали (по просьбе: «прозрачность 10%»);
          // читаемость зоны держат сетка, рамка и клетки захода.
          // Клетки плато (рельеф) красятся в глубинной очереди на поднятой земле.
          const baseBattle = (key: string): boolean => {
            if (!hasElev) return true;
            const [bc, br] = key.split(',').map(Number);
            return elevLevelAt(bc, br) === 0;
          };
          const bpath = new Path2D();
          for (const key of battleCells) {
            if (!baseBattle(key)) continue;
            const [c, r] = key.split(',').map(Number);
            bpath.rect(c * cw, r * chh, cw, chh);
          }
          ctx.fillStyle = 'rgba(250, 214, 80, 0.1)';
          ctx.fill(bpath);
          // сетка боевых клеток: у каждой клетки — верх и лево, граничные
          // клетки достраивают низ и право; каждое ребро рисуется один раз
          ctx.strokeStyle = 'rgba(233, 196, 61, 0.8)';
          ctx.lineWidth = 0.75;
          ctx.beginPath();
          for (const key of battleCells) {
            if (!baseBattle(key)) continue;
            const [c, r] = key.split(',').map(Number);
            const x = c * cw;
            const y = r * chh;
            ctx.moveTo(x + 0.5, y + 0.5);
            ctx.lineTo(x + cw + 0.5, y + 0.5);
            ctx.moveTo(x + 0.5, y + 0.5);
            ctx.lineTo(x + 0.5, y + chh + 0.5);
            if (!battleCells.has(`${c},${r + 1}`) || !baseBattle(`${c},${r + 1}`)) {
              ctx.moveTo(x + 0.5, y + chh + 0.5);
              ctx.lineTo(x + cw + 0.5, y + chh + 0.5);
            }
            if (!battleCells.has(`${c + 1},${r}`) || !baseBattle(`${c + 1},${r}`)) {
              ctx.moveTo(x + cw + 0.5, y + 0.5);
              ctx.lineTo(x + cw + 0.5, y + chh + 0.5);
            }
          }
          ctx.stroke();
          // рамка боевой области — чуть ярче сетки, только по краю объединения
          ctx.strokeStyle = 'rgba(246, 208, 61, 0.95)';
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          for (const key of battleCells) {
            if (!baseBattle(key)) continue;
            const [c, r] = key.split(',').map(Number);
            const x = c * cw;
            const y = r * chh;
            if (!battleCells.has(`${c},${r - 1}`) || !baseBattle(`${c},${r - 1}`)) {
              ctx.moveTo(x + 1, y + 1);
              ctx.lineTo(x + cw - 1, y + 1);
            }
            if (!battleCells.has(`${c - 1},${r}`) || !baseBattle(`${c - 1},${r}`)) {
              ctx.moveTo(x + 1, y + 1);
              ctx.lineTo(x + 1, y + chh - 1);
            }
            if (!battleCells.has(`${c},${r + 1}`) || !baseBattle(`${c},${r + 1}`)) {
              ctx.moveTo(x + 1, y + chh - 1);
              ctx.lineTo(x + cw - 1, y + chh - 1);
            }
            if (!battleCells.has(`${c + 1},${r}`) || !baseBattle(`${c + 1},${r}`)) {
              ctx.moveTo(x + cw - 1, y + 1);
              ctx.lineTo(x + cw - 1, y + chh - 1);
            }
          }
          ctx.stroke();
        }
        // клетки, задетые кромкой (не целиком внутри полигона): в бою они
        // недоступны для прыжков — помечаем лёгкой красной заливкой
        if (s.arrow.battleMode && !editorOn) {
          ctx.fillStyle = 'rgba(214, 69, 65, 0.16)';
          for (const k of testClippedCells()) {
            const liftK = hasElev ? elevLevelAt(k.c, k.r) * TERRAIN_LIFT_PX : 0;
            ctx.fillRect(k.c * s.field.cellW, k.r * s.field.cellH - liftK, s.field.cellW, s.field.cellH);
          }
        }
        // частицы спринта: комочки земли/травы над землёй. Высота z уходит вверх
        // экрана: грунт наклонён (экранный y = мир*sq), поэтому рисуем y - z/sq —
        // комочки взлетают вертикально, а не сползают по наклонной плоскости
        const partsD = sprintPartsRef.current;
        if (partsD.length > 0) {
          const invSq = 1 / Math.max(0.2, fxc.sq);
          for (const p of partsD) {
            ctx.globalAlpha = Math.min(1, (1 - p.life / p.ttl) * 1.6);
            ctx.fillStyle = p.col;
            ctx.fillRect(p.x - p.size / 2, p.y - p.z * invSq - p.size / 2, p.size, p.size);
          }
          ctx.globalAlpha = 1;
        }
        ctx.restore();
        // земляная кромка поверх подрезанной доски: срезанный край сетки
        // получает аккуратную окантовку и плавно уходит в траву
        ctx.lineJoin = 'round';
        ctx.lineWidth = 6;
        ctx.strokeStyle = '#4a3a28';
        ctx.stroke(geo.path);
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(122, 162, 92, 0.35)';
        ctx.stroke(geo.path);
        // атмосферная дымка у дальнего края: лёгкое затемнение верха локации
        // усиливает ощущение глубины (только в мирном режиме — вместе с перспективой)
        if (fxc.dp > 0.01) {
          const bbG = geo.bboxPx;
          const gFar = ctx.createLinearGradient(0, bbG.y0, 0, bbG.y0 + (bbG.y1 - bbG.y0) * 0.5);
          gFar.addColorStop(0, `rgba(6, 12, 4, ${(0.2 * fxc.dp).toFixed(3)})`);
          gFar.addColorStop(1, 'rgba(6, 12, 4, 0)');
          ctx.save();
          ctx.clip(geo.path);
          ctx.fillStyle = gFar;
          ctx.fillRect(bbG.x0, bbG.y0, bbG.x1 - bbG.x0, bbG.y1 - bbG.y0);
          ctx.restore();
        }
        // мирный режим: точек привязки больше нет — ходьба свободная, по пикселям.
        // Оверлей редактора: границы мира, бледная сетка всего мира, подсветка
        // зелёных зон и тянущийся прямоугольник. Клетки: c=0..cols, r=0..rows.
        if (editorOn && ed) {
          const wc = ed.cols * s.field.cellW;
          const wr = ed.rows * s.field.cellH;
          // сетка всего мира — чтобы было видно, какие клетки свободны под новые зоны
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let c = 0; c <= ed.cols; c++) {
            ctx.moveTo(c * s.field.cellW + 0.5, 0);
            ctx.lineTo(c * s.field.cellW + 0.5, wr);
          }
          for (let r = 0; r <= ed.rows; r++) {
            ctx.moveTo(0, r * s.field.cellH + 0.5);
            ctx.lineTo(wc, r * s.field.cellH + 0.5);
          }
          ctx.stroke();
          // зелёные зоны — лёгкая зелёная заливка (доски у них нет, край уже нарисован)
          ctx.fillStyle = 'rgba(112, 178, 92, 0.16)';
          for (const z of ed.zones) {
            if (z.kind !== 'green') continue;
            ctx.fillRect(z.c0 * s.field.cellW, z.r0 * s.field.cellH, (z.c1 - z.c0 + 1) * s.field.cellW, (z.r1 - z.r0 + 1) * s.field.cellH);
          }
          // граница мира
          ctx.setLineDash([7, 5]);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(0.5, 0.5, wc - 1, wr - 1);
          ctx.setLineDash([]);
          // препятствия черновика: спрайт + пунктирный контур тела. Землю,
          // покрытие и заходы рисует сам грунт — здесь только камень и дерево.
          // Ставятся свободно (точка опоры — дробные x/y), размер/поворот — из объекта.
          for (const o of ed.objects) {
            if (o.id === editorPlaceRef.current?.pickId) continue; // поднят в призрак
            if (o.kind === 'entry') {
              if (o.dir) {
                drawEntryMark(
                  ctx,
                  s.field.cellW,
                  s.field.cellH,
                  (o.c + 0.5) * s.field.cellW,
                  (o.r + 0.5) * s.field.cellH,
                  o.dir,
                );
              }
              continue;
            }
            if (o.kind === 'dirt' || o.kind === 'ground') continue;
            const bE = objectBase(o);
            drawTestObject(
              ctx,
              o,
              s.field.cellW,
              s.field.cellH,
              bE.x * s.field.cellW,
              bE.y * s.field.cellH,
              1,
              hashStr(o.id) & 7,
            );
            // контур «обтекаемого» тела — эллипс с масштабом и поворотом объекта
            const bodyE = obstacleBodyPx(o);
            const scE = objectScale(o);
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.ellipse(
              bE.x * s.field.cellW,
              bE.y * s.field.cellH,
              bodyE.hw * scE + 6,
              bodyE.h * scE + 6,
              (objectRotDeg(o) * Math.PI) / 180,
              0,
              Math.PI * 2,
            );
            ctx.stroke();
            ctx.setLineDash([]);
          }
          // клетки спавна: пунктирный контур + флажок. Только в редакторе —
          // на поле клетка спавна ничем не отличается от соседних.
          for (const spw of ed.spawns) {
            const x0 = spw.c * s.field.cellW;
            const y0 = spw.r * s.field.cellH;
            ctx.setLineDash([5, 4]);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.lineWidth = 1.2;
            ctx.strokeRect(x0 + 5.5, y0 + 5.5, s.field.cellW - 11, s.field.cellH - 11);
            ctx.setLineDash([]);
            // флажок точки появления: шест + треугольный вымпел
            const fx0 = x0 + s.field.cellW / 2;
            const fy0 = y0 + s.field.cellH / 2;
            ctx.beginPath();
            ctx.moveTo(fx0 - 6, fy0 + 9);
            ctx.lineTo(fx0 - 6, fy0 - 9);
            ctx.lineTo(fx0 + 9, fy0 - 4);
            ctx.lineTo(fx0 - 6, fy0 + 1);
            ctx.closePath();
            ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
            ctx.lineWidth = 1;
            ctx.stroke();
          }
          // Кисть локации: контур мазка под курсором — круглый (диаметр кисти)
          // или готовая область «клетка»/«полклетка» с привязкой к сетке.
          if (ed.tool === 'paint' && e.hover) {
            const hx = (e.hover.c + 0.5) * s.field.cellW;
            const hy = (e.hover.r + 0.5) * s.field.cellH;
            ctx.save();
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
            ctx.lineWidth = 1.4;
            if (ed.pshape === 'round') {
              ctx.beginPath();
              ctx.arc(hx, hy, Math.max(1, ed.psize / 2), 0, Math.PI * 2);
              ctx.stroke();
            } else {
              const bw2 = ed.pshape === 'cell' ? s.field.cellW : s.field.cellW / 2;
              const bh2 = ed.pshape === 'cell' ? s.field.cellH : s.field.cellH / 2;
              ctx.strokeRect(Math.floor(hx / bw2) * bw2 + 0.5, Math.floor(hy / bh2) * bh2 + 0.5, bw2 - 1, bh2 - 1);
            }
            ctx.restore();
          }
          // Боевая клетка: подсветка клетки под курсором — зелёная (поставить или
          // снять), красная (место не покрашено целиком или занято объектом).
          if (ed.tool === 'battle' && e.hover) {
            const existsB = ed.objects.some((o) => o.kind === 'battle' && o.c === e.hover!.c && o.r === e.hover!.r);
            const okB =
              existsB ||
              (!!ed.pcv &&
                paintCellCoverage(e.hover.c, e.hover.r) >= 0.995 &&
                !testObjectAt(e.hover.c, e.hover.r));
            ctx.fillStyle = okB ? 'rgba(120, 220, 140, 0.3)' : 'rgba(224, 92, 92, 0.3)';
            ctx.fillRect(e.hover.c * s.field.cellW, e.hover.r * s.field.cellH, s.field.cellW, s.field.cellH);
            ctx.strokeStyle = okB ? 'rgba(160, 255, 180, 0.9)' : 'rgba(255, 150, 150, 0.9)';
            ctx.lineWidth = 1.6;
            ctx.strokeRect(
              e.hover.c * s.field.cellW + 0.75,
              e.hover.r * s.field.cellH + 0.75,
              s.field.cellW - 1.5,
              s.field.cellH - 1.5,
            );
          }
          // тянущийся прямоугольник
          const dr = ed.drag;
          if (dr) {
            const dc0 = Math.min(dr.c0, dr.c1);
            const dc1 = Math.max(dr.c0, dr.c1);
            const dr0 = Math.min(dr.r0, dr.r1);
            const dr1 = Math.max(dr.r0, dr.r1);
            const dx0 = dc0 * s.field.cellW;
            const dy0 = dr0 * s.field.cellH;
            const dw = (dc1 - dc0 + 1) * s.field.cellW;
            const dh = (dr1 - dr0 + 1) * s.field.cellH;
            const erase = dr.erase || ed.tool === 'erase';
            ctx.fillStyle = erase
              ? 'rgba(224, 92, 92, 0.34)'
              : ed.tool === 'green'
                ? 'rgba(112, 178, 92, 0.34)'
                : 'rgba(120, 170, 250, 0.30)';
            ctx.fillRect(dx0, dy0, dw, dh);
            ctx.strokeStyle = erase ? 'rgba(255, 150, 150, 0.9)' : 'rgba(255, 255, 255, 0.75)';
            ctx.lineWidth = 1.6;
            ctx.strokeRect(dx0 + 0.5, dy0 + 0.5, dw - 1, dh - 1);
          }
        }
        ctx.restore();
        // трава и цветы — билборды: стоят вертикально, основание следует за сжатой
        // землёй (как объекты в Don't Starve); масштаб растёт с глубиной.
        // Все уходит в глубинную очередь с ключом «верх клетки +4» (линия, на
        // которой стоят спрайты): декор на плато рисуется поверх поднятой земли
        // своей клетки, а декор у стены обрыва — поверх стены.
        for (const d of geo.decor) {
          const mD = 1 + (peaceDepthScale(d.y) - 1) * fxc.dp;
          const liftD = hasElev ? elevLiftAtPoint(d.x, d.y) : 0;
          const cellRowD = Math.min(s.field.rows - 1, Math.max(0, Math.floor(d.y)));
          const yKeyD = cellRowD * s.field.cellH + 4;
          bills.push({
            y: yKeyD,
            fn: () => {
              ctx.save();
              ctx.translate(0, (d.y * s.field.cellH - liftD) * (fxc.sq - 1));
              drawTestDecorItem(ctx, d, s.field.cellW, s.field.cellH, mD);
              ctx.restore();
            },
          });
        }
      } else {
        // Канвас может показываться крупнее клеточного размера (поле на весь кадр).
        // Чтобы без «мыла»: backing store повторяет показанный размер с учётом
        // devicePixelRatio (кап 2), а рисунок идёт в клеточных координатах через
        // ctx.setTransform. Мышь маппится через отношение размеров — не ломается.
        const cssW = cv.clientWidth || W;
        const k = Math.min(2, Math.max(1, (cssW * (window.devicePixelRatio || 1)) / Math.max(1, W)));
        const bw = Math.round(W * k);
        const bh = Math.round(H * k);
        if (cv.width !== bw || cv.height !== bh) {
          cv.width = bw;
          cv.height = bh;
        }
        ctx.setTransform(k, 0, 0, k, 0, 0);

        // фон
        ctx.fillStyle = s.field.bgColor;
        ctx.fillRect(0, 0, W, H);
        if (s.field.checker) {
          ctx.fillStyle = s.field.bgColorAlt;
          for (let r = 0; r < s.field.rows; r++) {
            for (let c = 0; c < s.field.cols; c++) {
              if ((c + r) % 2 === 0) ctx.fillRect(c * s.field.cellW, r * s.field.cellH, s.field.cellW, s.field.cellH);
            }
          }
        }
        if (s.field.showGrid) {
          ctx.strokeStyle = s.field.gridColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let c = 0; c <= s.field.cols; c++) {
            ctx.moveTo(c * s.field.cellW + 0.5, 0);
            ctx.lineTo(c * s.field.cellW + 0.5, H);
          }
          for (let r = 0; r <= s.field.rows; r++) {
            ctx.moveTo(0, r * s.field.cellH + 0.5);
            ctx.lineTo(W, r * s.field.cellH + 0.5);
          }
          ctx.stroke();
        }
      }

      // подсветка клетки под курсором
      if (e.hover) {
        const hx = e.hover.c * s.field.cellW;
        const hy = e.hover.r * s.field.cellH;
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(hx, hy, s.field.cellW, s.field.cellH);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(hx + 1, hy + 1, s.field.cellW - 2, s.field.cellH - 2);
      }

      // маршрут по клику
      if (e.path.length > 0) {
        const cx = (c: number) => c * s.field.cellW + s.field.cellW / 2;
        const cy = (r: number) => r * s.field.cellH + s.field.cellH / 2;
        for (const p of e.path) {
          ctx.beginPath();
          ctx.arc(cx(p.c), cy(p.r), 4.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(78,205,110,0.45)';
          ctx.fill();
        }
        const lastP = e.path[e.path.length - 1];
        ctx.strokeStyle = 'rgba(78,205,110,0.8)';
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 2;
        ctx.strokeRect(lastP.c * s.field.cellW + 3, lastP.r * s.field.cellH + 3, s.field.cellW - 6, s.field.cellH - 6);
        ctx.setLineDash([]);
      }

      // Персонажи на поле: манекены (мишени) и свой кот. Клетки персонажей — физические
      // препятствия и цели ударов. Перетаскиваемый манекен рисуется по курсорной позиции,
      // управляемый — по клетке движка, остальные — по настройкам; при тряске мышью
      // манекен качается «желе» вокруг своего нижнего центра
      const drag = dragRef.current;
      /** Подъём земли (px) под клеткой: плато приподнимает всех, кто на нём стоит. */
      const liftOfCell = (col: number, row: number): number =>
        testMode ? elevLevelAt(Math.floor(col), Math.floor(row)) * TERRAIN_LIFT_PX : 0;
      /** Дуга прыжка чужого кота (jp во freemove): плавный подскок на месте посадки. */
      const remoteHopZ = (key: string): number => {
        const fr = remoteFreeRef.current.get(key);
        if (!fr || !fr.jpUntil || fr.jpUntil <= now) return 0;
        const t = 1 - (fr.jpUntil - now) / 430;
        return Math.sin(Math.PI * Math.min(1, Math.max(0, t))) * 26;
      };
      const posOfChar = (id: string, col: number, row: number): { x: number; y: number } => {
        if (drag && drag.key === id) {
          const liftDrag = testMode ? elevLiftAtPoint(drag.x / s.field.cellW, (drag.y + drag.h * 0.75) / s.field.cellH) : 0;
          return { x: drag.x, y: drag.y - liftDrag };
        }
        if (id === s.controlled) {
          // «Тест», мирный режим: свой кот стоит в свободной позиции
          if (testMode && !s.arrow.battleMode) {
            return { x: e.fx * s.field.cellW, y: e.fy * s.field.cellH - e.liftV - e.leapZ };
          }
          // боевой прыжок: моделька летит от старой клетки к новой по дуге
          const lp = e.leap;
          if (lp && lp.battle) {
            const t = Math.min(1, Math.max(0, (now - lp.t0) / lp.dur));
            return {
              x: lp.x0 + (lp.x1 - lp.x0) * t,
              y: lp.y0 + (lp.y1 - lp.y0) * t - (lp.l0 + (lp.l1 - lp.l0) * t) - e.leapZ,
            };
          }
          return { x: e.col * s.field.cellW, y: e.row * s.field.cellH - e.liftV };
        }
        // чужой кот в свободной ходьбе («тест») — плавная доведённая позиция;
        // высота — по его логической клетке (серверной), прыжок — дугой
        const free = id.startsWith('p') ? remoteFreeRef.current.get(id) : undefined;
        if (free) {
          return {
            x: free.x * s.field.cellW,
            y: free.y * s.field.cellH - liftOfCell(col, row) - remoteHopZ(id),
          };
        }
        const vis = id.startsWith('p') ? remoteDrawRef.current.get(id) : undefined;
        if (vis) {
          return { x: vis.col * s.field.cellW, y: vis.row * s.field.cellH - liftOfCell(vis.col, vis.row) };
        }
        return { x: col * s.field.cellW, y: row * s.field.cellH - liftOfCell(col, row) };
      };
      const dummies = dummiesOf(s, liveRemotesRef.current).filter(
        (d) => d.col >= 0 && d.col < s.field.cols && d.row >= 0 && d.row < s.field.rows,
      );
      /** Множитель перспективы для точки опоры (px мира): дальние спрайты мельче.
       *  В бою и вне «теста» — 1; в мирном «тесте» растёт вместе с camFx.dp. */
      const depthM = (groundYpx: number): number => {
        const fx = camFxRef.current;
        if (!testMode || fx.dp <= 0.002) return 1;
        return 1 + (peaceDepthScale(groundYpx / s.field.cellH) - 1) * fx.dp;
      };
      /** Глубинная очередь «теста»: добавление — по дальности; вне «теста» — сразу. */
      const runOrQueue = (fn: () => void, y: number) => {
        if (testMode) bills.push({ y, fn });
        else fn();
      };

      /** Позиция (px мира), ключ глубинной сортировки (линия лап) и габарит
       *  билборда своего кота — один расчёт для плато (прозрачность перекрытия)
       *  и для самой отрисовки: два независимых пересчёта разъезжались бы. */
      const selfDraw = (): { cx: number; cy: number; key: number; rect: PxRect | null } => {
        const sprT0 = spritesRef.current[s.character.sprite] ?? Object.values(spritesRef.current)[0] ?? null;
        const selfIdT = s.controlled;
        const mainPosT = selfIdT === 'main' ? { col: e.col, row: e.row } : mainSavedRef.current;
        const selfFreeT = testMode && !s.arrow.battleMode;
        let cx = (selfFreeT ? e.fx : mainPosT ? mainPosT.col : e.col) * s.field.cellW;
        let cy = (selfFreeT ? e.fy : mainPosT ? mainPosT.row : e.row) * s.field.cellH;
        if (testMode) {
          const lpT = e.leap;
          if (lpT && lpT.battle) {
            const tT = Math.min(1, Math.max(0, (performance.now() - lpT.t0) / lpT.dur));
            cx = lpT.x0 + (lpT.x1 - lpT.x0) * tT;
            cy = lpT.y0 + (lpT.y1 - lpT.y0) * tT - (lpT.l0 + (lpT.l1 - lpT.l0) * tT) - e.leapZ;
          } else {
            cy -= e.liftV + e.leapZ;
          }
        }
        const scaleT =
          selfIdT === 'main' ? s.character.spriteScale : (s.dummies.find((d) => d.id === selfIdT)?.scale ?? 100);
        const th0T = (s.field.cellH - 10) * (scaleT / 100);
        const key = cy + th0T;
        let rect: PxRect | null = null;
        if (sprT0) {
          const groundY = cy + th0T;
          const th = th0T * depthM(groundY);
          const tw = th * (sprT0.width / sprT0.height);
          const py = testMode ? groundY * camFxRef.current.sq - th : cy;
          rect = { x0: cx, y0: py, x1: cx + tw, y1: py + th };
        }
        return { cx, cy, key, rect };
      };
      const selfDrawV = selfDraw();

      // плато рельефа: верх и стена обрыва — РАЗНЫЕ билборды глубинной очереди.
      // У верха ключ = ПОДНЯТЫЙ верхний край клетки: кот на плато (лапы всегда
      // ниже поднятого верха своей клетки) рисуется поверх своей земли и больше
      // не проваливается в неё на половине клетки; коты позади плато на низкой
      // земле прячутся под ним. У стены ключ = низ стены: она прячет котов
      // позади обрыва и скрывается за котами перед ним. Разметка клетки
      // (бой/покрытия/заход) едет вместе с верхом плато.
      if (testMode && elevAny()) {
        const fxcT = camFxRef.current;
        const geoT = testFieldGeometry(s.field.cellW, s.field.cellH);
        const gpatT = grassPattern(ctx);
        // верх плато поднимает кусок пиксельной отрисовки клетки (если рисунок есть)
        const pcvT = paintReady() ? paintCanvas() : null;
        const cwT = s.field.cellW;
        const chT = s.field.cellH;
        const isBattleCellT = (c: number, r: number): boolean =>
          currentTestMap().zones.some((z) => z.kind === 'cells' && c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1);
        const flatsByCellT = new Map<string, TestMapObject[]>();
        for (const oT of currentTestMap().objects ?? []) {
          if (oT.kind !== 'dirt' && oT.kind !== 'ground' && oT.kind !== 'entry') continue;
          const kT = `${oT.c},${oT.r}`;
          const arrT = flatsByCellT.get(kT);
          if (arrT) arrT.push(oT);
          else flatsByCellT.set(kT, [oT]);
        }
        const mapElev = currentTestMap().elev ?? {};
        for (const key of Object.keys(mapElev)) {
          const lvT = mapElev[key];
          if (!lvT || lvT <= 0) continue;
          const [cT, rT] = key.split(',').map(Number);
          if (!Number.isFinite(cT) || !Number.isFinite(rT)) continue;
          if (cT < 0 || rT < 0 || cT >= s.field.cols || rT >= s.field.rows) continue;
          const liftT = lvT * TERRAIN_LIFT_PX;
          const battleT = isBattleCellT(cT, rT);
          const flatsT = flatsByCellT.get(key);
          const sameLvlBattleT = (cc: number, rr: number): boolean =>
            isBattleCellT(cc, rr) && elevLevelAt(cc, rr) === lvT;
          // ВЕРХ: ключ — поднятая верхняя грань клетки; всё, что стоит на этой
          // земле (лапы строго ниже верхней грани), рисуется поверх.
          bills.push({
            y: rT * chT - liftT,
            fn: () => {
              ctx.save();
              ctx.scale(1, fxcT.sq);
              ctx.clip(geoT.path);
              // поднятая земля этой клетки
              drawTerrainTop(ctx, cwT, chT, cT, rT, gpatT, pcvT);
              // разметка клетки поверх поднятой земли
              if (flatsT) {
                for (const oT of flatsT) {
                  if (oT.kind === 'dirt') {
                    const poT = objectPosOffset(oT);
                    drawDirtPatch(ctx, cwT, chT, (oT.c + 0.5 + poT.dx) * cwT, (oT.r + 0.5 + poT.dy) * chT - liftT, hashStr(oT.id) & 7);
                  } else if (oT.kind === 'ground') {
                    drawGroundCover(ctx, oT, cwT, chT, -liftT);
                  } else if (oT.kind === 'entry' && oT.dir) {
                    drawEntryMark(ctx, cwT, chT, (oT.c + 0.5) * cwT, (oT.r + 0.5) * chT - liftT, oT.dir, false);
                  }
                }
              }
              if (battleT) {
                const xT = cT * cwT;
                const yT = rT * chT - liftT;
                ctx.fillStyle = 'rgba(250, 214, 80, 0.1)';
                ctx.fillRect(xT, yT, cwT, chT);
                ctx.strokeStyle = 'rgba(233, 196, 61, 0.8)';
                ctx.lineWidth = 0.75;
                ctx.beginPath();
                if (!sameLvlBattleT(cT, rT - 1)) {
                  ctx.moveTo(xT + 0.5, yT + 0.5);
                  ctx.lineTo(xT + cwT + 0.5, yT + 0.5);
                }
                if (!sameLvlBattleT(cT - 1, rT)) {
                  ctx.moveTo(xT + 0.5, yT + 0.5);
                  ctx.lineTo(xT + 0.5, yT + chT + 0.5);
                }
                if (!sameLvlBattleT(cT, rT + 1)) {
                  ctx.moveTo(xT + 0.5, yT + chT + 0.5);
                  ctx.lineTo(xT + cwT + 0.5, yT + chT + 0.5);
                }
                if (!sameLvlBattleT(cT + 1, rT)) {
                  ctx.moveTo(xT + cwT + 0.5, yT + 0.5);
                  ctx.lineTo(xT + cwT + 0.5, yT + chT + 0.5);
                }
                ctx.stroke();
              }
              ctx.restore();
            },
          });
          // СТЕНА: рисуем только там, где сосед снизу ниже; ключ — низ стены
          // (минус пиксель, чтобы кот вплотную к обрыву спереди рисовался поверх).
          const wallYT = terrainWallBottomY(cT, rT, chT);
          if (wallYT != null) {
            bills.push({
              y: wallYT - 1,
              fn: () => {
                ctx.save();
                ctx.scale(1, fxcT.sq);
                ctx.clip(geoT.path);
                drawTerrainWall(ctx, cwT, chT, cT, rT);
                ctx.restore();
              },
            });
          }
        }
      }

      const drawChar = (
        sprC: HTMLImageElement,
        pos: { x: number; y: number },
        scalePct: number,
        jellyKey: string | null,
        selected = false,
        whiteC: HTMLCanvasElement | null = null,
        active = false,
        /** Зеркалирование по горизонтали: 1 — как нарисован (влево), -1 — зеркально
         *  (вправо). Мирный режим разворачивает кота по направлению бега. */
        flip = 1,
      ) => {
        const th0 = (s.field.cellH - 10) * (scalePct / 100);
        const groundY = pos.y + th0;
        // перспектива: рост меняется, точка опоры на земле — нет
        const th = th0 * depthM(groundY);
        const twd = th * (sprC.width / sprC.height);
        // билборд: земля в мирном «тесте» наклонена (сжата по вертикали), спрайт
        // остаётся вертикальным — низ прижат к сжатой земле, верх не заваливается
        const py = testMode ? groundY * camFxRef.current.sq - th : pos.y;
        // подсветка модели, выбранной в панели (не той, за которую играют):
        // слегка увеличенный светлый силуэт за спрайтом
        const glow = (gx: number, gy: number) => {
          if (!selected || active || !whiteC) return;
          const g = 6; // насколько подсветка шире модельки, px
          ctx.save();
          ctx.globalAlpha = 0.55;
          ctx.drawImage(whiteC, gx - g, gy - g, twd + g * 2, th + g * 2);
          ctx.restore();
        };
        // «желе»: сплющивание-растяжение (объём сохраняется) с лёгким поворотом.
        // Спрайт всегда рисуется через нижний центр с флипом — разворот модельки
        // и качание живут в одной системе координат и не мешают друг другу.
        const amp = jellyKey ? (jellyRef.current[jellyKey] ?? 0) : 0;
        const baseCx = pos.x + twd / 2;
        const baseY2 = py + th;
        // Пробел (свой кот): удержание — плавное приплющивание вниз (полный эффект
        // за 4 с) с нарастающей дрожью и поводкой корпуса; отпускание — желейный
        // «выстрел» вверх: резкое вытяжение с подпрыгом и пружинное затухание в норму.
        let sqY = 1;
        let sqX = 1;
        let extraRot = 0;
        let swayX = 0;
        let lift = 0;
        // Пробел (свой кот или чужой): удержание — плавное приплющивание вниз (полный эффект
        // за 4 с) с нарастающей дрожью и поводкой корпуса; отпускание — желейный
        // «выстрел» вверх: резкое вытяжение с подпрыгом и пружинное затухание в норму.
        // Свои данные — из локального состояния, чужие — из сетевых событий (p<id>).
        const sp = jellyKey === 'main'
          ? spaceHoldRef.current
          : (jellyKey ? remoteSpaceRef.current.get(jellyKey) : undefined);
        if (sp) {
          if (sp.holding) {
            const p = Math.min(1, (now - sp.since) / 4000);
            sqY *= 1 - 0.42 * p;
            sqX *= 1 + 0.2 * p;
            extraRot += Math.sin(now * 0.05) * 0.05 * p;
            swayX += Math.sin(now * 0.031) * 1.4 * p;
          } else if (sp.releaseAt) {
            const t = now - sp.releaseAt;
            if (t < 1100) {
              const q = Math.exp(-t / 220) * Math.cos(t * 0.042); // 1 → качание → 0
              const ch = sp.charge; // амплитуда — по заряду: тап едва подбрасывает
              sqY *= 1 + 0.55 * ch * q;
              sqX *= 1 - 0.3 * ch * q;
              extraRot += 0.05 * ch * q;
              lift = Math.max(0, th * 0.22 * ch * q); // подпрыг — тело выстреливает вверх
            } else {
              sp.releaseAt = 0; // пружина успокоилась — снова статичное состояние
            }
          }
        }
        const wob = Math.sin(now * 0.045);
        const jx = 1 + amp * 0.22 * wob;
        const jy = 1 - amp * 0.22 * wob;
        ctx.save();
        ctx.translate(baseCx + swayX, baseY2 - lift);
        ctx.rotate(amp * 0.08 * Math.cos(now * 0.045) + extraRot);
        ctx.scale(flip * sqX * jx, sqY * jy);
        glow(-twd / 2, -th);
        ctx.drawImage(sprC, -twd / 2, -th, twd, th);
        ctx.restore();
      };

      // Боевая мишень «РАБ»: общая для комнаты, в боевом режиме (по ней проходят
      // удары), клетка непроходима. Рисуется под котами; имя постоянное.
      const drawRab = () => {
        if (!rabOnRef.current) return;
        const sprR = spritesRef.current[RAB_SPRITE.id] ?? null;
        if (sprR) {
          // мишень на плато стоит на поднятой земле
          const liftR = testMode ? elevLevelAt(RAB_POS.col, RAB_POS.row) * TERRAIN_LIFT_PX : 0;
          const tr = { x: RAB_POS.col * s.field.cellW, y: RAB_POS.row * s.field.cellH - liftR };
          drawChar(sprR, tr, RAB_SCALE, RAB_ID, false, whiteSpritesRef.current[RAB_SPRITE.id] ?? null, false);
          const thR = (s.field.cellH - 10) * (RAB_SCALE / 100);
          const nameX = tr.x + (sprR.width / sprR.height) * thR * 0.5;
          ctx.font = 'bold 12px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillText(RAB_SPRITE.name, nameX + 1, tr.y - 16);
          ctx.fillStyle = '#f4f4f5';
          ctx.fillText(RAB_SPRITE.name, nameX, tr.y - 17);
        }
      };
      runOrQueue(drawRab, RAB_POS.row * s.field.cellH + 3);

      // Манекен «ПОЧУХАТЬ»: виден всем, тащится любым игроком, позиция живёт
      // на сервере. Вне боя (удары по нему не проходят), но клетка непроходима.
      // Имя постоянное; когда кто-то тащит — над ним курсор с именем игрока.
      const drawPoch = () => {
        if (!dummyOnRef.current || !dummyPosRef.current) return;
        const sprP = spritesRef.current[dummySpriteRef.current] ?? null;
        if (sprP) {
          // манекен на плато тоже стоит на поднятой земле (клетка его позиции)
          const liftP = testMode ? elevLiftAtPoint(dummyPosRef.current.x, dummyPosRef.current.y) : 0;
          const tp =
            drag && drag.key === DUMMY_ID
              ? { x: drag.x, y: drag.y - liftP }
              : { x: dummyPosRef.current.x * s.field.cellW, y: dummyPosRef.current.y * s.field.cellH - liftP };
          drawChar(sprP, tp, DUMMY_SCALE, DUMMY_ID, false, whiteSpritesRef.current[dummySpriteRef.current] ?? null, false);
          const thP = (s.field.cellH - 10) * (DUMMY_SCALE / 100);
          const nameX = tp.x + (sprP.width / sprP.height) * thP * 0.5;
          ctx.font = 'bold 12px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillText(DUMMY_NAME, nameX + 1, tp.y - 16);
          ctx.fillStyle = '#f4f4f5';
          ctx.fillText(DUMMY_NAME, nameX, tp.y - 17);
          // Обозначение «кто тащит»: курсор-стрелка и имя игрока рядом с манекеном.
          const grab = dummyGrabRef.current;
          if (grab) {
            const gx = nameX;
            const gy = tp.y - 36;
            ctx.font = 'bold 11px Inter, system-ui, sans-serif';
            const label = grab;
            const tw = ctx.measureText(label).width;
            ctx.fillStyle = 'rgba(0,0,0,0.78)';
            ctx.beginPath();
            ctx.roundRect(gx - tw / 2 - 20, gy - 3, tw + 30, 18, 9);
            ctx.fill();
            // курсор-стрелка (как указатель мыши)
            ctx.fillStyle = '#ffd60a';
            ctx.beginPath();
            ctx.moveTo(gx - tw / 2 - 12, gy);
            ctx.lineTo(gx - tw / 2 - 12, gy + 10.5);
            ctx.lineTo(gx - tw / 2 - 9.2, gy + 7.8);
            ctx.lineTo(gx - tw / 2 - 7, gy + 12.5);
            ctx.lineTo(gx - tw / 2 - 5.4, gy + 11.7);
            ctx.lineTo(gx - tw / 2 - 7.6, gy + 7);
            ctx.lineTo(gx - tw / 2 - 4, gy + 7);
            ctx.closePath();
            ctx.fill();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#ffd60a';
            ctx.fillText(label, gx + 4, gy + 6);
            ctx.textBaseline = 'top';
          }
        }
      };
      runOrQueue(
        drawPoch,
        dummyPosRef.current
          ? Math.round(dummyPosRef.current.y) * s.field.cellH + 3
          : -1,
      );

      // манекены-мишени (каждый со своим спрайтом и ростом). Скрытая мишень не рисуется.
      for (const d of dummies) {
        if (!dummyIsDrawn(d, s.controlled)) continue;
        const sprT = brokenSpritesRef.current.has(d.sprite) ? null : (spritesRef.current[d.sprite] ?? null);
        if (!sprT && !d.id.startsWith('p')) continue;
        const tpD = posOfChar(d.id, d.col, d.row);
        const yD = tpD.y + (s.field.cellH - 10) * (d.scale / 100);
        runOrQueue(() => {
          const tp = tpD;
          if (sprT) {
            // чужой кот в мирной ходьбе разворачивается по направлению своего бега;
            // мишени и боевые коты рисуются как нарисованы
            const isRemoteFree = testMode && d.id.startsWith('p') && remoteFmRef.current.get(d.id) === 1;
            const dFlip = isRemoteFree ? (remoteFreeRef.current.get(d.id)?.face ?? 1) : 1;
            drawChar(
              sprT,
              tp,
              d.scale,
              d.id,
              false,
              whiteSpritesRef.current[d.sprite] ?? null,
              d.id === s.controlled,
              dFlip,
            );
          } else {
            // PNG ещё не пришёл или битый — кот всё равно стоит на клетке, не пропадает.
            ctx.beginPath();
            ctx.arc(tp.x + s.field.cellW / 2, tp.y + s.field.cellH * 0.55, 18, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.fill();
          }
          if (liveRemotesRef.current.length > 0) {
            const th0 = (s.field.cellH - 10) * (d.scale / 100);
            // имя — над верхом спрайта с учётом перспективы (рост меняет depthM)
            const ny = testMode ? (tp.y + th0) * camFxRef.current.sq - th0 * depthM(tp.y + th0) : tp.y;
            const nameX = sprT ? tp.x + (sprT.width / sprT.height) * th0 * 0.5 : tp.x + s.field.cellW / 2;
            ctx.font = 'bold 12px Inter, system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.fillText(d.name, nameX + 1, ny - 16);
            ctx.fillStyle = '#f4f4f5';
            ctx.fillText(d.name, nameX, ny - 17);
          }
        }, yD);
      }

      // свой кот: под управлением — по клетке движка (в мирном «тесте» — по свободной позиции),
      // иначе стоит там, где его оставили. Рельеф: кот на плато стоит на поднятой
      // земле (liftV); в боевом прыжке моделька летит от старой клетки к новой.
      // Позиция/ключ — из selfDraw(): тот же расчёт, что и для плато выше.
      const spr = spritesRef.current[s.character.sprite] ?? Object.values(spritesRef.current)[0] ?? null;
      const selfId = s.controlled;
      const mainPos = selfId === 'main' ? { col: e.col, row: e.row } : mainSavedRef.current;
      const selfFree = testMode && !s.arrow.battleMode;
      const cellX = selfDrawV.cx;
      const cellY = selfDrawV.cy;
      const cxp = cellX + s.field.cellW / 2;
      const cyp = cellY + s.field.cellH / 2;
      const drawSelf = () => {
        if (spr && mainPos) {
          drawChar(
            spr,
            { x: cellX, y: cellY },
            s.character.spriteScale,
            'main',
            false,
            whiteSpritesRef.current[s.character.sprite] ?? null,
            selfId === 'main',
            selfFree ? e.face : 1,
          );
        // Значок блока (замок) у основания стрелы своего кота — его видит только сам
        // игрок: рисуем только из локального состояния движка, по сети не ходит.
        // Замок висит по центру точки закрепления стрелы (ARROW_ANCHOR_F), а стрела
        // рисуется позже поверх — поэтому замок оказывается «под стрелой».
        // Рисуем фигурами, а не эмодзи: заливки полностью непрозрачные и вид
        // одинаков на любой платформе (эмодзи-шрифты рендерятся по-разному).
        if (selfId === 'main' && e.blocking) {
          const th0 = (s.field.cellH - 10) * (s.character.spriteScale / 100);
          const w0 = th0 * (spr.width / spr.height);
          const ax0 = cellX + w0 * ARROW_ANCHOR_F;
          const ay0 = cellY + th0 * ARROW_ANCHOR_F + s.arrow.anchorOffsetY;
          const u = th0 * 0.3;
          ctx.save();
          ctx.globalAlpha = 1;
          // дужка — полукольцо над корпусом
          ctx.beginPath();
          ctx.arc(ax0, ay0 - u * 0.16, u * 0.2, Math.PI, Math.PI * 2);
          ctx.lineWidth = u * 0.12;
          ctx.strokeStyle = '#9aa2ab';
          ctx.stroke();
          // корпус — сплошная золотая заливка с тёмной обводкой
          rr(ctx, ax0 - u * 0.31, ay0 - u * 0.16, u * 0.62, u * 0.46, u * 0.1);
          ctx.fillStyle = '#ffb02e';
          ctx.fill();
          ctx.lineWidth = Math.max(1, u * 0.05);
          ctx.strokeStyle = 'rgba(0,0,0,0.6)';
          ctx.stroke();
          // скважина
          ctx.beginPath();
          ctx.arc(ax0, ay0 + u * 0.03, u * 0.07, 0, Math.PI * 2);
          ctx.fillStyle = '#4a3200';
          ctx.fill();
          ctx.fillRect(ax0 - u * 0.035, ay0 + u * 0.03, u * 0.07, u * 0.18);
          ctx.restore();
        }
        } else if (!spr) {
          ctx.beginPath();
          ctx.arc(cxp, cyp, 18, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.25)';
          ctx.fill();
        }
      };
      runOrQueue(drawSelf, selfDrawV.key);

      /** Прямоугольник билборда персонажа (px мира) — тот же расчёт, что в drawChar:
       *  рост с перспективой, основание прижато к наклонной земле. */
      const charBillRect = (x: number, y: number, scalePct: number, aspect: number): PxRect => {
        const th0 = (s.field.cellH - 10) * (scalePct / 100);
        const groundY = y + th0;
        const th = th0 * depthM(groundY);
        const tw = th * aspect;
        const py = testMode ? groundY * camFxRef.current.sq - th : y;
        return { x0: x, y0: py, x1: x + tw, y1: py + th };
      };
      /** Прямоугольник модельки того, за кого играют: свой кот или манекен под
       *  управлением. Для проверки «объект закрывает игрока» (см. OCCLUDE_COVER). */
      const selfBillRect = (): PxRect | null => {
        if (selfId === 'main') {
          if (!spr || !mainPos) return null;
          return charBillRect(cellX, cellY, s.character.spriteScale, spr.width / spr.height);
        }
        const d = dummies.find((t) => t.id === selfId);
        const imgD = d ? spritesRef.current[d.sprite] : null;
        if (!d || !imgD) return null;
        const tpD = posOfChar(d.id, d.col, d.row);
        return charBillRect(tpD.x, tpD.y, d.scale, imgD.width / imgD.height);
      };

      // глубинная отрисовка «теста»: препятствия встают в общую очередь с котами —
      // дерево перекрывает кота позади себя и скрывается за котом перед собой.
      // Земля (проталины) — часть грунта, в очередь билбордов не попадает.
      if (testMode) {
        const fxcO = camFxRef.current;
        const selfRectO = selfBillRect();
        for (const o of testObjects()) {
          if (o.kind === 'dirt' || o.kind === 'entry' || o.kind === 'ground') continue; // земля, покрытие и заходы — часть грунта
          if (o.id === editorPlaceRef.current?.pickId) continue; // поднят в призрак редактора
          // Свободная точка опоры (доли клетки): сдвигает и точку опоры — глубинная
          // сортировка считает по ней же, деревья у края перекрывают корректно.
          // Рельеф: объект на плато стоит на поднятой земле своей клетки.
          const bO = objectBase(o);
          const objX = bO.x * s.field.cellW;
          const liftO = elevLiftAtPoint(bO.x, bO.y);
          const by = bO.y * s.field.cellH - liftO - 2;
          // Билборд стоит на наклонной земле: основание сжато тем же множителем,
          // что и точка опоры котов (groundY * sq в drawChar), сам спрайт вертикальный.
          // Без этого дерево в мирной перспективе уезжало на клетку ниже своего
          // места из редактора и не могло укрыть кота, вставшего за ним.
          const byDrawn = by * fxcO.sq;
          // Ключ глубины — линия земли своей клетки (+3.5, как у плато): дерево
          // на плато рисуется поверх своей земли, коты на клетке дерева — поверх
          // дерева только если стоят ближе (лапы ниже линии земли дерева).
          const byKey = Math.max(by, Math.floor(bO.y) * s.field.cellH + 3.5);
          const mO = depthM(by);
          const vO = hashStr(o.id) & 7;
          // Свой кот зашёл за объект и объект закрывает его хотя бы на OCCLUDE_COVER —
          // рисуем этот объект полупрозрачным (только на этом экране).
          const covered =
            !!selfRectO &&
            coveredRatio(testObjectDrawRect(o, s.field.cellH, objX, byDrawn, mO, vO), selfRectO) >= OCCLUDE_COVER;
          bills.push({
            y: byKey,
            fn: () => {
              if (covered) {
                ctx.save();
                ctx.globalAlpha = OCCLUDE_ALPHA;
                drawTestObject(ctx, o, s.field.cellW, s.field.cellH, objX, byDrawn, mO, vO);
                ctx.restore();
              } else {
                drawTestObject(ctx, o, s.field.cellW, s.field.cellH, objX, byDrawn, mO, vO);
              }
            },
          });
        }
        // «Призрак» редактора: объект, который ставят (клик фиксирует точку, колесо
        // и панель меняют размер/поворот, ✓ ставит). Полупрозрачный, с контуром тела.
        const pend = editorOpenRef.current ? editorPlaceRef.current : null;
        if (pend) {
          const ghost: TestMapObject = {
            id: '__ghost',
            kind: pend.kind,
            spr: pend.spr,
            s: pend.s,
            rot: pend.rot,
            mir: pend.mir,
            x: pend.x,
            y: pend.y,
            c: Math.min(Math.max(0, Math.floor(pend.x)), currentTestMap().cols - 1),
            r: Math.min(Math.max(0, Math.floor(pend.y - 0.01)), currentTestMap().rows - 1),
            pos: 'center',
          };
          const gX = pend.x * s.field.cellW;
          const gYraw = pend.y * s.field.cellH - elevLiftAtPoint(pend.x, pend.y) - 2;
          const gY = gYraw * fxcO.sq;
          const gM = depthM(gYraw);
          bills.push({
            y: Math.max(gYraw, Math.floor(pend.y) * s.field.cellH + 3.5),
            fn: () => {
              ctx.save();
              ctx.globalAlpha = 0.62;
              drawTestObject(ctx, ghost, s.field.cellW, s.field.cellH, gX, gY, gM, 0);
              ctx.restore();
              // контур тела + метка точки опоры: куда «встанет» препятствие
              const bG = obstacleBodyPx(ghost);
              ctx.save();
              ctx.strokeStyle = pend.anchored ? 'rgba(120, 220, 140, 0.95)' : 'rgba(255, 255, 255, 0.75)';
              ctx.lineWidth = 1.4;
              ctx.setLineDash([5, 4]);
              ctx.beginPath();
              ctx.ellipse(gX, gY, bG.hw * pend.s + 6, bG.h * pend.s + 6, (pend.rot * Math.PI) / 180, 0, Math.PI * 2);
              ctx.stroke();
              ctx.setLineDash([]);
              ctx.beginPath();
              ctx.moveTo(gX - 5, gY);
              ctx.lineTo(gX + 5, gY);
              ctx.moveTo(gX, gY - 5);
              ctx.lineTo(gX, gY + 5);
              ctx.stroke();
              ctx.restore();
            },
          });
        }
        bills.sort((a, b) => a.y - b.y);
        for (const b of bills) b.fn();
        // метки уровней рельефа в редакторе: рисуются ПОСЛЕ глубинной очереди —
        // плато своей же клеткой накрыло бы их, а уровень должен читаться всегда
        if (editorOn && ed && Object.keys(ed.elev).length > 0) {
          ctx.save();
          ctx.scale(1, camFxRef.current.sq);
          ctx.font = 'bold 11px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          for (const [keyB, lvB] of Object.entries(ed.elev)) {
            if (!lvB) continue;
            const [cB, rB] = keyB.split(',').map(Number);
            if (!Number.isFinite(cB) || !Number.isFinite(rB)) continue;
            if (cB < 0 || rB < 0 || cB >= ed.cols || rB >= ed.rows) continue;
            const xB = (cB + 0.5) * s.field.cellW;
            const yB = (rB + 0.5) * s.field.cellH - lvB * TERRAIN_LIFT_PX;
            ctx.fillStyle = 'rgba(10, 14, 8, 0.72)';
            ctx.beginPath();
            ctx.roundRect(xB - 23, yB - 10, 46, 20, 10);
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = '#eafbe7';
            ctx.fillText(`▲ ${lvB}`, xB, yB + 0.5);
          }
          ctx.restore();
        }
      }

      // галочки клеток захода — поверх любых спрайтов на земле: коты и препятствия
      // выходят билбордами поверх грунта и могут прятать разметку под собой, а вход
      // в бой должен читаться всегда. Проход в проекции грунта (наклон), после
      // глубинной очереди; в редакторе галочки уже рисует оверлей черновика.
      if (testMode && !editorOn) {
        const marks = (currentTestMap().objects ?? []).filter((o) => o.kind === 'entry' && o.dir);
        if (marks.length > 0) {
          ctx.save();
          ctx.scale(1, camFxRef.current.sq);
          ctx.clip(testFieldGeometry(s.field.cellW, s.field.cellH).path);
          for (const o of marks) {
            if (!o.dir) continue;
            drawEntryCheck(ctx, (o.c + 0.5) * s.field.cellW, (o.r + 0.5) * s.field.cellH);
          }
          ctx.restore();
        }
      }

      // параметры управляемого персонажа (спрайт/рост — для стрелы, маркера и бейджа скорости)
      const cfgSelf = selfId === 'main' ? null : (s.dummies.find((d) => d.id === selfId) ?? null);
      const scaleSelf = cfgSelf ? cfgSelf.scale : s.character.spriteScale;

      // Манекены постоянно в боевом режиме: их стрелы видны сразу, направлены по своей
      // настройке и НЕ следят за подходящим игроком; красная полоска — потраченная
      // энергия. Стрелу управляемого персонажа рисует drawArrow; настройка «Луч стрелы»
      // прячет только точку закрепления (кружок у основания) и подсветку наведения.
      // Чужие коты (id «p<число>») — по режиму с сервера (fm): в мирном режиме стрелы
      // и проценты у них не рисуются — раньше стрела была у всех и всегда, из-за чего
      // мирный кот у соседа выглядел «багованным» бойцом.
      const remoteInPeace = (id: string): boolean =>
        testMode && /^p\d+$/.test(id) && remoteFmRef.current.get(id) !== 0;
      const es0 = Math.max(1, s.combat.energyStart);
      for (const d of dummies) {
        if (d.id === selfId) continue; // за этого манекена играем — его стрела живая
        if (!dummyIsDrawn(d, selfId)) continue;
        if (remoteInPeace(d.id)) continue; // чужой кот в мирном режиме — без стрелы
        const sprT = brokenSpritesRef.current.has(d.sprite) ? null : (spritesRef.current[d.sprite] ?? null);
        if (!sprT && !d.id.startsWith('p')) continue;
        const tpA = posOfChar(d.id, d.col, d.row);
        const ta = anchorAtPx(s, sprT ? sprT.width / sprT.height : 2 / 3, tpA.x, tpA.y, d.scale);
        const tFrac = (combatRef.current.dummyEnergy[d.id] ?? es0) / es0;
        const shown = liveRemotesRef.current.length > 0 ? (remoteAimRef.current.get(d.id)?.display ?? d.angle) : d.angle;
        drawArrowBody(s, ta.k, ta.ax, ta.ay, shown, tFrac, s.arrow.showRay);
      }

      // стрела своего кота, пока им не управляем: стоит с тем углом, что был оставлен
      if (selfId !== 'main' && mainSavedRef.current && s.arrow.battleMode) {
        const ms = mainSavedRef.current;
        const sprM = spritesRef.current[s.character.sprite] ?? null;
        if (sprM) {
          const ma = anchorOf(s, sprM.width / sprM.height, ms.col, ms.row, s.character.spriteScale);
          const mFrac = combatRef.current.playerEnergy / es0;
          drawArrowBody(s, ma.k, ma.ax, ma.ay, ms.angle, mFrac, s.arrow.showRay);
        }
      }

      if (s.arrow.battleMode) {
        drawArrow(s, e);
      }

      // живой маркер наведения: точка, где луч стрелы входит в тело цели,
      // подсвечена цветом зоны, которая сработает при ударе с текущим углом
      // (только для прямой стойки: с диагонали зону задаёт правило окон)
      if (s.arrow.battleMode && s.arrow.showRay) {
        const mpAim = selfId === 'main' ? null : mainSavedRef.current;
        const tm = pickStrikeTarget(s, e.col, e.row, e.angle, selfId, mpAim, liveRemotesRef.current, rabExtra());
        const diagM = !!tm && Math.abs(tm.col - e.col) === 1 && Math.abs(tm.row - e.row) === 1;
        const sprTm = tm ? (spritesRef.current[tm.sprite] ?? null) : null;
        const sprSelf = spritesRef.current[cfgSelf ? cfgSelf.sprite : s.character.sprite] ?? null;
        if (tm && !diagM && sprSelf && sprTm && strikeTargetDrawn(s, tm.id, selfId)) {
          const am = anchorOf(s, sprSelf.width / sprSelf.height, e.col, e.row, scaleSelf);
          const bmp = posOfChar(tm.id, tm.col, tm.row);
          const bm = spriteBoxOf(s, sprTm.width / sprTm.height, tm.col, tm.row, tm.scale);
          bm.x = bmp.x;
          bm.y = bmp.y;
          const radm = (e.angle * Math.PI) / 180;
          const hm = rayBox(am.ax, am.ay, Math.cos(radm), Math.sin(radm), bm.x, bm.y, bm.w, bm.h);
          const zm = hm.hit ? resolveZonePixel(hm.ny, entrySide(hm), s.combat.zones) : null;
          if (zm) {
            ctx.beginPath();
            ctx.arc(hm.px, hm.py, 6.5, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255,255,255,0.55)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(hm.px, hm.py, 4.5, 0, Math.PI * 2);
            ctx.strokeStyle = zm.color;
            ctx.lineWidth = 2.5;
            ctx.stroke();
          }
        }
      }

      // панельки энергии под персонажами (в боевом режиме): x/y — левый верхний угол спрайта в px
      const drawEnergyBadge = (x: number, y: number, sprImg: HTMLImageElement | null, pct: number, scalePct: number) => {
        const h = (s.field.cellH - 10) * (scalePct / 100);
        const w = h * (sprImg ? sprImg.width / sprImg.height : 2 / 3);
        const bx = x + w / 2;
        const by = y + h + 2;
        const text = `${pct}%`;
        ctx.font = 'bold 13px Inter, system-ui, sans-serif';
        const tw = ctx.measureText(text).width + 12;
        rr(ctx, bx - tw / 2, by, tw, 18, 5);
        ctx.fillStyle = 'rgba(8,10,12,0.72)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#f4f4f5';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, bx, by + 9.5);
      };
      // панельки энергии: у видимого манекена всегда, у чужого боевого кота — тоже,
      // у чужого мирного кота — нет (он не в бою); у своего кота — в боережиме.
      // Скрытая мишень без панельки, чтобы клетка выглядела пустой.
      for (const d of dummies) {
        if (!dummyIsDrawn(d, selfId)) continue;
        if (remoteInPeace(d.id)) continue;
        const tpE = posOfChar(d.id, d.col, d.row);
        drawEnergyBadge(
          tpE.x,
          tpE.y,
          spritesRef.current[d.sprite] ?? null,
          Math.round(Math.min(combatRef.current.dummyEnergy[d.id] ?? es0, es0)),
          d.scale,
        );
      }
      if (s.arrow.battleMode && mainPos && spr) {
        drawEnergyBadge(
          cellX,
          cellY,
          spr,
          Math.round(Math.min(combatRef.current.playerEnergy, es0)),
          s.character.spriteScale,
        );
      }

      // бейдж скорости под тем, кем управляем (в бою сдвинут ниже панельки энергии)
      if (s.slowdown.showSpeedBadge) {
        const text = `${Math.round(e.lastSpeed)}%`;
        ctx.font = 'bold 13px Inter, system-ui, sans-serif';
        const tw = ctx.measureText(text).width + 12;
        const scx = e.col * s.field.cellW + s.field.cellW / 2;
        const scellY = e.row * s.field.cellH;
        const scyp = scellY + s.field.cellH / 2;
        const bx = scx - tw / 2;
        const by = s.arrow.battleMode ? scellY + (s.field.cellH - 10) * (scaleSelf / 100) + 22 : scyp + s.field.cellH * 0.48;
        rr(ctx, bx, by, tw, 18, 4);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fill();
        ctx.fillStyle = tierColor(100 - e.lastSpeed);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, scx, by + 9.5);
      }

      // всплывающие метки
      for (const l of e.labels) {
        const age = (now - l.born) / 900;
        ctx.globalAlpha = 1 - age;
        ctx.font = 'bold 16px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillText(l.text, l.x + 1, l.y - 36 * age + 1);
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, l.x, l.y - 36 * age);
        ctx.globalAlpha = 1;
      }

      if (testMode) {
        // мир выведен, камера больше не нужна — HUD рисуем в экранных координатах
        ctx.restore();
        if (s.hud.show) drawHud(s, e, vw);
      } else if (s.hud.show) {
        drawHud(s, e);
      }
    };

    // Отладочный доступ к состоянию движка — только в dev-сборке (автотесты);
    // в продакшене недоступен и на игру не влияет.
    if (process.env.NODE_ENV !== 'production') {
      (window as unknown as Record<string, unknown>).__simState = () => {
        const st = engineRef.current;
        const dg = dragRef.current;
        const ms = mainSavedRef.current;
        return {
          col: st.col,
          row: st.row,
          angle: Math.round(wrap360(st.angle)),
          fx: Math.round(st.fx * 100) / 100,
          fy: Math.round(st.fy * 100) / 100,
          format: fieldFormatRef.current,
          battle: settingsRef.current.arrow.battleMode,
          cam: { x: Math.round(camRef.current.x), y: Math.round(camRef.current.y), init: camRef.current.init },
          camFx: {
            z: Math.round(camFxRef.current.z * 100) / 100,
            sq: Math.round(camFxRef.current.sq * 100) / 100,
          },
          hopping: false,
          route: st.ptarget ? 1 : 0,
          stepping: !!st.step,
          stepDur: st.step ? Math.round(st.step.dur) : 0,
          stepLeft: st.step ? Math.max(0, Math.round(st.step.dur - (performance.now() - st.step.start))) : 0,
          held: [...st.held],
          controlled: settingsRef.current.controlled,
          main: ms ? { col: ms.col, row: ms.row, angle: Math.round(wrap360(ms.angle)) } : null,
          drag: dg ? { key: dg.key, x: Math.round(dg.x), y: Math.round(dg.y), moved: dg.moved } : null,
          jelly: Object.fromEntries(
            Object.entries(jellyRef.current).map(([k2, v]) => [k2, Math.round((v ?? 0) * 100) / 100]),
          ),
          dummy: dummyOnRef.current
            ? { x: dummyPosRef.current?.x ?? null, y: dummyPosRef.current?.y ?? null, sprite: dummySpriteRef.current, grab: dummyGrabRef.current }
            : null,
          rab: rabOnRef.current ? { col: RAB_POS.col, row: RAB_POS.row } : null,
          dummies: dummiesOf(settingsRef.current, liveRemotesRef.current).map((d) => {
            const vis = remoteDrawRef.current.get(d.id);
            return {
              id: d.id,
              col: d.col,
              row: d.row,
              drawCol: vis?.col ?? d.col,
              drawRow: vis?.row ?? d.row,
              queued: vis?.queue.length ?? 0,
            };
          }),
        };
      };
    }

    // Часы атмосферы + HUD: непрерывные сутки едут в Pixi-слой, погода без сети
    // доезжает локально (в комнате её двигает сервер), HUD рисуется поверх.
    const tickAtmo = () => {
      const t = Date.now();
      let clk = atmoAnchorRef.current;
      if (!clk.srv && clk.pl > 0 && clk.wl > 0 && t - clk.ws >= clk.wl) {
        const others = WEATHERS.filter((x) => x !== clk.w);
        const nw = others[Math.floor(Math.random() * others.length)];
        clk = { ...clk, w: nw, ws: t };
        atmoAnchorRef.current = clk;
        atmoRef.current?.setWeather(nw);
      }
      const p4 = clk.pl > 0 ? dayProgressAt(clk.cs, clk.pl, t) : 1.5;
      atmoRef.current?.setDayProgress(p4);
      // Погода: смена — кроссфейд значка на HUD и обновление кнопок панели.
      const wx = hudWxRef.current;
      if (wx.w !== clk.w) {
        hudWxRef.current = { w: clk.w, prev: wx.w, at: performance.now() };
        atmoStateRef.current = { ...atmoStateRef.current, w: clk.w };
        // eslint-disable-next-line react-hooks/set-state-in-event
        setAtmoState((p) => (p.w === clk.w ? p : { ...p, w: clk.w }));
      }
      // Часть суток сменилась — подсветить её в панели (редкий setState, раз в фазу).
      const phase = dayPartOfProgress(p4);
      if (atmoStateRef.current.dp !== phase) {
        atmoStateRef.current = { ...atmoStateRef.current, dp: phase };
        // eslint-disable-next-line react-hooks/set-state-in-event
        setAtmoState((p) => (p.dp === phase ? p : { ...p, dp: phase }));
      }
      // HUD поверх слоя атмосферы: сам не темнеет и не прячется под дождём.
      const hud = hudRef.current;
      if (hud) {
        const vw = cv.clientWidth || 0;
        const vh = cv.clientHeight || 0;
        if (vw > 0 && vh > 0) {
          const w2 = hudWxRef.current;
          drawFieldHud(hud, vw, vh, p4, w2.w, w2.prev, w2.at);
        }
      }
    };

    const loop = (now: number) => {
      const dt = Math.min(50, now - prev);
      prev = now;
      update(now, dt);
      draw(now);
      // Атмосфера: Pixi-слой забирает готовый кадр 2D-холста как текстуру и
      // выводит его с цветокоррекцией, тенями облаков и дождём.
      const cam = camRef.current;
      const cp = camPrevRef.current;
      atmoRef.current?.frame(now, dt, cp ? cam.x - cp.x : 0, cp ? cam.y - cp.y : 0);
      camPrevRef.current = { x: cam.x, y: cam.y };
      tickAtmo();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      cv.removeEventListener('wheel', onWheelZoom);
    };
  }, [stage]);

  /* ---------- ручной угол стрелы ---------- */

  // Живой угол читается панелью через геттер и обновляется внутри изолированного
  // компонента LiveAngle: периодические обновления не перерисовывают остальную
  // панель и родителя, из-за чего раньше стрела двигалась рвано.
  const getEngineAngle = useCallback(() => engineRef.current.angle, []);

  const setEngineAngle = useCallback((v: number, force = false) => {
    const angle = wrap360(v);
    engineRef.current.angle = angle;
    // Пока ползунок едет — тот же ритм, что у J/L. Отпускание и ввод числа — сразу.
    publishAimRef.current(angle, force);
  }, []);

  /* ---------- клавиатура ---------- */

  useEffect(() => {
    const isForm = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    };
    const down = (ev: KeyboardEvent) => {
      // Shift — спринт мирного режима (×2 к скорости + комочки из-под лап):
      // ловим раньше всех ранних выходов, зажатие не зависит от контекста
      if (ev.key === 'Shift') sprintRef.current = true;
      if (!enteredRef.current) return;
      if (isForm(ev.target)) return;
      // Редактор локации: Esc — закрыть (черновик без записи), игровые клавиши молчат.
      if (editorOpenRef.current) {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          closeEditor();
        }
        return;
      }
      // Пробел — «приседание-желе» своего кота: удержание приплющивает модельку
      // (полный эффект за 4 с, с дрожью), отпускание выстреливает её вверх.
      // Автоповтор ОС не перезапускает приседание — важен только первый нажатие.
      if (ev.code === 'Space' || ev.key === ' ') {
        ev.preventDefault();
        if (!ev.repeat && settingsRef.current.controlled === 'main' && !engineRef.current.blocking) {
          const sp = spaceHoldRef.current;
          if (!sp.holding) {
            sp.holding = true;
            sp.since = performance.now();
            sp.releaseAt = 0;
            sp.charge = 0;
            // Присед видят все: комнату ставим в известность (эхо себе не приходит).
            netRef.current?.emit('space', { on: true });
          }
        }
        return;
      }
      const action = keyAction(ev);
      const t = ev.target as HTMLElement | null;
      if (t && t.tagName === 'BUTTON' && (action?.type === 'chat' || ev.code === 'Space' || ev.key === ' ')) t.blur();
      // автоповтор ОС игнорируем: каждое физическое нажатие — ровно одно срабатывание;
      // темп движения ограничен только замедлением (спам не превышает скорость шага)
      if (ev.repeat) return;
      if (!action) return;
      const eB = engineRef.current;
      // Блок (удержание К): встаёт в стойку сразу, снимается отпусканием.
      if (action.type === 'block') {
        ev.preventDefault();
        // Блок — стойка игрока (своего кота): за манекеном блокировать нечего.
        if (settingsRef.current.controlled !== 'main' || eB.blocking) return;
        eB.blocking = true;
        // В блоке нельзя двигаться, бить и крутить стрелу — всё начатое прекращаем.
        eB.held = [];
        eB.path = [];
        eB.step = null;
        eB.rot = 0;
        eB.strikeHeld = false;
        netRef.current?.emit('block', { on: true });
        return;
      }
      // Пока блок держится — движение, удары и вращение не работают.
      if (eB.blocking && (action.type === 'rot' || action.type === 'strike' || action.type === 'move')) {
        ev.preventDefault();
        return;
      }
      if (action.type === 'rot') {
        ev.preventDefault();
        engineRef.current.rot = action.sign;
        return;
      }
      if (action.type === 'chat') {
        if (t?.tagName === 'BODY' || t?.tagName === 'CANVAS') {
          ev.preventDefault();
          document.getElementById('roomChatInput')?.focus();
        }
        return;
      }
      if (action.type === 'battle') {
        // В «тесте» бой включается кнопкой с клетки захода (та же логика, что
        // у кнопки в шапке); в обычных комнатах B — прямой тумблер.
        battleToggleRef.current();
        return;
      }
      if (action.type === 'strike') {
        ev.preventDefault();
        const e = engineRef.current;
        e.strikeHeld = true;
        e.nextHoldStrike = performance.now() + strikeResponseMs(settingsRef.current);
        doStrikeRef.current?.();
        return;
      }
      ev.preventDefault();
      const e = engineRef.current;
      if (!e.held.includes(action.dir)) {
        e.held.push(action.dir);
        e.path = [];
      }
      // мирный «тест»: ходьба свободная (по пикселям) — её ведёт игровой цикл
      // по зажатым клавишам; клик-цель перебивается клавишами там же.
      const sK = settingsRef.current;
      if (fieldFormatRef.current === 'test' && !sK.arrow.battleMode && sK.controlled === 'main') {
        e.ptarget = null;
        return;
      }
      // одиночное нажатие: шаг сразу, если предыдущий завершён, — быстрее,
      // чем разрешает замедление, двигаться нельзя
      startStepRef.current?.(action.dir);
    };
    const up = (ev: KeyboardEvent) => {
      if (ev.key === 'Shift') sprintRef.current = false;
      // Отпускание пробела — желейный «выстрел» вверх из приплющенного состояния
      // и прыжок через обрыв: заряд (длительность удержания) определяет максимальный
      // перепад. Сам прыжок запускает игровой цикл — забирает запрос из leapRequestRef.
      if (ev.code === 'Space' || ev.key === ' ') {
        const sp = spaceHoldRef.current;
        if (sp.holding) {
          sp.holding = false;
          // Заряд «выстрела» по времени удержания: тап — минимальный подпрыг,
          // полные 4 с приседа — максимальный (нижняя планка 0.15, чтобы тап
          // не был нулевым, а верхняя ровно 1 — дальше заряд не растёт).
          sp.charge = 0.15 + 0.85 * Math.min(1, (performance.now() - sp.since) / 4000);
          sp.releaseAt = performance.now();
          leapRequestRef.current = sp.charge;
          // hold — длительность удержания: чужие клиенты посчитают по ней заряд,
          // не сверяя часы (у каждого свои performance.now()).
          netRef.current?.emit('space', { on: false, hold: Math.round(sp.releaseAt - sp.since) });
        }
        return;
      }
      const e = engineRef.current;
      const action = keyAction(ev);
      if (!action) return;
      if (action.type === 'block') {
        if (e.blocking) {
          e.blocking = false;
          netRef.current?.emit('block', { on: false });
        }
        return;
      }
      if (action.type === 'rot') {
        if (action.sign === -1 && e.rot === -1) e.rot = 0;
        if (action.sign === 1 && e.rot === 1) e.rot = 0;
      } else if (action.type === 'strike') {
        e.strikeHeld = false;
      } else if (action.type === 'move') {
        e.held = e.held.filter((d) => d !== action.dir);
      }
    };
    const blur = () => {
      const e = engineRef.current;
      e.held = [];
      e.rot = 0;
      e.strikeHeld = false;
      sprintRef.current = false; // Shift при потере фокуса уже не поймаем
      // Пробел при потере фокуса: keyup не придёт — тихо снимаем присед без
      // «выстрела», иначе кот застыл бы приплющенным навсегда.
      const sp = spaceHoldRef.current;
      if (sp.holding) {
        sp.holding = false;
        sp.releaseAt = 0;
        // Присед снят без «выстрела» — чужим тоже (cancel: кот просто выпрямится).
        netRef.current?.emit('space', { on: false, cancel: true });
      }
      // Окно потеряло фокус при зажатом блоке — стойку снимаем, иначе кот
      // остался бы в блоке навсегда (keyup уже не пришёл бы).
      if (e.blocking) {
        e.blocking = false;
        netRef.current?.emit('block', { on: false });
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  /* ---------- мышь ---------- */

  const canvasPoint = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current!;
    const rect = cv.getBoundingClientRect();
    const mx = ((ev.clientX - rect.left) * cv.width) / rect.width;
    const my = ((ev.clientY - rect.top) * cv.height) / rect.height;
    return { mx, my };
  };

  /** Манекен, чей спрайт накрыт точкой (mx,my) канваса (с небольшим запасом в 4px).
   *  Управляемый манекен проверяется по его фактической клетке (движок), остальные — по настройкам. */
  const hitTargetAt = (s: SimSettings, mx: number, my: number): DummyConfig | null => {
    const e = engineRef.current;
    for (const d of dummiesOf(s, liveRemotesRef.current)) {
      if (!dummyIsDrawn(d, s.controlled)) continue;
      const sprT = spritesRef.current[d.sprite] ?? null;
      const pos =
        d.id === s.controlled
          ? { x: e.col * s.field.cellW, y: e.row * s.field.cellH }
          : { x: d.col * s.field.cellW, y: d.row * s.field.cellH };
      const b = spriteBoxOf(s, sprT ? sprT.width / sprT.height : 2 / 3, 0, 0, d.scale);
      if (mx >= pos.x - 4 && mx <= pos.x + b.w + 4 && my >= pos.y - 4 && my <= pos.y + b.h + 4) return d;
    }
    return null;
  };

  /** Прямоугольник манекена под точкой (mx,my) канваса — px и размеры спрайта, либо null.
   *  Пока манекен тащат, проверка не нужна: его уже удерживает захват указателя. */
  const hitDummyObjAt = (s: SimSettings, mx: number, my: number) => {
    if (!dummyOnRef.current) return null;
    const pos = dummyPosRef.current;
    if (!pos) return null;
    const sprT = spritesRef.current[dummySpriteRef.current] ?? null;
    const b = spriteBoxOf(s, sprT ? sprT.width / sprT.height : 2 / 3, 0, 0, DUMMY_SCALE);
    const px = pos.x * s.field.cellW;
    const py = pos.y * s.field.cellH;
    if (mx >= px - 4 && mx <= px + b.w + 4 && my >= py - 4 && my <= py + b.h + 4) {
      return { x: px, y: py, w: b.w, h: b.h };
    }
    return null;
  };

  const onMove = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const s = settingsRef.current;
    const e = engineRef.current;
    const testMode = fieldFormatRef.current === 'test';
    // «Тест»: мир больше вьюпорта — курсор переводится в мировые координаты через камеру
    let { mx, my } = canvasPoint(ev);
    if (testMode) {
      const cvp = canvasRef.current;
      if (cvp) {
        const rect = cvp.getBoundingClientRect();
        // обратная проекция камеры: зум сужает окно, наклон сжимает вертикаль земли
        const fxc = camFxRef.current;
        mx = (ev.clientX - rect.left - cvp.clientWidth / 2) / fxc.z + camRef.current.x;
        my = (ev.clientY - rect.top - cvp.clientHeight / 2) / (fxc.z * fxc.sq) + camRef.current.y;
      }
      // Редактор: курсор ведёт тянущийся прямоугольник (и подсвечивает клетку);
      // «Земля»/«Покрытие» при зажатой кнопке красят протяжкой; «призрак»
      // камня/дерева следует за курсором, пока точка не зафиксирована кликом.
      const ed = editorRef.current;
      if (editorOpenRef.current && ed) {
        const c = Math.min(ed.cols - 1, Math.max(0, Math.floor(mx / s.field.cellW)));
        const r = Math.min(ed.rows - 1, Math.max(0, Math.floor(my / s.field.cellH)));
        if (ed.drag) {
          ed.drag.c1 = c;
          ed.drag.r1 = r;
        }
        if (dirtPaintingRef.current && (ed.tool === 'dirt' || ed.tool === 'ground') && ev.buttons & 1) {
          paintEditorCellObject(ed.tool === 'ground' ? 'ground' : 'dirt', c, r);
        }
        // протяжка «Спавна» — только добавляет точки (снимает кликом)
        if (dirtPaintingRef.current && ed.tool === 'spawn' && ev.buttons & 1) {
          addEditorSpawn(c, r);
        }
        // протяжка кистей рельефа: каждая клетка росчерка — один раз
        if (dirtPaintingRef.current && (ed.tool === 'raise' || ed.tool === 'lower' || ed.tool === 'flat') && ev.buttons & 1) {
          applyElevBrush(ed.tool, c, r);
        }
        // мазок кисти локации: ЛКМ — материал, ПКМ — ластик; холст черновика
        // становится активным рисунком сразу (маска обновляется, контур — по
        // окончании росчерка, см. onUp)
        if (paintStrokeRef.current && ed.tool === 'paint' && ed.pcv) {
          if (ev.buttons & 2) stampPaintBrush(ed, 'erase', mx, my, s.field.cellW, s.field.cellH);
          else if (ev.buttons & 1) stampPaintBrush(ed, ed.pmat, mx, my, s.field.cellW, s.field.cellH);
          setPaintOverride(ed.pcv, false);
        }
        const pG = editorPlaceRef.current;
        if (pG && !pG.anchored) {
          // пишем прямо в ref: кадр читает его каждый тик, панель позиции не показывает
          const b = clampPlacePos(mx / s.field.cellW, my / s.field.cellH);
          pG.x = b.x;
          pG.y = b.y;
        }
        e.hover = { c, r };
        const cvE = canvasRef.current;
        if (cvE) cvE.style.cursor = 'crosshair';
        return;
      }
      // Прицел прыжка: курсор в мире с поправкой на подъём земли — клик по
      // видимой поверхности возвышенности указывает в её клетку, а не в землю
      // перед обрывом. В редакторе прицел не нужен (прыжка там нет).
      cursorWorldRef.current = groundPointAtWorld(mx, my, s.field.cellW, s.field.cellH);
    }
    const dg = dragRef.current;
    if (dg) {
      // перетаскивание: спрайт следует за курсором в пределах поля,
      // скорость мыши раскачивает «желе» — быстрое дрожание качает манекен
      const nowT = performance.now();
      const dtm = Math.max(1, nowT - dg.lastT);
      const speed = Math.hypot(mx - dg.lastX, my - dg.lastY) / dtm; // px/мс
      jellyRef.current[dg.key] = Math.max(jellyRef.current[dg.key] ?? 0, Math.min(1, speed / 2.2));
      dg.x = Math.min(Math.max(mx - dg.grabDX, 0), s.field.cols * s.field.cellW - dg.w);
      dg.y = Math.min(Math.max(my - dg.grabDY, 0), s.field.rows * s.field.cellH - dg.h);
      if (Math.abs(mx - dg.lastX) > 2 || Math.abs(my - dg.lastY) > 2) dg.moved = true;
      dg.lastX = mx;
      dg.lastY = my;
      dg.lastT = nowT;
      if (dg.key === DUMMY_ID) {
        // Манекен — общий: пока тащим, позиция уходит на сервер с постоянным темпом,
        // чтобы остальные видели движение в реальном времени.
        const net = netRef.current;
        if (net?.ready && nowT - dummySyncRef.current.at >= DUMMY_EMIT_MS) {
          dummySyncRef.current.at = nowT;
          net.emit('dummyMove', { x: round2(dg.x / s.field.cellW), y: round2(dg.y / s.field.cellH) });
        }
      }
      return;
    }
    const c = Math.floor(mx / s.field.cellW);
    const r = Math.floor(my / s.field.cellH);
    // подсветка клетки — в бою и только по проходимым зонам «теста» (и по заходам)
    const hoverOk =
      c >= 0 &&
      c < s.field.cols &&
      r >= 0 &&
      r < s.field.rows &&
      (!testMode || (s.arrow.battleMode && (testWalkableCell(c, r) || !!testEntryAt(c, r))));
    if (hoverOk) e.hover = { c, r };
    else e.hover = null;
    const cv = canvasRef.current;
    if (testMode) {
      // манекена в «тесте» нет — таскать нечего; ходьба свободная, курсор обычный
      if (cv) cv.style.cursor = '';
      return;
    }
    const hov = hitTargetAt(s, mx, my);
    const hovT = hitDummyObjAt(s, mx, my);
    if (cv) cv.style.cursor = hovT || (hov && hov.id !== s.controlled) ? 'grab' : '';
  };

  const onLeave = () => {
    const e = engineRef.current;
    e.hover = null;
    const cv = canvasRef.current;
    if (cv && !dragRef.current) cv.style.cursor = '';
  };

  /** Захват манекена: зажатая ЛКМ на его спрайте начинает перетаскивание.
   *  В редакторе локации зажатая кнопка начинает рисунок зоны (ПКМ — стирание). */
  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const ed = editorRef.current;
    if (editorOpenRef.current && ed) {
      if (ev.button !== 0 && ev.button !== 2) return;
      const s = settingsRef.current;
      const cvp = canvasRef.current;
      let mx = 0;
      let my = 0;
      if (cvp) {
        const rect = cvp.getBoundingClientRect();
        const fxc = camFxRef.current;
        mx = (ev.clientX - rect.left - cvp.clientWidth / 2) / fxc.z + camRef.current.x;
        my = (ev.clientY - rect.top - cvp.clientHeight / 2) / (fxc.z * fxc.sq) + camRef.current.y;
      }
      const c = Math.min(ed.cols - 1, Math.max(0, Math.floor(mx / s.field.cellW)));
      const r = Math.min(ed.rows - 1, Math.max(0, Math.floor(my / s.field.cellH)));
      // Инструменты препятствий: призрак постановки (клик — фиксация/подъём);
      // «Земля» и «Покрытие» красятся кликом и протяжкой (одна отмена на росчерк);
      // ПКМ по-прежнему рисует ластик, чтобы стирать зоны и объекты протяжкой.
      if (ev.button === 0 && ed.tool === 'entry') {
        placeEditorEntry(c, r);
        ev.preventDefault();
        return;
      }
      if (ev.button === 0 && ed.tool === 'spawn') {
        // Клик — поставить/снять точку появления; протяжка — только ставит
        // (без снятия), как у «Земли»/«Покрытия».
        pushEditorUndo();
        toggleEditorSpawn(c, r);
        dirtPaintingRef.current = true;
        ev.currentTarget.setPointerCapture(ev.pointerId);
        ev.currentTarget.style.cursor = 'crosshair';
        ev.preventDefault();
        return;
      }
      if (ev.button === 0 && (ed.tool === 'stone' || ed.tool === 'tree')) {
        editorPlacementClick(mx, my);
        ev.preventDefault();
        return;
      }
      if (ev.button === 0 && ed.tool === 'battle') {
        placeBattleCell(c, r);
        ev.preventDefault();
        return;
      }
      if ((ev.button === 0 || ev.button === 2) && ed.tool === 'paint') {
        // Кисть локации: ЛКМ — выбранный материал, ПКМ — ластик. Росчерк ставит
        // один снимок отмены; контур локации пересчитается на отпускании.
        ensureDraftPaint(ed);
        pushPaintUndo(ed);
        paintStrokeRef.current = true;
        stampPaintBrush(ed, ev.button === 2 ? 'erase' : ed.pmat, mx, my, s.field.cellW, s.field.cellH);
        if (ed.pcv) setPaintOverride(ed.pcv, false);
        ed.dirty = true;
        ev.currentTarget.setPointerCapture(ev.pointerId);
        ev.currentTarget.style.cursor = 'crosshair';
        ev.preventDefault();
        return;
      }
      if (ev.button === 0 && (ed.tool === 'dirt' || ed.tool === 'ground')) {
        pushEditorUndo();
        dirtPaintingRef.current = true;
        paintEditorCellObject(ed.tool === 'ground' ? 'ground' : 'dirt', c, r);
        ev.currentTarget.setPointerCapture(ev.pointerId);
        ev.currentTarget.style.cursor = 'crosshair';
        ev.preventDefault();
        return;
      }
      if (ev.button === 0 && (ed.tool === 'raise' || ed.tool === 'lower' || ed.tool === 'flat')) {
        pushEditorUndo();
        dirtPaintingRef.current = true;
        beginElevStroke(ed.tool, c, r);
        ev.currentTarget.setPointerCapture(ev.pointerId);
        ev.currentTarget.style.cursor = 'crosshair';
        ev.preventDefault();
        return;
      }
      ed.drag = { c0: c, r0: r, c1: c, r1: r, erase: ev.button === 2 };
      ev.currentTarget.setPointerCapture(ev.pointerId);
      ev.currentTarget.style.cursor = 'crosshair';
      ev.preventDefault();
      return;
    }
    if (ev.button !== 0) return;
    const s = settingsRef.current;
    const { mx, my } = canvasPoint(ev);
    // Манекен тащится всегда (и в комнате с игроками — это его смысл):
    // захват до проверки манекенов, чтобы живые коты его не блокировали.
    const tObj = hitDummyObjAt(s, mx, my);
    if (tObj) {
      dragRef.current = {
        key: DUMMY_ID,
        grabDX: mx - tObj.x,
        grabDY: my - tObj.y,
        x: tObj.x,
        y: tObj.y,
        w: tObj.w,
        h: tObj.h,
        lastX: mx,
        lastY: my,
        lastT: performance.now(),
        moved: false,
      };
      // Комната видит курсор с именем тащщего; своё имя рисуем тоже — после dummyGrab.
      const net = netRef.current;
      if (net?.ready) net.emit('dummyGrab');
      ev.currentTarget.setPointerCapture(ev.pointerId);
      ev.currentTarget.style.cursor = 'grabbing';
      ev.preventDefault();
      return;
    }
    const t = hitTargetAt(s, mx, my);
    if (!t) return;
    if (liveRemotesRef.current.length > 0) return; // чужих игроков не таскаем
    if (t.id === s.controlled) return; // активную (управляемую) модель перетаскивать нельзя
    const sprT = spritesRef.current[t.sprite] ?? null;
    const pos = { x: t.col * s.field.cellW, y: t.row * s.field.cellH };
    const b = spriteBoxOf(s, sprT ? sprT.width / sprT.height : 2 / 3, 0, 0, t.scale);
    dragRef.current = {
      key: t.id,
      grabDX: mx - pos.x,
      grabDY: my - pos.y,
      x: pos.x,
      y: pos.y,
      w: b.w,
      h: b.h,
      lastX: mx,
      lastY: my,
      lastT: performance.now(),
      moved: false,
    };
    // захват указателя: move/up продолжают приходить даже за пределами канваса
    ev.currentTarget.setPointerCapture(ev.pointerId);
    ev.currentTarget.style.cursor = 'grabbing';
    ev.preventDefault();
  };

  /** Завершение перетаскивания: манекен ставится в клетку под его центром; если она
   *  занята другим персонажем — берётся ближайшая свободная. */
  const dropTarget = () => {
    const dg = dragRef.current;
    if (!dg) return;
    dragRef.current = null;
    skipClickRef.current = dg.moved;
    const cv = canvasRef.current;
    if (cv) cv.style.cursor = '';
    const s = settingsRef.current;
    let c = Math.floor((dg.x + dg.w / 2) / s.field.cellW);
    let r = Math.floor((dg.y + dg.h / 2) / s.field.cellH);
    c = Math.min(Math.max(c, 0), s.field.cols - 1);
    r = Math.min(Math.max(r, 0), s.field.rows - 1);
    if (dg.key === DUMMY_ID) {
      // Манекен — общий предмет: с котами не конфликтует, ставится в клетку под центром
      // и отправляет финальную позицию на сервер (без ожидания темпа рассылки).
      dummyPosRef.current = { x: c, y: r };
      dummySyncRef.current.at = performance.now();
      const net = netRef.current;
      if (net?.ready) {
        net.emit('dummyMove', { x: c, y: r });
        net.emit('dummyDrop');
      }
      return;
    }
    const e = engineRef.current;
    const mp = s.controlled === 'main' ? null : mainSavedRef.current;
    // занято любым персонажем, кроме перетаскиваемого: управляемый (движок),
    // свой кот (когда стоит сам) и остальные манекены
    const occupied = (cc: number, cr: number) => {
      if (dg.key !== s.controlled && e.col === cc && e.row === cr) return true;
      if (s.controlled !== 'main' && mp && mp.col === cc && mp.row === cr) return true;
      return dummiesOf(s, liveRemotesRef.current).some((d) => d.id !== dg.key && d.col === cc && d.row === cr);
    };
    if (occupied(c, r)) {
      search: for (let rad = 1; rad <= 4; rad++) {
        for (let drr = -rad; drr <= rad; drr++) {
          for (let dcc = -rad; dcc <= rad; dcc++) {
            if (Math.max(Math.abs(dcc), Math.abs(drr)) !== rad) continue;
            const cc = c + dcc;
            const cr = r + drr;
            if (cc < 0 || cc >= s.field.cols || cr < 0 || cr >= s.field.rows) continue;
            if (!occupied(cc, cr)) {
              c = cc;
              r = cr;
              break search;
            }
          }
        }
      }
    }
    const cur = s.dummies.find((d) => d.id === dg.key);
    if (!cur || (cur.col === c && cur.row === r)) return; // позиция не изменилась
    patchDummy(dg.key, { col: c, row: r });
  };

  const onUp = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    // Редактор: отпускание кнопки завершает рисунок — прямоугольник становится
    // зоной; росчерк «Земли» просто заканчивается (отмена уже записана).
    const ed = editorRef.current;
    dirtPaintingRef.current = false;
    endElevStroke();
    // Мазок кисти закончен: пересчитываем контур локации по обновлённой маске.
    if (paintStrokeRef.current) {
      paintStrokeRef.current = false;
      if (ed?.pcv) setPaintOverride(ed.pcv, true);
    }
    if (editorOpenRef.current && ed) {
      try {
        ev.currentTarget.releasePointerCapture(ev.pointerId);
      } catch {
        /* захват мог уже сняться */
      }
      commitEditorDrag();
      const cvE = canvasRef.current;
      if (cvE) cvE.style.cursor = 'crosshair';
      return;
    }
    if (!dragRef.current) return;
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    } catch {
      /* захват мог уже сняться */
    }
    dropTarget();
  };

  /** ПКМ в редакторе — стирание без смены инструмента; вне редактора меню не нужно. */
  const onContextMenu = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    ev.preventDefault();
  };

  const onClick = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    // клик сразу после перетаскивания маршрут не строит
    if (skipClickRef.current) {
      skipClickRef.current = false;
      return;
    }
    // В редакторе клики обрабатывает рисунок зон (pointer down/up) — маршруты не строим.
    if (editorOpenRef.current && editorRef.current) return;
    const s = settingsRef.current;
    const e = engineRef.current;
    const testMode = fieldFormatRef.current === 'test';
    let { mx, my } = canvasPoint(ev);
    if (testMode) {
      const cvp = canvasRef.current;
      if (!cvp) return;
      const rect = cvp.getBoundingClientRect();
      // обратная проекция камеры: зум сужает окно, наклон сжимает вертикаль земли
      const fxc = camFxRef.current;
      mx = (ev.clientX - rect.left - cvp.clientWidth / 2) / fxc.z + camRef.current.x;
      my = (ev.clientY - rect.top - cvp.clientHeight / 2) / (fxc.z * fxc.sq) + camRef.current.y;
      // Поправка на подъём земли: клик по видимой поверхности возвышенности
      // указывает в её клетку, а не в землю перед обрывом — с ближнего ракурса
      // на возвышенность теперь можно и кликнуть, и забраться.
      const ground = groundPointAtWorld(mx, my, s.field.cellW, s.field.cellH);
      mx = ground.x;
      my = ground.y;
      if (!s.arrow.battleMode) {
        // мирный «тест»: клик пускает свободную ходьбу до точки (по прямой,
        // стены обкатываются скольжением); клавиши перебивают цель.
        // Со строгими заходами клик в боевую зону цель не ставит: туда
        // всё равно не пустит ходьба — вход только через клетку захода.
        const wx = mx / s.field.cellW;
        const wy = my / s.field.cellH;
        if (!testPointInIsland(wx, wy)) return;
        if (testEntryStrict() && testPeaceBattleBlocked(wx, wy)) return;
        const hb = peaceHalfBox(s, spritesRef.current[s.character.sprite]);
        e.ptarget = { x: wx - hb.dx, y: wy - hb.dy, stuck: 0, lastD: 1e9 };
        return;
      }
      // боевой «тест»: клик по проходимой клетке или клетке захода строит маршрут
      // по клеткам; при открытой логике (без заходов) клик по траве вне зоны —
      // выход в мирный режим и ходьба к точке
      const wxB = mx / s.field.cellW;
      const wyB = my / s.field.cellH;
      const cB = Math.floor(wxB);
      const rB = Math.floor(wyB);
      const walkableClick =
        cB >= 0 && cB < s.field.cols && rB >= 0 && rB < s.field.rows && (testWalkableCell(cB, rB) || !!testEntryAt(cB, rB));
      if (
        !walkableClick &&
        !testEntryStrict() &&
        !testPointInCellsZone(wxB, wyB) &&
        testPointInIsland(wxB, wyB)
      ) {
        const hbB = peaceHalfBox(s, spritesRef.current[s.character.sprite]);
        e.ptarget = { x: wxB - hbB.dx, y: wyB - hbB.dy, stuck: 0, lastD: 1e9 };
        inZonePrevRef.current = true; // ещё внутри зоны — бой выключится по выходу центра
        setSettings((p) => ({ ...p, arrow: { ...p.arrow, battleMode: false } }));
        return;
      }
      if (!walkableClick) return;
      const c = cB;
      const r = rB;
      // клетки персонажей непроходимы — маршрут через/на них не строится;
      // в «тесте» непроходимы и клетки вне зон клеточной ходьбы
      const mp = s.controlled === 'main' ? null : mainSavedRef.current;
      e.path = bfsPath(
        e.col,
        e.row,
        c,
        r,
        s.field.cols,
        s.field.rows,
        [
          ...othersOf(s, s.controlled, mp, liveRemotesRef.current, objectExtras()).map((t) => ({ c: t.col, r: t.row })),
          ...(testMode ? testBattleRouteBlocked() : []),
        ],
      );
      return;
    }
    const c2 = Math.floor(mx / s.field.cellW);
    const r2 = Math.floor(my / s.field.cellH);
    if (c2 < 0 || c2 >= s.field.cols || r2 < 0 || r2 >= s.field.rows) return;
    // клетки персонажей непроходимы — маршрут через/на них не строится
    const mp2 = s.controlled === 'main' ? null : mainSavedRef.current;
    e.path = bfsPath(
      e.col,
      e.row,
      c2,
      r2,
      s.field.cols,
      s.field.rows,
      othersOf(s, s.controlled, mp2, liveRemotesRef.current, objectExtras()).map((t) => ({ c: t.col, r: t.row })),
    );
  };

  /* ---------- броня ---------- */

  /** Пресет брони уходит на сервер при смене кнопкой (и повторяется после
   *  переподключения — см. onYou). Сервер режет этой бронёй входящий урон;
   *  соседям значение не рассылается — они видят уже порезанный урон в fight.
   *  Пока сокета нет, emit просто молчит: onYou всё равно пришлёт запрос заново. */
  const armorLevel = settings.combat.armorLevel;
  useEffect(() => {
    netRef.current?.emit('armor', { armor: armorLevel / 10 });
  }, [armorLevel]);

  /* ---------- удар (клавиша I) ---------- */

  /** Отложенные удары «в полёте» (закрываются при размонтировании компонента). */
  const pendingStrikesRef = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const id of pendingStrikesRef.current) window.clearTimeout(id);
      pendingStrikesRef.current = [];
    },
    [],
  );

  /** Применение результата удара: расчёт и отправка на сервер — сразу при нажатии,
   *  локальные видимые эффекты — с откликом удара (visual=true). */
  const landStrike = useCallback((snap: { angle: number; col: number; row: number; flightMs?: number }, visual: boolean) => {
    const s = settingsRef.current;
    const e = engineRef.current;
    const now = performance.now();
    const cellCX = (cc: number) => cc * s.field.cellW + s.field.cellW / 2;
    const cellCY = (cr: number) => cr * s.field.cellH + s.field.cellH / 2;
    const selfId = s.controlled;
    const mp = selfId === 'main' ? null : mainSavedRef.current;

    /** Кого задел удар: единственный соседний персонаж, а если соседних несколько —
     *  тот, на который точнее наведена стрела. null — рядом никого. */
    const t = pickStrikeTarget(s, snap.col, snap.row, snap.angle, selfId, mp, liveRemotesRef.current, rabExtra());
    /** Лаповая зона пресета бьющего: урон, который уходит на сервер для удара по блоку. */
    const zPaws = s.combat.zones.find((zz) => zz.id === 'paws');
    /** Поражённый персонаж (для списания его энергии; null — попадания не было). */
    let struck: CharRef | null = null;
    /** Урон по цели этим ударом (null — попадания не было). */
    let hitDamage: number | null = null;
    let entry: CombatLogEntry;

    /** Всплывающая надпись «зона -урон%» над поражённым (вылетает вверх и тает). */
    const pushDamageLabel = (z: StrikeZone, tc: number, tr: number) => {
      e.labels.push({
        x: cellCX(tc),
        y: cellCY(tr) - s.field.cellH * 0.35,
        born: now,
        text: `${z.name} -${z.damage}%`,
        color: z.color,
      });
    };

    if (!t) {
      // рядом никого — удар в пустоту (без надписи и без строки в логе)
      entry = { target: '', zoneId: 'miss', zoneLabel: 'мимо', count: 1, actor: 'Я' };
    } else {
      const tCol = t.col;
      const tRow = t.row;
      const dx = tCol - snap.col;
      const dy = tRow - snap.row;
      const targetBlocking =
        t.id.startsWith('p') && remoteBlockRef.current.has(Number(t.id.slice(1)));
      // Прицельная зона считается ДО блока: хвост — исключение из блока, поэтому
      // важно знать, куда именно шла стрела, даже по блокирующему игроку.
      let aimed: StrikeZone | null | undefined;
      if (Math.abs(dx) === 1 && Math.abs(dy) === 1) {
        // Удар с диагонали: зона задаётся стойкой относительно цели, а стрела обязана
        // стоять в окне замедления направления на цель:
        //  слева-сверху (стрела вправо-вниз, окно 45°) и справа-сверху (влево-вниз, 135°) — Морда,
        //  слева-снизу (стрела вправо-вверх, 315°) — Лапы, справа-снизу (влево-вверх, 225°) — Хвост.
        // Вне окна направления — промах, из полос тела с диагонали ничего не берётся.
        const phi = wrap360((Math.atan2(dy, dx) * 180) / Math.PI);
        const forcedId = phi === 45 || phi === 135 ? 'muzzle' : phi === 225 ? 'tail' : 'paws';
        const win = s.slowdown.windows[String(phi) as WindowKey];
        aimed = win && inWindow(snap.angle, win) ? s.combat.zones.find((zz) => zz.id === forcedId) : undefined;
      } else {
        // Прямая стойка: зона — полоса тела, в которую входит луч стрелы.
        // Луч идёт из точки закрепления стрелы под её углом; промах — луч не задел тело.
        const sprT = spritesRef.current[t.sprite] ?? null;
        const sprSelf = spritesRef.current[selfId === 'main' ? s.character.sprite : (s.dummies.find((d) => d.id === selfId)?.sprite ?? s.character.sprite)] ?? null;
        const scaleSelf = selfId === 'main' ? s.character.spriteScale : (s.dummies.find((d) => d.id === selfId)?.scale ?? s.character.spriteScale);
        const a = anchorOf(s, sprSelf ? sprSelf.width / sprSelf.height : 2 / 3, snap.col, snap.row, scaleSelf);
        const box = spriteBoxOf(s, sprT ? sprT.width / sprT.height : 2 / 3, tCol, tRow, t.scale);
        const rad = (snap.angle * Math.PI) / 180;
        const hit = rayBox(a.ax, a.ay, Math.cos(rad), Math.sin(rad), box.x, box.y, box.w, box.h);
        aimed = hit.hit ? resolveZonePixel(hit.ny, entrySide(hit), s.combat.zones) : null;
      }
      // Блок цели: ЛЮБОЙ удар по блокирующему игроку — в «Лапы», куда бы стрела
      // ни шла и с какой стойки ни бьём (прямая/диагональ, любое окно).
      // Единственное исключение — хвост: удар в хвост блок не ловит и остаётся
      // хвостом (хвост — зона с самым маленьким получаемым уроном).
      const z = targetBlocking && zPaws ? (aimed && aimed.id === 'tail' ? aimed : zPaws) : aimed;
      if (z) {
        hitDamage = z.damage;
        struck = t;
        // Манекены и РАБ без брони: полученный урон = урон зоны. По живым игрокам
        // строку с реальным уроном (после брони) принесёт fight от сервера.
        entry = { target: t.name, zoneId: z.id, zoneLabel: z.name, count: 1, actor: 'Я', dmg: hitDamage };
      } else {
        // луч прошёл мимо тела — промах, без надписи и без строки в логе
        entry = { target: '', zoneId: 'miss', zoneLabel: 'мимо', count: 1, actor: 'Я' };
      }
    }

    // Локальные эффекты (манекен, промах, РАБ, оффлайн) проявляются с откликом удара:
    // сетевой удар уже улетел при нажатии — окно отклика бьющего на цель не тратим.
    if (!visual) {
      const id = window.setTimeout(() => landStrike(snap, true), strikeResponseMs(settingsRef.current));
      pendingStrikesRef.current.push(id);
      return;
    }

    // Попадание по живому соседу уходит на сервер. Строку лога и урон принесёт fight,
    // иначе удар останется только в состоянии бьющего.
    if (
      hitDamage !== null &&
      struck &&
      selfId === 'main' &&
      struck.id.startsWith('p') &&
      netRef.current?.ready
    ) {
      const target = Number(struck.id.slice(1));
      if (Number.isInteger(target)) {
        // Урон едет вместе с ударом: это пресет «Урон игрока» бьющего.
        // Сервер нормализует число и раздаёт fight с этим уроном всей комнате —
        // иначе у цели всегда будет серверная таблица, и пресет 0,0–0,9 не работает.
        // pawsDamage — лаповый урон пресета: если блок встанет за время полёта,
        // сервер переведёт удар в «Лапы» и спишет именно его. Исключение — хвост:
        // блок не переносит удар из хвоста в «Лапы». flightMs — окно отклика
        // бьющего: столько удар «летит» на сервере, и блок успевает его поймать.
        netRef.current.emit('strike', {
          target,
          zone: entry.zoneId,
          angle: snap.angle,
          damage: hitDamage,
          pawsDamage: zPaws ? zPaws.damage : undefined,
          flightMs: snap.flightMs,
        });
        return;
      }
    }

    if (hitDamage !== null && struck) {
      const z = s.combat.zones.find((zz) => zz.id === entry.zoneId);
      if (z) pushDamageLabel(z, struck.col, struck.row);
      // Попадание по мишени РАБ качает её «желе»; бьющий анимирует локально,
      // остальных догоняет rabHit от сервера — анимация видна всей комнате.
      if (struck.id === RAB_ID) {
        jellyRef.current[RAB_ID] = 1;
        if (netRef.current?.ready) {
          netRef.current.emit('rabHit', {
            zone: entry.zoneId,
            part: entry.zoneLabel,
            damage: hitDamage,
          });
        }
      }
    }

    // энергия и лог обновляются функционально от последнего состояния,
    // чтобы не затирать параллельные изменения (например, тик регенерации)
    setCombat((prev) => {
      const es = Math.max(1, s.combat.energyStart);
      let playerEnergy = prev.playerEnergy;
      const de = pruneRemoteEnergy(prev.dummyEnergy, s, liveRemotesRef.current, rabOnRef.current ? [RAB_ID] : []);
      // энергия тратится только при попадании в зону удара — промах бесплатен;
      // платит тот, кем управляем (свой кот — playerEnergy, манекен — своя энергия)
      if (hitDamage !== null) {
        if (selfId === 'main') playerEnergy = Math.max(0, playerEnergy - s.combat.strikeCost);
        else de[selfId] = Math.max(0, (de[selfId] ?? es) - s.combat.strikeCost);
      }
      // урон списывается с энергии того, в кого пришёлся удар
      if (hitDamage !== null && struck) {
        if (struck.id === 'main') playerEnergy = Math.max(0, playerEnergy - hitDamage);
        else de[struck.id] = Math.max(0, (de[struck.id] ?? es) - hitDamage);
      }
      // лог пишется последовательно: каждый удар — новая строка наверх; счётчик растёт
      // только когда удар совпал с самой верхней строкой (тот же бьющий, цель и зона)
      return { playerEnergy, dummyEnergy: de, log: mergeLog(prev.log, entry) };
    });
  }, []);

  const doStrike = useCallback(() => {
    const s = settingsRef.current;
    const e = engineRef.current;
    if (!s.arrow.battleMode) return;
    // В блоке бить нельзя.
    if (e.blocking) return;
    // удар не проходит, пока стрела вращается (J/L) — сначала нужно остановить стрелу
    if (e.rot !== 0 || e.rotActive !== 0) return;
    // В комнате без связи удар по чужим котам локально не моделируется:
    // иначе получился бы «зомби»-урон, которого нет у остальных.
    if (s.controlled === 'main' && liveRemotesRef.current.length > 0 && !netRef.current?.ready) return;
    const now = performance.now();
    const resp = strikeResponseMs(s);
    // удары не чаще, чем раз в отклик (170 мс по умолчанию): ни спам, ни удержание
    // клавиши удара не дают больше одного удара в этот интервал
    if (now - e.lastStrike < resp) return;
    // энергии не хватает — удар просто не начинается (без всплывающих подсказок);
    // платит тот, кем управляем
    const esNow = Math.max(1, s.combat.energyStart);
    const myEnergy =
      s.controlled === 'main'
        ? combatRef.current.playerEnergy
        : (combatRef.current.dummyEnergy[s.controlled] ?? esNow);
    if (myEnergy < s.combat.strikeCost) return;
    e.lastStrike = now;
    // Стойка, угол, расчёт и отправка удара — в момент нажатия. Раньше удар ещё
    // resp ждал на клиенте, а сервер потом то же окно полёта: до касания шло
    // ~два отклика. Теперь окно одно, серверное (flightMs) — блок цели успевает.
    const snap = { angle: e.angle, col: e.col, row: e.row, flightMs: resp };
    landStrike(snap, false);
  }, [landStrike]);

  useEffect(() => {
    doStrikeRef.current = doStrike;
  }, [doStrike]);

  /* ---------- патчи настроек ---------- */

  const patchField = useCallback(
    (p: Partial<SimSettings['field']>) => setSettings((s) => ({ ...s, field: { ...s.field, ...p } })),
    [],
  );
  const patchCharacter = useCallback(
    (p: Partial<SimSettings['character']>) => setSettings((s) => ({ ...s, character: { ...s.character, ...p } })),
    [],
  );
  const patchArrow = useCallback(
    (p: Partial<SimSettings['arrow']>) => setSettings((s) => ({ ...s, arrow: { ...s.arrow, ...p } })),
    [],
  );
  const patchSlowdown = useCallback(
    (p: Partial<SimSettings['slowdown']>) => setSettings((s) => ({ ...s, slowdown: { ...s.slowdown, ...p } })),
    [],
  );
  const patchWindow = useCallback(
    (key: WindowKey, p: Partial<DirectionWindow>) =>
      setSettings((s) => ({
        ...s,
        slowdown: { ...s.slowdown, windows: { ...s.slowdown.windows, [key]: { ...s.slowdown.windows[key], ...p } } },
      })),
    [],
  );
  const patchTier = useCallback(
    (i: number, p: Partial<SlowdownTier>) =>
      setSettings((s) => {
        const tiers = s.slowdown.tiers.map((t, idx) => (idx === i ? { ...t, ...p } : { ...t }));
        return { ...s, slowdown: { ...s.slowdown, tiers } };
      }),
    [],
  );
  const patchHud = useCallback(
    (p: Partial<SimSettings['hud']>) => setSettings((s) => ({ ...s, hud: { ...s.hud, ...p } })),
    [],
  );
  const patchCombat = useCallback(
    (p: Partial<SimSettings['combat']>) => setSettings((s) => ({ ...s, combat: { ...s.combat, ...p } })),
    [],
  );
  const patchZone = useCallback(
    (i: number, p: Partial<StrikeZone>) =>
      setSettings((s) => {
        const zones = s.combat.zones.map((z, idx) => (idx === i ? { ...z, ...p } : { ...z }));
        return { ...s, combat: { ...s.combat, zones } };
      }),
    [],
  );
  /** Правка одного манекена; если им сейчас управляем — клетка/угол применяются и к движку. */
  const patchDummy = useCallback((id: string, p: Partial<DummyConfig>) => {
    const cur = settingsRef.current.controlled;
    if (cur === id) {
      if (p.angle !== undefined) engineRef.current.angle = wrap360(p.angle);
      if (p.col !== undefined) engineRef.current.col = p.col;
      if (p.row !== undefined) engineRef.current.row = p.row;
    }
    setSettings((s) => ({ ...s, dummies: s.dummies.map((d) => (d.id === id ? { ...d, ...p } : d)) }));
  }, []);

  const onResetAll = useCallback(() => {
    setSettings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    setCombat(defaultCombat(DEFAULT_SETTINGS.combat.energyStart));
    mainSavedRef.current = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(COMBAT_KEY);
    } catch {
      /* ничего */
    }
  }, []);

  /** Сброс боевого состояния: энергии на старт, лог очищен (настройки не трогаем). */
  const onResetCombat = useCallback(() => {
    const es = settingsRef.current.combat.energyStart;
    const fresh = defaultCombat(es);
    setCombat(fresh);
    try {
      localStorage.setItem(COMBAT_KEY, JSON.stringify(fresh));
    } catch {
      /* ничего */
    }
  }, []);

  const onExport = useCallback(() => JSON.stringify(settingsRef.current, null, 2), []);

  const onImport = useCallback((json: string): string | null => {
    try {
      const parsed = mergeSettings(JSON.parse(json));
      setSettings(parsed);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : 'не удалось разобрать JSON';
    }
  }, []);

  const sendChat = useCallback((text: string) => {
    const net = netRef.current;
    if (!net?.ready) return false;
    net.emit('chat', { text });
    return true;
  }, []);

  /** Вход с экрана entry: подтверждённые кот/имя/размер + комната. Сокет уже
   *  слушает комнаты — join уходит в ту же связь. Настройки персонажа применяем
   *  здесь же: дальше экран входа размонтируется. */
  const joinFromEntry = useCallback(
    (roomId: string, who: { name: string; sprite: SpriteId; scale: number }) => {
      const login = who.name.trim().slice(0, 24);
      if (!login) return;
      const sprite = SPRITES.some((sp) => sp.id === who.sprite) ? who.sprite : settingsRef.current.character.sprite;
      const scale = Math.min(100, Math.max(60, Math.round(who.scale)));
      setSettings((s) => ({
        ...s,
        controlled: 'main',
        character: { ...s.character, sprite, spriteScale: scale },
      }));
      pendingJoinRef.current = { room: roomId, login, sprite, scale };
      setNetStarted(true);
      pickRoom(roomId);
    },
    [pickRoom],
  );

  const fieldW = settings.field.cols * settings.field.cellW;
  const fieldH = settings.field.rows * settings.field.cellH;
  /** Комната «тест»: канвас — вьюпорт с камерой, поле не вписывается в кадр. */
  const testField = fieldFormat === 'test';

  // Канвас рисуется в пикселях клеток (10×100 на 6×150). Боковые колонки (чат и лог)
  // живут рядом с полем, поэтому кадр отдаётся полю целиком: размер вписывается и по
  // ширине, и по высоте, а сверх клеточного размера допускается растяжение до 2× —
  // рендер учитывает devicePixelRatio, так что картинка остаётся чёткой.
  // На узком экране высота следует за шириной, а страница прокручивается вместе с полем.
  useLayoutEffect(() => {
    const frame = fieldFrameRef.current;
    if (!frame) return;
    if (fieldFormatRef.current === 'test') return; // вьюпорт «теста» не вписывается — он и так весь кадр
    const mq = window.matchMedia('(min-width: 64rem)');
    const fit = () => {
      const cs = getComputedStyle(frame);
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const availW = Math.max(0, frame.clientWidth - padX);
      const availH = Math.max(0, frame.clientHeight - padY);
      let w = Math.min(availW, fieldW * FIELD_MAX_UPSCALE);
      let h = fieldH * (w / Math.max(1, fieldW));
      if (mq.matches && availH > 0 && h > availH) {
        h = Math.min(availH, fieldH * FIELD_MAX_UPSCALE);
        w = fieldW * (h / Math.max(1, fieldH));
      }
      const nextW = Math.max(1, Math.floor(w));
      const nextH = Math.max(1, Math.floor(h));
      setFieldFit((prev) =>
        prev && Math.abs(prev.w - nextW) <= 1 && Math.abs(prev.h - nextH) <= 1 ? prev : { w: nextW, h: nextH },
      );
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(frame);
    mq.addEventListener('change', fit);
    return () => {
      ro.disconnect();
      mq.removeEventListener('change', fit);
    };
  }, [fieldW, fieldH, stage]);

  /** Смена темы: перекрашивает интерфейс и, если цвета поля не настроены вручную,
   *  подгоняет палитру поля под тему (иначе доска остаётся тёмной на светлой теме). */
  const changeTheme = useCallback(
    (t: ThemeId) => {
      setTheme(t);
      applyTheme(t);
      const cur = {
        bgColor: settingsRef.current.field.bgColor,
        bgColorAlt: settingsRef.current.field.bgColorAlt,
        gridColor: settingsRef.current.field.gridColor,
      };
      if (fieldPaletteOf(cur) !== null) patchField(FIELD_PRESETS[t]);
    },
    [patchField],
  );

  /** Карточки для выбора: три грота (состав из roomsinfo) + комната из ссылки,
   *  если в URL стоит чужой код (?room=...) — старые ссылки продолжают работать. */
  const roomRows: RoomRow[] = (() => {
    const info = new Map((roomsRows ?? []).map((r) => [r.id, r]));
    const rows: RoomRow[] = ROOMS.map((r) => ({
      id: r.id,
      title: r.title,
      count: info.get(r.id)?.count ?? 0,
      logins: info.get(r.id)?.logins ?? [],
      here: r.id === roomCode,
    }));
    const urlRoom = roomFromUrl();
    if (urlRoom && urlRoom !== 'demo' && !ROOMS.some((r) => r.id === urlRoom)) {
      rows.push({
        id: urlRoom,
        title: `Комната из ссылки: ${urlRoom}`,
        count: info.get(urlRoom)?.count ?? 0,
        logins: info.get(urlRoom)?.logins ?? [],
        here: urlRoom === roomCode,
      });
    }
    return rows;
  })();

  if (stage === 'entry') {
    return (
      <div className="app-bg relative h-dvh text-[var(--sim-text)]">
        <ThemeBackdrop theme={theme} />
        <div className="relative z-10 h-dvh overflow-y-auto">
          {loaded ? (
            <EntryScreen
              initialSprite={settings.character.sprite}
              initialName={nameFromUrl().slice(0, 24)}
              initialScale={settings.character.spriteScale}
              periodSec={settings.arrow.periodSec}
              damageLevel={settings.combat.damageLevel}
              armorLevel={settings.combat.armorLevel}
              roomRows={roomRows}
              roomsReady={roomsRows !== null}
              roomsStale={roomsStale}
              onPickRoom={joinFromEntry}
              onApplySpeed={(v) => patchArrow({ periodSec: v })}
              onApplyDamage={(k) => {
                const prev = settingsRef.current.combat;
                const prevThroat = Math.max(1, throatDamageFor(prev.damageLevel));
                const nextThroat = Math.max(1, throatDamageFor(k));
                patchCombat({
                  damageLevel: k,
                  // геометрия зон (px, сторона, цвет) сохраняется — меняется только урон;
                  // масштабируем ТЕКУЩИЙ урон зон: ручные правки зон (админка) не стираются.
                  // Раньше пересчёт шёл от базовых значений, и правленые Лапы 2% при смене
                  // пресета превращались в базовые × множитель (до 10% и выше).
                  zones: prev.zones.map((z) => ({
                    ...z,
                    damage: Math.max(0, Math.round((z.damage * nextThroat) / prevThroat)),
                  })),
                });
              }}
              onApplyArmor={(k) => patchCombat({ armorLevel: k })}
            />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="app-bg relative flex h-dvh min-h-0 flex-col overflow-hidden text-[var(--sim-text)]">
      <ThemeBackdrop theme={theme} />
      <header className="relative z-10 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--sim-line)] bg-[var(--sim-panel)] px-4 py-2.5">
        <div>
          <h1 className="text-base font-bold leading-tight">abnocw</h1>
          <p className="text-[11px] text-[var(--sim-text-faint)]">
            {settings.field.cols}×{settings.field.rows} · {roomCode ? roomTitle(roomCode) : 'комната не выбрана'} · {peerCount} на поле
          </p>
        </div>
        {/* Панелька выбранных скрытых параметров (СП): живая, повторяет блок «Выбор СП» с экрана входа */}
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-[var(--sim-line-strong)] bg-[var(--sim-inset-soft)] px-2.5 py-1 text-[11px]"
          aria-label="Выбранные скрытые параметры"
        >
          <span className="font-bold text-[var(--sim-text)]">СП:</span>
          <span className="text-[var(--sim-text-muted)]">
            стрела <b className="font-semibold text-[var(--sim-text)]">{fmtSec(settings.arrow.periodSec)}</b>
          </span>
          <span className="text-[var(--sim-text-faint)]">·</span>
          <span className="text-[var(--sim-text-muted)]">
            дамаг <b className="font-semibold text-[var(--sim-text)]">{damageLevelLabel(settings.combat.damageLevel)}</b>
          </span>
          <span className="text-[var(--sim-text-faint)]">·</span>
          <span className="text-[var(--sim-text-muted)]">
            броня <b className="font-semibold text-[var(--sim-text)]">{damageLevelLabel(settings.combat.armorLevel)}</b>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <Button
            size="sm"
            variant="outline"
            className="btn-neutral h-8 text-xs"
            onClick={() => {
              setRoomsStale(false);
              setSwitchOpen(true);
            }}
          >
            Перейти в другую комнату
          </Button>
          <span className="max-w-[280px] truncate text-[var(--sim-text-muted)]">{netStatus}</span>
        </div>
        <div className="relative z-10 ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-[var(--sim-text-muted)]">
            тема
            <select
              value={theme}
              onChange={(ev) => changeTheme(ev.target.value as ThemeId)}
              className="h-8 rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-input-bg)] px-1.5 text-xs text-[var(--sim-text)] outline-none"
            >
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          {fieldFormat === 'test' ? (
            <Button
              size="sm"
              variant={editorOpen ? 'default' : 'outline'}
              className={
                editorOpen
                  ? 'h-8 bg-[var(--sim-accent)] text-xs text-white hover:bg-[var(--sim-accent-hover)]'
                  : 'btn-neutral h-8 text-xs'
              }
              onClick={() => (editorOpen ? closeEditor() : openEditor())}
            >
              Редактор локации
            </Button>
          ) : null}
          {testField ? (
            <>
              <Button
                size="sm"
                variant={settings.character.peaceView ? 'default' : 'outline'}
                className={
                  settings.character.peaceView
                    ? 'h-8 bg-[var(--sim-accent)] text-xs text-white hover:bg-[var(--sim-accent-hover)]'
                    : 'btn-neutral h-8 text-xs'
                }
                title="Масштаб камеры, наклон земли и глубина в мирном режиме. Выключите — вид сверху, без перспективы; колесо мыши продолжает работать в любом случае."
                onClick={() => patchCharacter({ peaceView: !settings.character.peaceView })}
              >
                Перспектива: {settings.character.peaceView ? 'ВКЛ' : 'ВЫКЛ'}
              </Button>
              <Button
                size="sm"
                variant={settings.arrow.battleMode ? 'default' : 'outline'}
                className={
                  settings.arrow.battleMode
                    ? 'h-8 bg-[var(--sim-accent)] text-xs text-white hover:bg-[var(--sim-accent-hover)]'
                    : 'btn-neutral h-8 text-xs'
                }
                title="Вход в бой — с клетки захода (две галочки у боевой зоны): встаньте на неё и нажмите. Выключение на боевой клетке возвращает на заход. Клавиша B."
                onClick={toggleBattleMode}
              >
                Боевой режим: {settings.arrow.battleMode ? 'ВКЛ' : 'ВЫКЛ'} (B)
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant={settings.arrow.battleMode ? 'default' : 'outline'}
              className={
                settings.arrow.battleMode
                  ? 'h-8 bg-[var(--sim-accent)] text-xs text-white hover:bg-[var(--sim-accent-hover)]'
                  : 'btn-neutral h-8 text-xs'
              }
              onClick={() => patchArrow({ battleMode: !settings.arrow.battleMode })}
            >
              Боевой режим: {settings.arrow.battleMode ? 'ВКЛ' : 'ВЫКЛ'} (B)
            </Button>
          )}
          <Button
            size="sm"
            variant={settingsOpen ? 'default' : 'outline'}
            className={settingsOpen ? 'h-8 bg-[var(--sim-accent)] text-xs text-white hover:bg-[var(--sim-accent-hover)]' : 'btn-neutral h-8 text-xs'}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            Настройки
          </Button>
        </div>
      </header>

      {/* Один ряд: чат слева · поле в центре · лог ударов справа.
          Ширины колонок тянутся разделителями и запоминаются. */}
      <main
        className="relative z-10 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 lg:flex-row lg:gap-0 lg:overflow-hidden lg:p-3"
        style={{ '--chat-w': `${layout.chatW}px`, '--log-w': `${layout.logW}px` } as CSSProperties}
      >
        <div className="flex h-56 w-full shrink-0 flex-col lg:h-auto lg:min-h-0 lg:w-[var(--chat-w)]">
          <RoomChat lines={chatLines} meId={meId} canSend={netReady} onSend={sendChat} />
        </div>
        <ColResize
          onDrag={(dx) => setLayout((p) => ({ ...p, chatW: clampLayout({ ...p, chatW: p.chatW + dx }).chatW }))}
          onEnd={() => saveLayout(layoutRef.current)}
        />

        <section className="flex w-full min-w-0 flex-col gap-2 lg:h-full lg:min-h-0 lg:flex-1">
          <div className="relative w-full min-w-0 flex-1 lg:min-h-0">
            <div
              ref={fieldFrameRef}
              role="region"
              aria-label="Игровое поле"
              className="relative overflow-hidden rounded-xl border border-[var(--sim-line)] bg-[var(--sim-frame)] p-2 lg:absolute lg:inset-0"
            >
              <div
                className={
                  testField
                    ? 'relative h-full w-full'
                    : fieldFit
                      ? 'relative mx-auto'
                      : 'relative mx-auto w-full max-w-full'
                }
                style={
                  testField
                    ? undefined
                    : fieldFit
                      ? { width: fieldFit.w, height: fieldFit.h }
                      : { maxWidth: fieldW, aspectRatio: `${fieldW} / ${fieldH}` }
                }
              >
                <canvas
                  ref={canvasRef}
                  className="block h-full w-full cursor-crosshair rounded-lg"
                  onPointerMove={onMove}
                  onPointerDown={onPointerDown}
                  onPointerUp={onUp}
                  onPointerCancel={onUp}
                  onPointerLeave={onLeave}
                  onContextMenu={onContextMenu}
                  onClick={onClick}
                />
                {/* Слой атмосферы: PixiJS выводит мир (как текстуру 2D-холста) вместе
                    с цветокоррекцией, тенями облаков и дождём. События мыши проходят
                    сквозь него на игровой холст. Без WebGL слой прозрачен. */}
                <canvas
                  ref={pixiRef}
                  aria-hidden
                  className="pointer-events-none absolute inset-0 z-10 block h-full w-full rounded-lg"
                />
                {/* HUD поля поверх атмосферы: циферблат день/ночь с движущимся
                    солнцем/луной и значок текущей погоды. Не темнеет ночью и
                    не прячется под дождём. */}
                <canvas
                  ref={hudRef}
                  aria-hidden
                  className="pointer-events-none absolute inset-0 z-20 block h-full w-full rounded-lg"
                />
              </div>
              {battleHint ? (
                <div className="pointer-events-none absolute left-1/2 top-4 z-30 -translate-x-1/2 rounded-lg border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] px-3 py-1.5 text-xs text-[var(--sim-text)] shadow-lg">
                  {battleHint}
                </div>
              ) : null}
              {mapLoading ? (
                <div className="pointer-events-none absolute left-1/2 top-4 z-40 -translate-x-1/2 animate-pulse rounded-lg border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] px-4 py-2 text-sm font-semibold text-[var(--sim-text)] shadow-lg">
                  Загрузка локации…
                </div>
              ) : null}
              {editorOpen && editorView ? (
                <div className="absolute left-3 top-3 z-20 flex max-h-[calc(100%-24px)] w-[272px] flex-col overflow-hidden rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] shadow-xl">
                  <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--sim-line)] px-3 py-2">
                    <div className="text-xs font-bold">Редактор локации</div>
                    <button
                      type="button"
                      aria-label="Закрыть редактор"
                      className="btn-neutral flex h-6 w-6 items-center justify-center rounded-md text-xs"
                      onClick={closeEditor}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3 text-[11px]">
                    <div>
                      <div className="mb-1 font-semibold text-[var(--sim-text-muted)]">Инструмент</div>
                      <div className="flex gap-1.5">
                        {(
                          [
                            { id: 'cells', label: 'Клетки' },
                            { id: 'green', label: 'Зелёная' },
                            { id: 'erase', label: 'Ластик' },
                          ] as { id: EditorTool; label: string }[]
                        ).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className={
                              editorView.tool === t.id
                                ? 'flex-1 rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1.5 py-1 font-semibold text-white'
                                : 'btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1.5 py-1'
                            }
                            onClick={() => setEditorTool(t.id)}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                      <div className="mt-1.5 flex gap-1.5">
                        {(
                          [
                            { id: 'stone', label: '⛰ Камень' },
                            { id: 'tree', label: '🌲 Дерево' },
                            { id: 'dirt', label: '🟫 Земля' },
                          ] as { id: EditorTool; label: string }[]
                        ).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className={
                              editorView.tool === t.id
                                ? 'flex-1 rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1.5 py-1 font-semibold text-white'
                                : 'btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1.5 py-1'
                            }
                            onClick={() => setEditorTool(t.id)}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                      <div className="mt-1.5 flex gap-1.5">
                        {(
                          [
                            { id: 'ground', label: '🌸 Покрытие' },
                            { id: 'entry', label: '🚪 Заход' },
                            { id: 'spawn', label: '🛏 Спавн' },
                            { id: 'battle', label: '⚔ Клетка' },
                            { id: 'paint', label: '🖌 Кисть' },
                          ] as { id: EditorTool; label: string }[]
                        ).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className={
                              editorView.tool === t.id
                                ? 'flex-1 rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1.5 py-1 font-semibold text-white'
                                : 'btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1.5 py-1'
                            }
                            onClick={() => setEditorTool(t.id)}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                      <div className="mt-1.5 flex gap-1.5">
                        {(
                          [
                            { id: 'raise', label: '⬆ Насыпать' },
                            { id: 'lower', label: '⬇ Срыть' },
                            { id: 'flat', label: '▬ Ровно' },
                          ] as { id: EditorTool; label: string }[]
                        ).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className={
                              editorView.tool === t.id
                                ? 'flex-1 rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1 py-1 font-semibold text-white'
                                : 'btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1 py-1'
                            }
                            onClick={() => setEditorTool(t.id)}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                      {editorView.tool === 'raise' || editorView.tool === 'lower' || editorView.tool === 'flat' ? (
                        <p className="mt-1 leading-snug text-[10px] text-[var(--sim-text-faint)]">
                          Клик или протяжка по клеткам: «Насыпать» поднимает землю на уровень (до трёх),
                          «Срыть» опускает, «Ровно» срезает весь росчерк в уровень первой клетки. Перепад
                          в один уровень проходится шагом, в два и больше — только прыжком с зарядом
                          (удержать Пробел и отпустить). Ластик и «Срыть» до нуля убирают насыпь совсем.
                        </p>
                      ) : null}
                      {editorView.tool === 'paint' ? (
                        <>
                          <div className="mt-2 mb-1 font-semibold text-[var(--sim-text-muted)]">Материал кисти</div>
                          <div className="grid grid-cols-3 gap-1">
                            {PAINT_MATS.map((mt) => (
                              <button
                                key={mt.id}
                                type="button"
                                className={
                                  editorView.pmat === mt.id
                                    ? 'rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1 py-1 font-semibold text-white'
                                    : 'btn-neutral rounded-md border border-[var(--sim-line-strong)] px-1 py-1'
                                }
                                onClick={() => {
                                  const d = editorRef.current;
                                  if (d) {
                                    d.pmat = mt.id;
                                    syncEditorView();
                                  }
                                }}
                              >
                                {mt.label}
                              </button>
                            ))}
                          </div>
                          <div className="mt-2 mb-1 font-semibold text-[var(--sim-text-muted)]">Размер круглой кисти</div>
                          <div className="flex items-center gap-1.5">
                            <input
                              type="range"
                              min={1}
                              max={200}
                              value={editorView.psize}
                              className="min-w-0 flex-1"
                              onChange={(ev) => {
                                const d = editorRef.current;
                                if (d) {
                                  d.psize = Math.min(200, Math.max(1, Math.round(Number(ev.target.value) || 1)));
                                  syncEditorView();
                                }
                              }}
                            />
                            <span className="w-12 text-center font-semibold">{editorView.psize} px</span>
                          </div>
                          <div className="mt-2 mb-1 font-semibold text-[var(--sim-text-muted)]">Готовые области</div>
                          <div className="flex gap-1.5">
                            {(
                              [
                                { id: 'round', label: '⚪ Круг' },
                                { id: 'cell', label: '▭ 150×100' },
                                { id: 'half', label: '▫ 75×50' },
                              ] as { id: PaintBrushShape; label: string }[]
                            ).map((sh) => (
                              <button
                                key={sh.id}
                                type="button"
                                className={
                                  editorView.pshape === sh.id
                                    ? 'flex-1 rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1 py-1 font-semibold text-white'
                                    : 'btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1 py-1'
                                }
                                onClick={() => {
                                  const d = editorRef.current;
                                  if (d) {
                                    d.pshape = sh.id;
                                    syncEditorView();
                                  }
                                }}
                              >
                                {sh.label}
                              </button>
                            ))}
                          </div>
                          <button
                            type="button"
                            className="btn-neutral mt-2 w-full rounded-md border border-[var(--sim-line-strong)] px-1.5 py-1"
                            onClick={() => {
                              const d = editorRef.current;
                              if (!d) return;
                              if (undoPaintStroke(d)) {
                                d.dirty = true;
                                syncEditorView();
                              }
                            }}
                          >
                            ↩ Отменить мазок
                          </button>
                          <p className="mt-1 leading-snug text-[10px] text-[var(--sim-text-faint)]">
                            Кисть рисует саму локацию в пикселях: закрашенное — земля, по ней ходят в мирном режиме;
                            стёртое — пустота за кромкой. ЛКМ — материал, ПКМ — ластик, колесо — размер круглой кисти.
                            Пресеты «150×100» и «75×50» — готовые области с привязкой к сетке: боевая клетка ставится
                            только на место, закрашенное областью «150×100» целиком. Росчерк можно отменить.
                          </p>
                        </>
                      ) : null}
                      {editorView.tool === 'battle' ? (
                        <p className="mt-1 leading-snug text-[10px] text-[var(--sim-text-faint)]">
                          Боевая клетка — область 150×100 (одна клетка боевого поля). Клик ставит её на закрашенное
                          кистью место: область клетки обязана быть покрашена целиком, иначе клетка не ставится
                          (место подсвечивается красным). Повторный клик по стоящей клетке снимает её.
                        </p>
                      ) : null}
                      {editorView.tool === 'entry' ? (
                        <>
                          <div className="mt-2 mb-1 font-semibold text-[var(--sim-text-muted)]">Направление шага</div>
                          <div className="flex gap-1.5">
                            {(
                              [
                                { id: 'left', label: '←' },
                                { id: 'up', label: '↑' },
                                { id: 'down', label: '↓' },
                                { id: 'right', label: '→' },
                              ] as { id: TestMapEntryDir; label: string }[]
                            ).map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                className={
                                  editorEntryDir === p.id
                                    ? 'flex-1 rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1 py-1 font-semibold text-white'
                                    : 'btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1 py-1'
                                }
                                onClick={() => setEditorEntryDir(p.id)}
                              >
                                {p.label}
                              </button>
                            ))}
                          </div>
                          <p className="mt-1 leading-snug text-[10px] text-[var(--sim-text-faint)]">
                            Куда игрока перенесёт шаг с захода в боевом режиме: выберите направление в сторону
                            боевой зоны, затем кликните по травяной клетке рядом с ней. Повторный клик с тем же
                            направлением — убрать, с другим — сменить направление.
                          </p>
                        </>
                      ) : null}
                      {editorView.tool === 'stone' || editorView.tool === 'tree' ? (
                        <>
                          <div className="mt-2 mb-1 font-semibold text-[var(--sim-text-muted)]">
                            {editorView.tool === 'tree' ? 'Вид дерева' : 'Вид камня'}
                          </div>
                          <div className="grid grid-cols-3 gap-1">
                            {(editorView.tool === 'tree'
                              ? TREE_SPRITE_OPTS
                              : ROCK_SPRITE_OPTS
                            ).map((v) => (
                              <button
                                key={v.id}
                                type="button"
                                className={
                                  editorPlace?.kind === editorView.tool && editorPlace?.spr === v.id
                                    ? 'rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1 py-1 font-semibold text-white'
                                    : 'btn-neutral rounded-md border border-[var(--sim-line-strong)] px-1 py-1'
                                }
                                onClick={() =>
                                  patchEditorPlace({ kind: editorView.tool === 'tree' ? 'tree' : 'stone', spr: v.id, pickId: null, anchored: false })
                                }
                              >
                                {v.label}
                              </button>
                            ))}
                          </div>
                          <div className="mt-2 mb-1 font-semibold text-[var(--sim-text-muted)]">Размер и поворот</div>
                          <div className="flex items-center gap-1.5">
                            <span className="w-10 text-[var(--sim-text-faint)]">Разм.</span>
                            <button
                              type="button"
                              className="btn-neutral h-6 w-6 rounded-md"
                              onClick={() =>
                                patchEditorPlace({
                                  s: Math.max(OBJECT_SCALE_MIN, Math.round(((editorPlace?.s ?? 1) - 0.1) * 100) / 100),
                                })
                              }
                            >
                              −
                            </button>
                            <span className="w-10 text-center font-semibold">×{(editorPlace?.s ?? 1).toFixed(1)}</span>
                            <button
                              type="button"
                              className="btn-neutral h-6 w-6 rounded-md"
                              onClick={() =>
                                patchEditorPlace({
                                  s: Math.min(OBJECT_SCALE_MAX, Math.round(((editorPlace?.s ?? 1) + 0.1) * 100) / 100),
                                })
                              }
                            >
                              +
                            </button>
                          </div>
                          <div className="mt-1 flex items-center gap-1">
                            <span className="w-10 text-[var(--sim-text-faint)]">Поворот</span>
                            <button
                              type="button"
                              className="btn-neutral h-6 w-6 rounded-md"
                              title="На шаг против часовой (15°)"
                              onClick={() =>
                                patchEditorPlace({ rot: (((editorPlace?.rot ?? 0) - OBJECT_ROT_STEP) % 360 + 360) % 360 })
                              }
                            >
                              ↺
                            </button>
                            <button
                              type="button"
                              className="btn-neutral h-6 w-8 rounded-md text-[11px] font-semibold"
                              title="Поворот на 90° против часовой"
                              onClick={() =>
                                patchEditorPlace({ rot: (((editorPlace?.rot ?? 0) - 90) % 360 + 360) % 360 })
                              }
                            >
                              ⟲90°
                            </button>
                            <span className="w-9 text-center font-semibold">{editorPlace?.rot ?? 0}°</span>
                            <button
                              type="button"
                              className="btn-neutral h-6 w-8 rounded-md text-[11px] font-semibold"
                              title="Поворот на 90° по часовой"
                              onClick={() =>
                                patchEditorPlace({ rot: (((editorPlace?.rot ?? 0) + 90) % 360 + 360) % 360 })
                              }
                            >
                              ⟳90°
                            </button>
                            <button
                              type="button"
                              className="btn-neutral h-6 w-6 rounded-md"
                              title="На шаг по часовой (15°)"
                              onClick={() =>
                                patchEditorPlace({ rot: (((editorPlace?.rot ?? 0) + OBJECT_ROT_STEP) % 360 + 360) % 360 })
                              }
                            >
                              ↻
                            </button>
                          </div>
                          <div className="mt-1 flex items-center gap-1.5">
                            <span className="w-10 text-[var(--sim-text-faint)]">Зеркало</span>
                            <button
                              type="button"
                              className={
                                (editorPlace?.mir ?? 0) === 1
                                  ? 'flex-1 rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1 py-1 font-semibold text-white'
                                  : 'btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1 py-1'
                              }
                              title="Отзеркалить спрайт по горизонтали"
                              onClick={() => patchEditorPlace({ mir: (editorPlace?.mir ?? 0) === 1 ? 0 : 1 })}
                            >
                              ⇋ {(editorPlace?.mir ?? 0) === 1 ? 'отзеркален' : 'как есть'}
                            </button>
                          </div>
                          <div className="mt-2 flex gap-1.5">
                            <button
                              type="button"
                              className="flex-1 rounded-md bg-[var(--sim-accent)] px-1.5 py-1.5 font-semibold text-white hover:bg-[var(--sim-accent-hover)]"
                              onClick={confirmEditorPlace}
                            >
                              ✓ Поставить
                            </button>
                            <button
                              type="button"
                              className="btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1.5 py-1.5"
                              onClick={cancelEditorPlace}
                            >
                              ✕ Отмена
                            </button>
                          </div>
                          <p className="mt-1 leading-snug text-[10px] text-[var(--sim-text-faint)]">
                            Призрак следует за курсором — клик фиксирует точку (потом можно перетащить).
                            Колесо мыши над полем — размер, кнопки — размер и поворот. Клик по уже
                            стоящему объекту поднимает его для правки. ✓ ставит, ✕ отменяет.
                          </p>
                        </>
                      ) : null}
                      {editorView.tool === 'ground' ? (
                        <>
                          <div className="mt-2 mb-1 font-semibold text-[var(--sim-text-muted)]">Вид покрытия</div>
                          <div className="grid grid-cols-3 gap-1">
                            {GROUND_COVER_OPTS.map((v) => (
                              <button
                                key={v.id}
                                type="button"
                                className={
                                  editorCover === v.id
                                    ? 'rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1 py-1 font-semibold text-white'
                                    : 'btn-neutral rounded-md border border-[var(--sim-line-strong)] px-1 py-1'
                                }
                                onClick={() => setEditorCover(v.id)}
                              >
                                {v.label}
                              </button>
                            ))}
                          </div>
                          <p className="mt-1 leading-snug text-[10px] text-[var(--sim-text-faint)]">
                            Клик или протяжка красит клетки: цветы, каменная плитка разной густоты,
                            сплошной пол, просто трава. Соседние клетки сходятся швами в сплошной настил.
                          </p>
                        </>
                      ) : null}
                      {editorView.tool === 'spawn' ? (
                        <p className="mt-1 leading-snug text-[10px] text-[var(--sim-text-faint)]">
                          Точки появления игроков: клик по траве ставит клетку спавна, повторный клик
                          по той же клетке — снимает, протяжка красит несколько. Игроки появляются на
                          случайной свободной из них. На поле клетка ничем не отличается от соседних —
                          флажки видны только здесь, в редакторе.
                        </p>
                      ) : null}
                      <p className="mt-1 leading-snug text-[var(--sim-text-faint)]">
                        Тяните по полю — зона. Камень и дерево ставятся свободно: призрак едет за
                        курсором, размер и поворот подгоняются до ✓ «Поставить» (через них нельзя пройти).
                        Земля и покрытие — клик или протяжка, ходьбе не мешают. Кисти рельефа насыпают
                        и срывают уступы: перепад в уровень проходится шагом, выше — прыжком.
                        Заход — вход в боевую зону: травяная клетка с галочками,
                        в бою шаг с неё переносит по направлению захода.
                      </p>
                    </div>
                    <div>
                      <div className="mb-1 font-semibold text-[var(--sim-text-muted)]">Размер мира</div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-4 text-[var(--sim-text-faint)]">Ш</span>
                        <button type="button" className="btn-neutral h-6 w-6 rounded-md" onClick={() => resizeEditorWorld(editorView.cols - 1, editorView.rows)}>
                          −
                        </button>
                        <span className="w-7 text-center font-semibold">{editorView.cols}</span>
                        <button type="button" className="btn-neutral h-6 w-6 rounded-md" onClick={() => resizeEditorWorld(editorView.cols + 1, editorView.rows)}>
                          +
                        </button>
                        <span className="ml-2 w-4 text-[var(--sim-text-faint)]">В</span>
                        <button type="button" className="btn-neutral h-6 w-6 rounded-md" onClick={() => resizeEditorWorld(editorView.cols, editorView.rows - 1)}>
                          −
                        </button>
                        <span className="w-7 text-center font-semibold">{editorView.rows}</span>
                        <button type="button" className="btn-neutral h-6 w-6 rounded-md" onClick={() => resizeEditorWorld(editorView.cols, editorView.rows + 1)}>
                          +
                        </button>
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      <button type="button" className="btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1.5 py-1" onClick={undoEditor}>
                        Отменить
                      </button>
                      <button type="button" className="btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1.5 py-1" onClick={resetEditor}>
                        Сбросить
                      </button>
                    </div>
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <span className="font-semibold text-[var(--sim-text-muted)]">
                          Зоны ({editorView.zones.length}/{TEST_MAP_LIMITS.zonesMax})
                        </span>
                        {editorView.dirty ? <span className="text-[10px] text-[var(--sim-text-faint)]">не сохранено</span> : null}
                      </div>
                      {editorView.sel.length >= 2 ? (
                        <button
                          type="button"
                          className="mb-1.5 w-full rounded-md bg-[var(--sim-accent)] px-1.5 py-1 text-[11px] font-semibold text-white hover:bg-[var(--sim-accent-hover)]"
                          onClick={mergeEditorZones}
                        >
                          Объединить ({editorView.sel.length})
                        </button>
                      ) : (
                        <p className="mb-1.5 leading-snug text-[10px] text-[var(--sim-text-faint)]">
                          Отметьте галочками две и более зон — появится кнопка объединения.
                        </p>
                      )}
                      <div className="flex flex-col gap-1">
                        {editorView.zones.map((z) => (
                          <div key={z.id} className="flex items-center gap-1.5 rounded-md border border-[var(--sim-line)] bg-[var(--sim-inset-soft)] px-1.5 py-1">
                            <input
                              type="checkbox"
                              checked={editorView.sel.includes(z.id)}
                              onChange={() => toggleEditorSel(z.id)}
                              className="h-3 w-3 shrink-0 accent-[var(--sim-accent)]"
                              aria-label={`Отметить зону ${z.name} для объединения`}
                            />
                            <span
                              aria-hidden
                              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                              style={{ background: z.kind === 'cells' ? 'rgba(120,170,250,0.85)' : 'rgba(112,178,92,0.9)' }}
                            />
                            <input
                              value={z.name}
                              onChange={(ev2) => renameEditorZone(z.id, ev2.target.value)}
                              className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-0.5 py-0.5 text-[11px] outline-none focus:border-[var(--sim-line-strong)] focus:bg-[var(--sim-input-bg)]"
                              aria-label="Название зоны"
                            />
                            <span className="shrink-0 text-[10px] text-[var(--sim-text-faint)]">
                              {z.c1 - z.c0 + 1}×{z.r1 - z.r0 + 1}
                            </span>
                            <button
                              type="button"
                              aria-label={`Удалить зону ${z.name}`}
                              className="btn-neutral flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px]"
                              onClick={() => deleteEditorZone(z.id)}
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                        {editorView.zones.length === 0 ? (
                          <p className="text-[var(--sim-text-faint)]">Пока пусто — нарисуйте первую зону.</p>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-auto flex flex-col gap-1.5 border-t border-[var(--sim-line)] pt-2.5">
                      <input
                        type="password"
                        value={editorPass}
                        onChange={(ev2) => setEditorPass(ev2.target.value)}
                        placeholder="Пароль редактора"
                        aria-label="Пароль редактора локации"
                        className="h-7 rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-input-bg)] px-2 text-[11px] text-[var(--sim-text)] outline-none"
                      />
                      <button
                        type="button"
                        className="h-8 rounded-md bg-[var(--sim-accent)] px-2 text-xs font-semibold text-white hover:bg-[var(--sim-accent-hover)]"
                        onClick={saveEditorMap}
                      >
                        Сохранить локацию
                      </button>
                      {editorMsg ? <p className="leading-snug text-[var(--sim-text-muted)]">{editorMsg}</p> : null}
                      <p className="leading-snug text-[10px] text-[var(--sim-text-faint)]">
                        Сохранение применяет локацию всем в комнате сразу.
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-[var(--sim-text-faint)]">
            <span>W A S D — идти (зажать; на траве — свободная ходьба по пикселям, в боевых клетках — шаг по клеткам)</span>
            <span>Q E Z X — диагонали</span>
            <span>Колесо мыши — приблизить/отдалить вид</span>
            <span>ЛКМ — идти к точке · манекен — тянуть</span>
            <span>{testField ? 'вход в бой — с клетки захода кнопкой «Боевой режим» (B), выход — ею же' : 'B — бой'}</span>
            <span>Enter — чат</span>
            <span>I — удар</span>
            <span>K (удерживать) — блок</span>
            <span>Пробел (удержать и отпустить) — прыжок через обрыв: чем дольше держите, тем выше перепад перепрыгнете</span>
            <span>J — стрела против часовой</span>
            <span>L — по часовой</span>
            <span className="ml-auto">
              Скорость = 100% − замедление · замедление фиксируется в момент прыжка
            </span>
          </div>
        </section>

        {settings.arrow.battleMode && settings.combat.showLog ? (
          <>
            <ColResize
              onDrag={(dx) => setLayout((p) => ({ ...p, logW: clampLayout({ ...p, logW: p.logW - dx }).logW }))}
              onEnd={() => saveLayout(layoutRef.current)}
            />
            <div className="flex h-44 w-full shrink-0 flex-col lg:h-auto lg:min-h-0 lg:w-[var(--log-w)]">
              <FightLog
              lines={combat.log.map(formatLogLine)}
              onClear={() => setCombat((c) => ({ ...c, log: [] }))}
            />
            </div>
          </>
        ) : null}
      </main>

      {/* Надпись об авторах внизу страницы поля */}
      <footer className="relative z-10 shrink-0 pb-1 text-center">
        <p className="text-[10px] leading-tight text-[var(--sim-text-faint)]">{GAME_CREDITS}</p>
      </footer>

      {/* Настройки — выдвижная панель поверх поля: место экрана не отдаёт, открывается кнопкой в шапке */}
      {settingsOpen ? (
        <>
          <div className="fixed inset-0 z-30 bg-black/50" onClick={() => setSettingsOpen(false)} />
          <aside
            className="fixed inset-y-0 right-0 z-40 flex w-[min(400px,92vw)] flex-col border-l border-[var(--sim-line)] bg-[var(--sim-panel)] shadow-2xl"
            onKeyDown={(ev) => {
              if (ev.key === 'Escape') setSettingsOpen(false);
            }}
          >
            <div className="flex items-center justify-between border-b border-[var(--sim-line)] px-3 py-2">
              <h2 className="text-sm font-bold text-[var(--sim-text)]">Настройки</h2>
              <Button size="sm" variant="outline" className="btn-neutral h-7 text-xs" onClick={() => setSettingsOpen(false)}>
                Закрыть
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <SettingsPanel
                settings={settings}
                testField={testField}
                atmo={atmoState}
                onAtmo={changeAtmo}
                atmoCfg={settings.atmo}
                onAtmoCfg={changeAtmoCfg}
                dummyOn={dummyOn}
                onToggleDummy={toggleDummy}
                dummySprite={dummySprite}
                onDummySprite={changeDummySprite}
                rabOn={rabOn}
                onToggleRab={toggleRab}
                patchField={patchField}
                patchCharacter={patchCharacter}
                patchArrow={patchArrow}
                patchSlowdown={patchSlowdown}
                patchWindow={patchWindow}
                patchTier={patchTier}
                patchHud={patchHud}
                patchCombat={patchCombat}
                patchZone={patchZone}
                onResetCombat={onResetCombat}
                onResetAll={onResetAll}
                onExport={onExport}
                onImport={onImport}
                getAngle={getEngineAngle}
                onManualAngle={setEngineAngle}
              />
            </div>
          </aside>
        </>
      ) : null}

      {/* Переход в другую комнату — модалка с тем же выбором гротов.
          Текущая комната помечена «вы здесь», клик по ней disabled. */}
      {switchOpen ? (
        <>
          <div className="fixed inset-0 z-30 bg-black/50" onClick={() => setSwitchOpen(false)} />
          <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto p-4">
            <div className="w-full max-w-3xl rounded-2xl border border-[var(--sim-line)] bg-[var(--sim-panel)] shadow-2xl">
              <RoomPicker
                rows={roomRows}
                ready={roomsRows !== null}
                stale={roomsStale}
                onPick={pickRoom}
                onCancel={() => setSwitchOpen(false)}
              />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

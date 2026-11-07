'use client';
/**
 * Simulator — единственный компонент движка: канвас-сцена, сетевой контекст,
 * панели и JSX. Пояс чистых функций (строки 1–1361 прежней нумерации) выехал
 * волной W5a (этап 1) в src/lib/sim/{engine-consts, particles, editor-model,
 * paint, combat-log, geometry, targeting} и вернулся импортом — behavior-
 * preserving; карта поясов — docs/ARCHITECTURE.md §2.
 * W5b (этап 2) продолжил карвинг: HUD-циферблат уехал в ./simulator/hud-canvas,
 * типы и remote-draw-хелперы — в ./simulator/sim-model, клавиатура/сеть/слои
 * канваса — в ./simulator/hooks/*, JSX-блоки — в ./simulator/components/*,
 * операции черновика редактора — в ./simulator/editor-ops, мышиные
 * обработчики поля — в ./simulator/pointer-tools, конвейер удара — в
 * ./simulator/hooks/use-strike (карта — docs/ARCHITECTURE.md §2). Здесь
 * остался главный rAF-цикл: его 2700-строчное замыкание нельзя разорвать без
 * изменения поведения, а целиком вынести нельзя из-за лимита 800 строк.
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
  CAM_YAW_TAU_MS,
  OCCLUDE_ALPHA,
  OCCLUDE_COVER,
  PEACE_SPEED_DEFAULT,
  PEACE_STUCK_MS,
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
  screenToWorld,
  spriteBoxOf,
  viewDepth,
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
  pushPaintUndo,
  stampPaintBrush,
} from '@/lib/sim/paint';
import {
  EDITOR_PASS_KEY,
  type EditorDraft,
  type EditorPlace,
  type EditorTool,
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
import { ROOMS, createCoopClient, nameFromUrl, roomFromUrl, roomTitle, type CoopAtmo, type CoopAtmoAnchor, type CoopChatMessage, type CoopDummyPos, type CoopFight, type CoopRoomInfo } from '@/lib/net/coop';
import { JUMP_MAX_CELLS, type CoopWhoami } from '@/lib/net/protocol';
import { authPayload } from '@/lib/net/auth';
import { roomsForMode, namedRoom } from '@/lib/net/modes';
import {
  type RemoteDraw,
} from '@/lib/net/move-book';
import { FightLog } from './fight-log';
import { RoomChat } from './room-chat';
import { ThemeBackdrop } from './theme-backdrop';
import { applyTheme, FIELD_PRESETS, fieldPaletteOf, loadTheme, type ThemeId } from '@/lib/sim/theme';
import { stepRemoteAim, type RemoteAim } from '@/lib/sim/remote-aim';
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
  terrainCellClipPath,
  elevLiftAtPoint,
  groundPointAtWorld,
  pointInSouthWall,
  surfaceLevelAt,
  hashStr,
  nearestWalkableCell,
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
  terrainLiftShift,
  terrainTopAnchor,
  terrainWallAnchor,
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
  mapHasPaint,
  PAINT_MAX_BASE64,
  paintFormatError,
  OBJECT_SCALE_MAX,
  OBJECT_SCALE_MIN,
  TERRAIN_MAX_LEVEL,
  elevJumpOk,
  elevStepOk,
  jumpFillOf,
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
  RAB_SPRITE,
  SPRITES,
  WEATHERS,
  bfsPath,
  cycleStartFor,
  dayPartOfProgress,
  dayProgressAt,
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
  wrap360,
  type DayPart,
  type WeatherKind,
} from '@/lib/sim/settings';
import { drawFieldHud } from './simulator/hud-canvas';
import { stepRemoteDraws, type AtmosphereLike, type AtmoClock, type Engine } from './simulator/sim-model';
import { ColResize, RoomSwitchOverlay, SettingsPanelOverlay, SimulatorHeader } from './simulator/components/chrome';
import { EditorOverlay } from './simulator/components/editor-overlay';
import { FieldStage } from './simulator/components/field-stage';
import { buildEditorOps, type EditorSaveState, type EditorSelState } from './simulator/editor-ops';
import { buildPointerTools } from './simulator/pointer-tools';
import { useStrike } from './simulator/hooks/use-strike';
import { useSimKeyboard } from './simulator/hooks/use-keyboard';
import { useSimNet } from './simulator/hooks/use-network';
import { useAimPublisher, useAtmosphereLayer, useSpriteCache } from './simulator/hooks/use-canvas-layers';
import { useElisionView } from './simulator/hooks/use-elision-view';
import { collectElisionFrame } from './simulator/elision-present';
import type { ElisionView } from '@/lib/sim/elision-scene';




export default function Simulator({ mode = 'hub' }: { mode?: 'hub' | 'elision' | 'combat' | 'hunger' } = {}) {
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
  const [whoami, setWhoami] = useState<CoopWhoami | null>(null);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
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
  // Ресайз окна: сохранённые (или растянутые) ширины колонок могут не влезать
  // в новое окно — пере-клампим их к нему, чтобы поле не выжималось в ноль.
  // Стейт трогаем только когда кламп реально меняет числа, иначе каждый
  // resize-тик дёргал бы рендер зря.
  useEffect(() => {
    const onResize = () => {
      const cur = layoutRef.current;
      const next = clampLayout(cur);
      if (next.chatW !== cur.chatW || next.logW !== cur.logW) {
        layoutRef.current = next;
        setLayout(next);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  /** Панель настроек теперь выдвижная: не отдаёт поле постоянной колонке. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Формат поля комнаты: «test» — лужайка/переход/закуток с камерой и свободной ходьбой. */
  const [fieldFormat, setFieldFormat] = useState<'grid' | 'test'>('grid');
  const fieldFormatRef = useRef<'grid' | 'test'>('grid');
  /** Плавная камера «теста»: центр взгляда в px мира; init — встать на игрока без анимации. */
  const camRef = useRef({ x: 0, y: 0, init: false });
  /** Зум камеры «теста». Наклон и псевдо-глубина убраны: вид плоский, поворот — camYawRef. */
  const camFxRef = useRef({ z: 1 });
  /** Поворот обзора, радианы. Положительный — карта крутится по часовой (] ). */
  const camYawRef = useRef(0);
  /** Куда доворачивать обзор: кратно π/2. [ и ] шагают на один прямой угол. */
  const camYawTargetRef = useRef(0);
  /** Зум колесом мыши — множитель поверх базового зума вида (1 — как задано режимом).
   *  Меняется колесом над полем «теста» (в том числе в редакторе локации), сам
   *  плавно догоняется камерой (kz). */
  const camUserZoomRef = useRef(1);
  /** Якорь «зума к курсору» в редакторе: мировая точка под курсором и её экранная
   *  позиция на момент щелчка колеса. Пока зум колеса > 1, кадр держит эту точку
   *  под тем же местом экрана; ≤1 — обзор всей карты без панорамирования. */
  const editorPanRef = useRef<{ px: number; py: number; sx: number; sy: number } | null>(null);
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
  /** Прогресс сохранения локации (фазы кодирования/отправки/подтверждения). */
  const [editorSave, setEditorSave] = useState<EditorSaveState | null>(null);
  /** Вырезанный кусок инструмента «Перенести» (холст + уехавшие данные). */
  const editorSelRef = useRef<EditorSelState | null>(null);
  /** Размеры поля настроек едут вместе с черновиком редактора: отрисовка тянет
   *  рисунок локации на px мира именно по settings.field, поэтому рассинхрон
   *  после смены размера мира растягивал текстуры (баг «съехавших текстур»). */
  const patchField = useCallback(
    (p: Partial<SimSettings['field']>) => setSettings((s) => ({ ...s, field: { ...s.field, ...p } })),
    [],
  );
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
  /** Дебаг-тумблер атмосферного слоя: локальный (не по сети), по умолчанию включён. */
  const [atmoLayerOn, setAtmoLayerOn] = useState(true);
  /** Локальные тумблеры атмосферы (кнопки шапки): погода — частицы, сутки — вуаль.
   *  Значения живут в ref'ах: их подхватывает слой при (пере)монтаже, по сети не едут. */
  const [weatherFxOn, setWeatherFxOn] = useState(true);
  const [dayTintOn, setDayTintOn] = useState(true);
  const weatherFxOnRef = useRef(true);
  const dayTintOnRef = useRef(true);
  const atmoLayerOnRef = useRef(true);
  const atmoStateRef = useRef<CoopAtmo>(atmoState);
  /** Часы атмосферы: якорь комнаты (сервер) или локальный — до первого якоря и без сети. */
  const atmoAnchorRef = useRef<AtmoClock>({ cs: 0, pl: 0, wl: 0, w: 'sun', ws: 0, srv: false });
  const atmoInitRef = useRef(false);
  /** Значок погоды на HUD: текущая, прежняя (для кроссфейда) и момент смены. */
  const hudWxRef = useRef<{ w: WeatherKind; prev: WeatherKind; at: number }>({ w: 'sun', prev: 'sun', at: 0 });
  /** Слот-контейнер слоя атмосферы поверх поля (canvas создаётся императивно
   *  в use-canvas-layers; atmoRef null — WebGL недоступен). */
  const pixiRef = useRef<HTMLDivElement | null>(null);
  /** HUD-канвас над слоем атмосферы: циферблат день/ночь + значок погоды. */
  const hudRef = useRef<HTMLCanvasElement | null>(null);
  const atmoRef = useRef<AtmosphereLike | null>(null);
  /** Прошлая позиция камеры — для сдвига теней облаков (лёгкий параллакс). */
  const camPrevRef = useRef<{ x: number; y: number } | null>(null);
  /** Курсор над полем в мировых координатах (с поправкой на подъём земли):
   *  прицел прыжка — конечная точка привязана к мышке, игрок сам выбирает
   *  дистанцию в пределах максимальной. */
  const cursorWorldRef = useRef<{ x: number; y: number } | null>(null);
  /** Последняя экранная позиция курсора над канвасом (css px от угла): камера
   *  в «тесте» уезжает под курсором каждый кадр (сглаживание за котом), поэтому
   *  мировая точка прицела пересчитывается из неё по свежей камере в цикле —
   *  иначе прицел отлипает от неподвижного курсора в прыжке/приседе. */
  const cursorScreenRef = useRef<{ x: number; y: number } | null>(null);
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
  useAimPublisher({ netRef, settingsRef, aimSyncRef, publishAimRef });
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

  /* Вход на боевые клетки — мгновенный зум без догона камеры: стрела, сетка и
   * проценты энергии появляются сразу. Обратный переход на траву остаётся плавным. */
  const battleOn = settings.arrow.battleMode;
  useEffect(() => {
    if (!battleOn) return;
    if (editorOpenRef.current) return; // в редакторе камера сама подстраивается
    camFxRef.current.z = camUserZoomRef.current;
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

  /** Какие комнаты спрашивать у сервера: каталог режима + комната из ссылки на хабе.
   *  Закрытые комнаты (access 'registered') гость не опрашивает: состав ему
   *  всё равно не нужен (без аккаунта не войти), а сервер и не расскажет —
   *  гость получает про них такой же ответ, как про несуществующие. */
  const whoamiHasAccount = !!whoami?.ok && !!whoami.accountId;
  const wantedRoomIds = useCallback((): string[] => {
    const inAccount = whoamiHasAccount;
    const ids = roomsForMode(mode)
      .filter((r) => r.access !== 'registered' || inAccount)
      .map((r) => r.id);
    if (mode === 'hub') {
      const urlRoom = roomFromUrl();
      if (urlRoom && urlRoom !== 'demo' && !ids.includes(urlRoom)) {
        const gate = namedRoom(urlRoom);
        if (!gate || gate.access !== 'registered' || inAccount) ids.push(urlRoom);
      }
    }
    return ids;
    // Deps MUST be primitives. `whoami` is re-set with a fresh object on every
    // ws handshake, and this callback sits in the network effect deps — with an
    // object dep the client was torn down and re-created on every RTT (entry
    // screen reconnect loop: join never sent, sockets opened 3/sec forever).
  }, [mode, whoamiHasAccount]);

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
    if (!d) return;
    if (d.dirty) {
      // Внешняя карта при открытом черновике с правками: несводимую правку не
      // слить с чужим конфигом — черновик сбрасывается на новую карту целиком
      // (как при открытии редактора), игрок видит предупреждение в панели.
      d.undo = [];
      d.sel = [];
      d.drag = null;
      d.dirty = false;
      setEditorMsg('Локацию сохранил другой игрок — несохранённая правка черновика сброшена на новую карту.');
    }
    d.zones = map.zones.map((z) => ({ ...z }));
    d.objects = (map.objects ?? []).map((o) => ({ ...o }));
    d.spawns = (map.spawns ?? []).map((s) => ({ ...s }));
    d.elev = { ...(map.elev ?? {}) };
    d.cols = map.cols;
    d.rows = map.rows;
    // Холст кисти переснимается из рисунка новой карты — те же вызовы, что
    // начальный снапшот при открытии редактора. Без этого pcv остаётся в
    // размерах старой карты: кисть красит в старых координатах (WYSIWYG
    // сломан), а сохранение молча переносит старый холст 1:1 (encodeDraftPaint).
    d.pundo = [];
    d.pdirty = false;
    d.ppaint = null;
    d.pcv = copyPaintCanvas();
    if (!d.pcv && mapHasPaint(map)) {
      // Рисунок новой карты ещё декодируется: снимок снимется по готовности
      // (как при открытии редактора); кисть до того ленивая и создаст холст
      // уже в размерах новой карты (ensureDraftPaint).
      void ensurePaintDecoded().then((ok2) => {
        const e = editorRef.current;
        if (!ok2 || !e || e.pcv || e.pdirty) return;
        e.pcv = copyPaintCanvas();
        if (e.pcv) setPaintOverride(e.pcv, true);
      });
    }
    setEditorView({ ...d, zones: d.zones.map((z) => ({ ...z })), objects: d.objects.map((o) => ({ ...o })), undo: [...d.undo] });
  }, []);

  const {
    syncEditorView,
    pushEditorUndo,
    openEditor,
    closeEditor,
    setEditorTool,
    clampPlacePos,
    editorPlacementClick,
    confirmEditorPlace,
    cancelEditorPlace,
    resizeEditorWorld,
    commitEditorDrag,
    deleteEditorZone,
    toggleEditorSel,
    mergeEditorZones,
    paintEditorCellObject,
    placeBattleCell,
    applyElevBrush,
    beginElevStroke,
    endElevStroke,
    addEditorSpawn,
    toggleEditorSpawn,
    placeEditorEntry,
    renameEditorZone,
    undoEditor,
    resetEditor,
    saveEditorMap,
    pickEditorSelection,
    dragEditorSelection,
    dropEditorSelection,
  } = buildEditorOps({
    editorRef,
    camRef,
    netRef,
    savedMapRef,
    elevStrokeRef,
    editorCoverRef,
    editorEntryDirRef,
    editorPlaceRef,
    engineRef,
    lastSprRef,
    settingsRef,
    patchEditorPlace,
    setPaintOverride,
    setTestMap,
    setEditorView,
    setEditorOpen,
    setEditorMsg,
    setEditorPass,
    setEditorPlace,
    setEditorSave,
    patchField,
    editorSelRef,
    editorPass,
  });

  /** Размер инструмента редактора одним шагом (Alt+колесо над полем, клавиши [ ]):
   *  в кисти «Земля/Покрытие» — диаметр круглой кисти (1–200 px, шаг ~10%),
   *  при поставленном объекте — масштаб (+/− 0.1). Ref-колбэк для клавиатурного
   *  хука; эффект без зависимостей держит свежие замыкания после каждого рендера. */
  const editorSizeStepRef = useRef<((dir: 1 | -1) => void) | null>(null);
  useEffect(() => {
    editorSizeStepRef.current = (dir) => {
      const d = editorRef.current;
      if (d && d.tool === 'paint') {
        const k = dir > 0 ? 1.12 : 1 / 1.12;
        d.psize = Math.min(200, Math.max(1, Math.round(d.psize * k)));
        syncEditorView();
        return;
      }
      const p = editorPlaceRef.current;
      if (p) {
        const step = dir > 0 ? 0.1 : -0.1;
        patchEditorPlace({ s: Math.min(OBJECT_SCALE_MAX, Math.max(OBJECT_SCALE_MIN, Math.round((p.s + step) * 100) / 100)) });
      }
    };
  });

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

  /** Дебаг: показать/спрятать атмосферный слой локально (тонировка суток,
   *  облака и дождь). Часы и значок погоды на HUD остаются. По сети не едет. */
  const toggleAtmoLayer = useCallback((on: boolean) => {
    atmoLayerOnRef.current = on;
    setAtmoLayerOn(on);
    atmoRef.current?.setVisible(on);
  }, []);

  /** Кнопка «Погода»: облака и дождь локально. Комнатную погоду не трогает —
   *  у остальных игроков своя картинка остаётся. */
  const toggleWeatherFx = useCallback((on: boolean) => {
    weatherFxOnRef.current = on;
    setWeatherFxOn(on);
    atmoRef.current?.setWeatherFx(on);
  }, []);

  /** Кнопка «Сутки»: цветовая вуаль времени суток локально. Часы и
   *  серверный цикл суток продолжают идти — гаснет только подкраска. */
  const toggleDayTint = useCallback((on: boolean) => {
    dayTintOnRef.current = on;
    setDayTintOn(on);
    atmoRef.current?.setDayTint(on);
  }, []);

  /** Принудительное выключение боя на входе в комнату (свежий спавн) — это не
   *  «выход из боя», телепорт на клетку выхода не нужен. */
  const suppressExitTeleportRef = useRef(false);
  useSimNet({
    loaded,
    netStarted,
    setChatLines,
    setEditorMsg,
    setFieldFormat,
    setMeId,
    setNetReady,
    setNetStatus,
    setPeerCount,
    setPlayerName,
    setRoomCode,
    setRoomsRows,
    setRoomsStale,
    setWhoami,
    setSettings,
    aimSyncRef,
    battleEntryRef,
    battleExitRef,
    camRef,
    dummyGrabRef,
    dummyPosRef,
    dummySeenRef,
    dummySyncRef,
    editorOpenRef,
    entryAnchorRef,
    fieldFormatRef,
    engineRef,
    freshJoinRef,
    inZonePrevRef,
    jellyRef,
    liveRemotesRef,
    meIdRef,
    netMovesRef,
    netRef,
    pendingJoinRef,
    remoteAimRef,
    remoteBlockRef,
    remoteDrawRef,
    remoteFmRef,
    remoteFreeRef,
    remoteSpaceRef,
    settingsRef,
    suppressExitTeleportRef,
    applyAtmoAnchor,
    applyDummy,
    applyNetFight,
    applyRab,
    applyTestMap,
    closeEditor,
    clearEditorSave: () => setEditorSave(null),
    showMapLoading,
    wantedRoomIds,
  });

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

  useSpriteCache({ spritesRef, whiteSpritesRef, brokenSpritesRef });

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
  useAtmosphereLayer({ stage, canvasRef, pixiRef, atmoRef, atmoStateRef, atmoOnRef: atmoLayerOnRef, weatherFxOnRef, dayTintOnRef });

  // WebGL-вид только у Элизии. Пока слот не смонтирован (экран входа, грот),
  // import() Babylon не вызывается и 2D-холст остаётся единственной картинкой.
  const elisionHostRef = useRef<HTMLDivElement | null>(null);
  const elisionViewRef = useRef<ElisionView | null>(null);
  const [elisionSlot, setElisionSlot] = useState(false);
  const onElisionHost = useCallback((node: HTMLDivElement | null) => {
    elisionHostRef.current = node;
    setElisionSlot(!!node);
  }, []);
  useElisionView({
    enabled: mode === 'elision' && stage === 'field' && elisionSlot,
    hostRef: elisionHostRef,
    viewRef: elisionViewRef,
  });

  // ВРЕМЕННО (отладка бага рельефа): живое состояние сима в консоли.
  useEffect(() => {
    (window as unknown as { __sim?: unknown }).__sim = {
      engine: () => engineRef.current,
      settings: () => settingsRef.current,
      editor: () => editorRef.current,
      elevLevelAt,
      testPeacePointFree,
      net: () => netRef.current,
      elisionGL: () => elisionViewRef.current?.webgl ?? null,
      elisionGround: () => elisionViewRef.current?.ground ?? null,
    };
    return () => {
      delete (window as unknown as { __sim?: unknown }).__sim;
    };
  });

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
    // Зум работает и в редакторе локации; размер инструмента переехал на
    // Alt+колесо и клавиши [ ] (editorSizeStepRef): диаметр круглой кисти
    // «Земли/Покрытия» (1–200 px, шаг ~10%) или масштаб ставящегося объекта (+/− 0.1).
    // Зум к курсору: на щелчок колеса запоминаем мировую точку под курсором и её
    // экранную позицию (editorPanRef) — кадр держит точку под этим местом экрана.
    const onWheelZoom = (ev: WheelEvent) => {
      if (fieldFormatRef.current !== 'test') return;
      if (ev.ctrlKey) return; // пинч-жест оставляем браузеру
      if (ev.altKey && editorOpenRef.current) {
        ev.preventDefault();
        editorSizeStepRef.current?.(ev.deltaY < 0 ? 1 : -1);
        return;
      }
      ev.preventDefault();
      if (editorOpenRef.current) {
        const rect = cv.getBoundingClientRect();
        const sx = ev.clientX - rect.left;
        const sy = ev.clientY - rect.top;
        const hit = screenToWorld(sx, sy, cv.clientWidth, cv.clientHeight, camRef.current.x, camRef.current.y, camFxRef.current.z, camYawRef.current);
        editorPanRef.current = { px: hit.x, py: hit.y, sx, sy };
      }
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

    /** Прогноз посадки прыжка с данным зарядом (0.15..1). Если курсор на поле,
     *  точка посадки — ровно грунт под курсором (маркер не сдвигается вдоль
     *  луча и не зависит от заряда). Заряд решает только перепад высот
     *  (elevJumpOk). Без курсора — запасной бросок вдоль последнего бега.
     *  ok=false: точка всё равно под курсором, но прыжок туда не выйдет
     *  (кольцо краснеет). sx/sy — точка опоры в клеточных долях; l1 — подъём
     *  земли в точке посадки (px мира). */
    const leapLandingAt = (
      charge: number,
      aim?: { x: number; y: number } | null,
    ): { sx: number; sy: number; x1: number; y1: number; l1: number; dur: number; zH: number; deg: number; battle: boolean; cell: { c: number; r: number } | null; ok: boolean } | null => {
      const s = settingsRef.current;
      const e = engineRef.current;
      const testMode = fieldFormatRef.current === 'test';
      const editorOn = editorState().on;
      if (e.leap || e.blocking) return null;
      if (performance.now() < e.moveLockUntil) return null;
      if (!testMode || editorOn) return null; // вне «теста» и в редакторе — только желейный присед
      if (s.controlled !== 'main') return null; // прыгает только свой кот под управлением
      const fill = jumpFillOf(charge);
      if (!s.arrow.battleMode) {
        const hb = peaceHalfBox(s, spritesRef.current[s.character.sprite]);
        const ax = e.fx + hb.dx;
        const ay = e.fy + hb.dy * 2; // точка опоры (низ-центр модельки)
        const curLevel = elevLevelAt(Math.floor(ax), Math.floor(ay));
        const strict = testEntryStrict();
        const peaceSpotOk = (px: number, py: number): boolean => {
          const dist = Math.hypot(px - ax, py - ay);
          if (dist < 0.3 || dist > JUMP_MAX_CELLS) return false;
          if (!testPeacePointFree(px, py)) return false;
          if (!testPeaceObjectsFree(px, py, s.field.cellW, s.field.cellH)) return false;
          if (strict && testPeaceBattleBlocked(px, py)) return false;
          return elevJumpOk(curLevel, elevLevelAt(Math.floor(px), Math.floor(py)), fill);
        };
        const packPeace = (px: number, py: number, ok: boolean, deg: number) => {
          const lvl = elevLevelAt(Math.floor(px), Math.floor(py));
          const dist = Math.hypot(px - ax, py - ay);
          return {
            sx: px,
            sy: py,
            x1: px - hb.dx,
            y1: py - hb.dy * 2,
            l1: lvl * TERRAIN_LIFT_PX,
            dur: 340 + dist * 130,
            zH: 22 + dist * 18 + Math.abs(lvl - curLevel) * 10,
            deg,
            battle: false,
            cell: null,
            ok,
          };
        };
        // Курсор на поле: посадка строго под ним, без шага вдоль луча.
        if (aim) {
          const px = aim.x / s.field.cellW;
          const py = aim.y / s.field.cellH;
          const adx = (px - ax) * s.field.cellW;
          const ady = (py - ay) * s.field.cellH;
          const deg = Math.hypot(adx, ady) >= 4
            ? wrap360((Math.atan2(ady, adx) * 180) / Math.PI)
            : (e.lastDir ?? (e.face === -1 ? 0 : 180));
          return packPeace(px, py, peaceSpotOk(px, py), deg);
        }
        // Без курсора — бросок вдоль последнего бега, дальность из заряда.
        const deg = e.lastDir ?? (e.face === -1 ? 0 : 180);
        const rad = (deg * Math.PI) / 180;
        const wl = Math.hypot(Math.cos(rad) * s.field.cellW, Math.sin(rad) * s.field.cellH) || 1;
        const ux = (Math.cos(rad) * s.field.cellW) / wl;
        const uy = (Math.sin(rad) * s.field.cellH) / wl;
        const maxCells = Math.min(JUMP_MAX_CELLS, 1.25 + fill * 1.75);
        for (let d = maxCells; d >= 0.3; d -= 0.05) {
          const px = ax + ux * d;
          const py = ay + uy * d;
          if (!peaceSpotOk(px, py)) continue;
          return packPeace(px, py, true, deg);
        }
        return null;
      }
      // Боевой режим «теста»: клетка под курсором (прямая из 8 направлений,
      // 1..3 клетки). Без курсора — вдоль стрелы, до трёх клеток. Сеть
      // подтверждает клетку (событие jump — те же проверки, что elevJumpOk).
      const net = netRef.current;
      const book = netMovesRef.current;
      const netOk = !!net?.ready && book.pending.length === 0 && !!book.server;
      const fromEntry = !!testEntryAt(e.col, e.row);
      const curL = elevLevelAt(e.col, e.row);
      const battleCellOk = (tc: number, tr: number): boolean => {
        const dx = tc - e.col;
        const dy = tr - e.row;
        const axb = Math.abs(dx);
        const ayb = Math.abs(dy);
        const dist = Math.max(axb, ayb);
        const straight = (dx === 0 || dy === 0 || axb === ayb) && dist >= 1 && dist <= JUMP_MAX_CELLS;
        if (!straight) return false;
        if (tc < 0 || tc >= s.field.cols || tr < 0 || tr >= s.field.rows) return false;
        if (!testWalkableCell(tc, tr) && !testEntryAt(tc, tr)) return false;
        if (isBlockedCell(s, 'main', null, tc, tr, liveRemotesRef.current, objectExtras())) return false;
        const toEntry = !!testEntryAt(tc, tr);
        if (!fromEntry && !toEntry && !elevJumpOk(curL, elevLevelAt(tc, tr), fill)) return false;
        return netOk;
      };
      const packBattle = (tc: number, tr: number, sx: number, sy: number, ok: boolean) => {
        const dist = Math.max(Math.abs(tc - e.col), Math.abs(tr - e.row));
        const deg8 = (Math.round(wrap360((Math.atan2(tr - e.row, tc - e.col) * 180) / Math.PI) / 45) * 45) % 360;
        return {
          sx,
          sy,
          x1: tc * s.field.cellW,
          y1: tr * s.field.cellH,
          l1: elevLevelAt(tc, tr) * TERRAIN_LIFT_PX,
          dur: 300 + dist * 90,
          zH: 26 + dist * 14 + Math.abs(elevLevelAt(tc, tr) - curL) * 10,
          deg: deg8,
          battle: true,
          cell: { c: tc, r: tr },
          ok,
        };
      };
      if (aim) {
        const tc = Math.floor(aim.x / s.field.cellW);
        const tr = Math.floor(aim.y / s.field.cellH);
        return packBattle(tc, tr, aim.x / s.field.cellW, aim.y / s.field.cellH, battleCellOk(tc, tr));
      }
      const deg8 = (Math.round(wrap360(e.angle) / 45) * 45) % 360;
      const d8 = dirByDeg(deg8);
      for (let r = JUMP_MAX_CELLS; r >= 1; r--) {
        const tc = e.col + d8.dx * r;
        const tr = e.row + d8.dy * r;
        if (!battleCellOk(tc, tr)) continue;
        return packBattle(tc, tr, tc + 0.5, tr + 0.5, true);
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
       *  рывок в точку под курсором (без курсора — вдоль бега или стрелы).
       *  Красный прогноз (land.ok = false) прыжок не запускает. */
      const consumeLeapRequest = () => {
        const charge = leapRequestRef.current;
        leapRequestRef.current = null;
        if (charge == null || e.leap || e.blocking) return;
        if (performance.now() < e.moveLockUntil) return;
        if (!testMode || editorOn) return; // вне «теста» и в редакторе — только желейный присед
        if (s.controlled !== 'main') return; // прыгает только свой кот под управлением
        const land = leapLandingAt(charge, cursorWorldRef.current);
        if (!land?.ok) return; // под курсором садиться нельзя — остаётся присед-желе
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
        net.emit('jump', {
          x: tc + 1,
          y: tr + 1,
          deg: Math.round(wrap360(land.deg) * 10) / 10,
          charge: Math.round(jumpFillOf(charge) * 1000) / 1000,
        });
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
              : surfaceLevelAt(e.fx + hbL.dx, e.fy + hbL.dy * 2)) * TERRAIN_LIFT_PX
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
          // Клавиша — направление экрана. Сетка шагает в ту сторону мира,
          // которая сейчас смотрит в эту сторону кадра.
          const yawDeg = (camYawRef.current * 180) / Math.PI;
          const worldDir = (Math.round(wrap360(dir - yawDeg) / 45) * 45) % 360;
          const d = dirByDeg(worldDir);
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
        // обрыв: перепад больше одного уровня шагом не проходится (вверх и
        // вниз). Переходы через клетку захода перепадом не считаются — сервер
        // проверяет так же. Перепад 2–3 берётся зарядом Пробела.
        if (
          testMode &&
          !entry?.dir &&
          !testEntryAt(tc, tr) &&
          !elevStepOk(elevLevelAt(e.col, e.row), elevLevelAt(tc, tr))
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
            !elevStepOk(elevLevelAt(e.col, e.row), elevLevelAt(nx.c, nx.r));
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
      // камни/деревья, клетки остальных котов и рельеф (перепад больше одного
      // уровня — стенка: только прыжком). В прыжке обычная ходьба выключена: позицией ведёт
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
        if (vx !== 0 || vy !== 0) {
          e.ptarget = null; // клавиши перебивают клик-цель
          // Клавиши — направления экрана: W всегда вверх кадра, как в Don't Starve.
          // Клик-цель уже в координатах мира (screenToWorld) и здесь не крутится.
          const yaw = camYawRef.current;
          const c = Math.cos(yaw);
          const s = Math.sin(yaw);
          const sx = vx;
          const sy = vy;
          vx = sx * c + sy * s;
          vy = -sx * s + sy * c;
        }
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
          const stepFy = (e.pvy * dt) / 1000 / cellH;
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
          // Обрывы рельефа: перепад больше одного уровня между клеткой точки
          // опоры и целевой — стенка. Один уровень кот перешагивает. В прыжке
          // правило отключено: дуга несёт кота через обрыв. Выталкивание ходит
          // через тот же blocked, поэтому не закинет кота на скалу.
          // Столкновение по нарисованному верху, не по логической клетке: спина
          // высокого плато рисуется севернее клетки и иначе проходится пешком.
          // Точка опоры — лапы (низ спрайта). Центр холста у малышей пустой и
          // торчит над головой: он цеплял кромку локации и верх плато там, где
          // кот уже стоит в траве, и справа от него вырастала невидимая стена.
          const stand = (fx: number, fy: number): [number, number] => [fx + hb.dx, fy + hb.dy * 2];
          const elevWalkBlocked = (fxT: number, fyT: number): boolean => {
            const [x0, y0] = stand(e.fx, e.fy);
            const [x1, y1] = stand(fxT, fyT);
            if (pointInSouthWall(x1, y1)) return true;
            return !elevStepOk(surfaceLevelAt(x0, y0), surfaceLevelAt(x1, y1));
          };
          // Стенка боевых зон для мирной ходьбы — на кромке по обеим осям.
          const battleWall = (fxT: number, fyT: number, axis: 'x' | 'y') =>
            strictEntries && testPeaceBattleDepth(fxT, fyT, axis) > 0;
          const blocked = (fxT: number, fyT: number, axis: 'x' | 'y') => {
            const [px, py] = stand(fxT, fyT);
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
        // Аварией считаем кота в глубине зоны: боевые и чуть выше, и чуть ниже
        // центра. Кот у самой кромки от такой проверки бой не ловит.
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
      // Поворот обзора — шаг [ ] на 90° (camYawTargetRef), зум — колесо.
      if (testMode) {
        const yawT = camYawTargetRef.current;
        const yawK = 1 - Math.exp(-dt / CAM_YAW_TAU_MS);
        camYawRef.current += (yawT - camYawRef.current) * yawK;
        if (Math.abs(yawT - camYawRef.current) < 0.004) camYawRef.current = yawT;
        const vw = cv.clientWidth || 1;
        const vh = cv.clientHeight || 1;
        const cellW = s.field.cellW;
        const cellH = s.field.cellH;
        const kz = 1 - Math.exp(-dt / CAMZOOM_TAU_MS);
        if (editorOn) {
          // Редактор: базовый зум — весь мир целиком (авто-подгонка, вид сверху).
          // Поверх работает зум колесом (camUserZoomRef — общий с полем): >1 —
          // приближение с якорем под курсором (editorPanRef, зум к курсору),
          // ≤1 — обзор всей карты, как раньше.
          const bbE = testFieldGeometry(cellW, cellH).bboxPx;
          const pad = 90;
          const fitZ = Math.max(0.1, Math.min(1.15, Math.min(vw / (bbE.x1 - bbE.x0 + pad), vh / (bbE.y1 - bbE.y0 + pad))));
          const zT = Math.max(0.1, Math.min(1.15 * CAM_USER_ZOOM_MAX, fitZ * camUserZoomRef.current));
          camFxRef.current.z += (zT - camFxRef.current.z) * kz;
          let cxT = (bbE.x0 + bbE.x1) / 2;
          let cyT = (bbE.y0 + bbE.y1) / 2;
          // Якорь зума к курсору: центр = мировая точка − повёрнутое смещение курсора.
          const panE = camUserZoomRef.current > 1.001 ? editorPanRef.current : null;
          if (panE) {
            const dx = (panE.sx - vw / 2) / zT;
            const dy = (panE.sy - vh / 2) / zT;
            const cs = Math.cos(camYawRef.current);
            const sn = Math.sin(camYawRef.current);
            cxT = panE.px - (dx * cs + dy * sn);
            cyT = panE.py - (-dx * sn + dy * cs);
          }
          // Окно видимости с учётом поворота: по осям мира берём проекцию экрана.
          const csA = Math.abs(Math.cos(camYawRef.current));
          const snA = Math.abs(Math.sin(camYawRef.current));
          const vwG = (csA * vw + snA * vh) / zT;
          const vhG = (snA * vw + csA * vh) / zT;
          cxT = bbE.x1 - bbE.x0 >= vwG ? Math.min(Math.max(cxT, bbE.x0 + vwG / 2), bbE.x1 - vwG / 2) : (bbE.x0 + bbE.x1) / 2;
          cyT = bbE.y1 - bbE.y0 >= vhG ? Math.min(Math.max(cyT, bbE.y0 + vhG / 2), bbE.y1 - vhG / 2) : (bbE.y0 + bbE.y1) / 2;
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
          const zBase = camUserZoomRef.current;
          camFxRef.current.z += (zBase - camFxRef.current.z) * kz;
          const { z } = camFxRef.current;
          const txP = peaceWalk ? e.fx * cellW + cellW / 2 : e.col * cellW + cellW / 2;
          const tyP = peaceWalk ? e.fy * cellH + (cellH - 10) / 2 : e.row * cellH + cellH / 2;
          const bb = testFieldGeometry(cellW, cellH).bboxPx;
          const csA = Math.abs(Math.cos(camYawRef.current));
          const snA = Math.abs(Math.sin(camYawRef.current));
          const vwG = (csA * vw + snA * vh) / z;
          const vhG = (snA * vw + csA * vh) / z;
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
        // Прицел прыжка должен совпадать с картинкой кадра, а не с камерой на
        // момент последнего события мыши: в прыжке/приседе камера догоняет кота
        // каждый кадр, и точка мира под неподвижным курсором уплывает без
        // движения мыши. Пересчитываем мировую точку курсора по свежей камере
        const csL = cursorScreenRef.current;
        if (csL) {
          const hit = screenToWorld(csL.x, csL.y, vw, vh, camRef.current.x, camRef.current.y, camFxRef.current.z, camYawRef.current);
          cursorWorldRef.current = groundPointAtWorld(hit.x, hit.y, cellW, cellH);
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

    /** Подъём земли на экране: вверх кадра, не всегда на север. yaw 0 совпадает
     *  с прежним вычитанием из y, после поворота ряд плато не уезжает вкось. */
    const raised = (x: number, y: number, lift: number): { x: number; y: number } => {
      const s = terrainLiftShift(lift, camYawRef.current);
      return { x: x + s.dx, y: y + s.dy };
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
          const upA = raised(
            lpA.x0 + (lpA.x1 - lpA.x0) * tA,
            lpA.y0 + (lpA.y1 - lpA.y0) * tA,
            lpA.l0 + (lpA.l1 - lpA.l0) * tA + e.leapZ,
          );
          px = upA.x;
          py = upA.y;
        } else {
          const upA = raised(px, py, e.liftV + e.leapZ);
          px = upA.x;
          py = upA.y;
        }
      } else if (testModeA) {
        const upA = raised(px, py, elevLevelAt(e.col, e.row) * TERRAIN_LIFT_PX);
        px = upA.x;
        py = upA.y;
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
      const bills: { x: number; y: number; fn: () => void }[] = [];
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
        // камера «теста»: экран → зум → поворот → мир. Земля плоская.
        const fxc = camFxRef.current;
        const yaw = camYawRef.current;
        ctx.translate(vw / 2, vh / 2);
        ctx.scale(fxc.z, fxc.z);
        if (Math.abs(yaw) > 1e-4) ctx.rotate(yaw);
        ctx.translate(-camRef.current.x, -camRef.current.y);
        const geo = testFieldGeometry(s.field.cellW, s.field.cellH);
        ctx.save();
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
        // маркер посадки прыжка: во время заряда кольцо стоит на грунте под курсором.
        // Зелёное — прыжок туда выйдет, оранжевое — заряд или клетка не пускают.
        // В полёте кольцо остаётся в точке отпускания и лежит на поднятой земле.
        if (testMode && !editorOn && s.controlled === 'main') {
          const spH = spaceHoldRef.current;
          const lpM = e.leap;
          let mx = -1;
          let my = -1;
          let mlift = 0;
          let shortM = false; // сюда прыжок не выйдет — кольцо оранжевое
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
            // заряд: кольцо всегда на грунте под курсором; цвет — можно ли туда.
            const chM = 0.15 + 0.85 * Math.min(1, (performance.now() - spH.since) / 4000);
            const landM = leapLandingAt(chM, cursorWorldRef.current);
            if (landM) {
              mx = landM.sx * s.field.cellW;
              my = landM.sy * s.field.cellH;
              mlift = landM.l1;
              shortM = !landM.ok;
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
            const ringM = raised(mx, my, mlift);
            ctx.translate(ringM.x, ringM.y);
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
            const clipK = raised(k.c * s.field.cellW, k.r * s.field.cellH, liftK);
            ctx.fillRect(clipK.x, clipK.y, s.field.cellW, s.field.cellH);
          }
        }
        const partsD = sprintPartsRef.current;
        if (partsD.length > 0) {
          for (const p of partsD) {
            ctx.globalAlpha = Math.min(1, (1 - p.life / p.ttl) * 1.6);
            ctx.fillStyle = p.col;
            ctx.fillRect(p.x - p.size / 2, p.y - p.z - p.size / 2, p.size, p.size);
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
          // выделение «Перенести»: пунктирный контур области; в «плавающем»
          // состоянии — призрак вырезанной отрисовки и зон на новом месте
          const selR = ed.selRect;
          if (selR && ed.tool === 'select') {
            const sxC = ed.selFloat?.dc ?? 0;
            const syR = ed.selFloat?.dr ?? 0;
            const sx0 = (selR.c0 + sxC) * s.field.cellW;
            const sy0 = (selR.r0 + syR) * s.field.cellH;
            const sw2 = (selR.c1 - selR.c0 + 1) * s.field.cellW;
            const sh2 = (selR.r1 - selR.r0 + 1) * s.field.cellH;
            const bufSel = editorSelRef.current;
            if (ed.selFloat && bufSel?.cv) {
              ctx.save();
              ctx.globalAlpha = 0.62;
              ctx.imageSmoothingEnabled = false;
              ctx.drawImage(bufSel.cv, sx0, sy0, sw2, sh2);
              ctx.restore();
              ctx.save();
              ctx.setLineDash([5, 4]);
              ctx.strokeStyle = 'rgba(255, 236, 150, 0.7)';
              ctx.lineWidth = 1.2;
              for (const z of bufSel.zones) {
                ctx.strokeRect(
                  (z.c0 - selR.c0) * s.field.cellW + sx0 + 0.5,
                  (z.r0 - selR.r0) * s.field.cellH + sy0 + 0.5,
                  (z.c1 - z.c0 + 1) * s.field.cellW - 1,
                  (z.r1 - z.r0 + 1) * s.field.cellH - 1,
                );
              }
              ctx.restore();
            }
            ctx.save();
            ctx.setLineDash([7, 5]);
            ctx.strokeStyle = ed.selFloat ? 'rgba(255, 236, 150, 0.95)' : 'rgba(255, 255, 255, 0.8)';
            ctx.lineWidth = 2;
            ctx.strokeRect(sx0 + 1, sy0 + 1, sw2 - 2, sh2 - 2);
            ctx.restore();
          }
        }
        ctx.restore();
        // Трава и цветы — билборды: земля крутится вместе с картой, травинка
        // остаётся вертикальной. Ключ очереди — верх клетки +4.
        for (const d of geo.decor) {
          const cellRowD = Math.min(s.field.rows - 1, Math.max(0, Math.floor(d.y)));
          const yKeyD = cellRowD * s.field.cellH + 4;
          const xKeyD = d.x * s.field.cellW;
          bills.push({
            x: xKeyD,
            y: yKeyD,
            fn: () => {
              const ax = d.x * s.field.cellW;
              const ay = d.y * s.field.cellH;
              ctx.save();
              ctx.translate(ax, ay);
              ctx.rotate(-camYawRef.current);
              ctx.translate(-ax, -ay);
              drawTestDecorItem(ctx, d, s.field.cellW, s.field.cellH, 1);
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
          return raised(drag.x, drag.y, liftDrag);
        }
        if (id === s.controlled) {
          // «Тест», мирный режим: свой кот стоит в свободной позиции
          if (testMode && !s.arrow.battleMode) {
            return raised(e.fx * s.field.cellW, e.fy * s.field.cellH, e.liftV + e.leapZ);
          }
          // боевой прыжок: моделька летит от старой клетки к новой по дуге
          const lp = e.leap;
          if (lp && lp.battle) {
            const t = Math.min(1, Math.max(0, (now - lp.t0) / lp.dur));
            return raised(
              lp.x0 + (lp.x1 - lp.x0) * t,
              lp.y0 + (lp.y1 - lp.y0) * t,
              lp.l0 + (lp.l1 - lp.l0) * t + e.leapZ,
            );
          }
          return raised(e.col * s.field.cellW, e.row * s.field.cellH, e.liftV);
        }
        // чужой кот в свободной ходьбе («тест») — плавная доведённая позиция;
        // высота — по его логической клетке (серверной), прыжок — дугой
        const free = id.startsWith('p') ? remoteFreeRef.current.get(id) : undefined;
        if (free) {
          return raised(free.x * s.field.cellW, free.y * s.field.cellH, liftOfCell(col, row) + remoteHopZ(id));
        }
        const vis = id.startsWith('p') ? remoteDrawRef.current.get(id) : undefined;
        if (vis) {
          return raised(vis.col * s.field.cellW, vis.row * s.field.cellH, liftOfCell(vis.col, vis.row));
        }
        return raised(col * s.field.cellW, row * s.field.cellH, liftOfCell(col, row));
      };
      const dummies = dummiesOf(s, liveRemotesRef.current).filter(
        (d) => d.col >= 0 && d.col < s.field.cols && d.row >= 0 && d.row < s.field.rows,
      );
      /** Глубинная очередь «теста»: добавление — по дальности; вне «теста» — сразу. */
      const runOrQueue = (fn: () => void, x: number, y: number) => {
        if (testMode) bills.push({ x, y, fn });
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
            const upT = raised(
              lpT.x0 + (lpT.x1 - lpT.x0) * tT,
              lpT.y0 + (lpT.y1 - lpT.y0) * tT,
              lpT.l0 + (lpT.l1 - lpT.l0) * tT + e.leapZ,
            );
            cx = upT.x;
            cy = upT.y;
          } else {
            const upT = raised(cx, cy, e.liftV + e.leapZ);
            cx = upT.x;
            cy = upT.y;
          }
        }
        const scaleT =
          selfIdT === 'main' ? s.character.spriteScale : (s.dummies.find((d) => d.id === selfIdT)?.scale ?? 100);
        const th0T = (s.field.cellH - 10) * (scaleT / 100);
        const key = cy + th0T;
        let rect: PxRect | null = null;
        if (sprT0) {
          const th = th0T;
          const tw = th * (sprT0.width / sprT0.height);
          rect = { x0: cx, y0: cy, x1: cx + tw, y1: cy + th };
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
        // Лицо блока — ближайший прямой угол камеры. Один угол на кадр, чтобы
        // ключ сортировки стены и сама стена смотрели в одну сторону.
        const faceYaw = camYawRef.current;
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
          // Клип клетки: полный контур локации на десятки тысяч вершин на КАЖДУЮ
          // клетку рельефа (~180 клипов за кадр) «сильно тормозил» и подвешивал
          // слабые машины. Теперь клетка без кромки не режется вовсе, у клетки на
          // кромке — маленький путь по маске рисунка (terrainCellClipPath).
          const clipT = terrainCellClipPath(cT, rT, cwT, chT);
          const shiftT = terrainLiftShift(liftT, faceYaw);
          const topA = terrainTopAnchor(cT, rT, cwT, chT, liftT, faceYaw);
          // ВЕРХ: ключ — дальняя грань поднятой клетки; всё, что стоит на этой
          // земле (лапы строго ближе к камере), рисуется поверх.
          bills.push({
            x: topA.x,
            y: topA.y,
            fn: () => {
              ctx.save();
              if (clipT) ctx.clip(clipT);
              // поднятая земля этой клетки
              drawTerrainTop(ctx, cwT, chT, cT, rT, gpatT, pcvT, faceYaw);
              // разметка клетки поверх поднятой земли
              if (flatsT) {
                for (const oT of flatsT) {
                  if (oT.kind === 'dirt') {
                    const poT = objectPosOffset(oT);
                    drawDirtPatch(ctx, cwT, chT, (oT.c + 0.5 + poT.dx) * cwT + shiftT.dx, (oT.r + 0.5 + poT.dy) * chT + shiftT.dy, hashStr(oT.id) & 7);
                  } else if (oT.kind === 'ground') {
                    drawGroundCover(ctx, oT, cwT, chT, shiftT.dy, shiftT.dx);
                  } else if (oT.kind === 'entry' && oT.dir) {
                    drawEntryMark(ctx, cwT, chT, (oT.c + 0.5) * cwT + shiftT.dx, (oT.r + 0.5) * chT + shiftT.dy, oT.dir, false);
                  }
                }
              }
              if (battleT) {
                const xT = cT * cwT + shiftT.dx;
                const yT = rT * chT + shiftT.dy;
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
          // СТЕНА: грань, которая смотрит в камеру, если сосед за ней ниже.
          // Ключ — внешний край (на пиксель ближе к игроку), чтобы кот вплотную
          // к фасаду рисовался поверх.
          const wallA = terrainWallAnchor(cT, rT, cwT, chT, faceYaw);
          if (wallA) {
            bills.push({
              x: wallA.x,
              y: wallA.y,
              fn: () => {
                ctx.save();
                if (clipT) ctx.clip(clipT);
                drawTerrainWall(ctx, cwT, chT, cT, rT, faceYaw);
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
        const th = th0;
        const twd = th * (sprC.width / sprC.height);
        const py = pos.y;
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
        if (testMode) ctx.rotate(-camYawRef.current);
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
          const tr = raised(RAB_POS.col * s.field.cellW, RAB_POS.row * s.field.cellH, liftR);
          drawChar(sprR, tr, RAB_SCALE, RAB_ID, false, whiteSpritesRef.current[RAB_SPRITE.id] ?? null, false);
          const thR = (s.field.cellH - 10) * (RAB_SCALE / 100);
          const nameX = tr.x + (sprR.width / sprR.height) * thR * 0.5;
          ctx.save();
          ctx.translate(nameX, tr.y + thR);
          if (testMode) ctx.rotate(-camYawRef.current);
          ctx.translate(-nameX, -(tr.y + thR));
          ctx.font = 'bold 12px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillText(RAB_SPRITE.name, nameX + 1, tr.y - 16);
          ctx.fillStyle = '#f4f4f5';
          ctx.fillText(RAB_SPRITE.name, nameX, tr.y - 17);
          ctx.restore();
        }
      };
      runOrQueue(drawRab, RAB_POS.col * s.field.cellW, RAB_POS.row * s.field.cellH + 3);

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
              ? raised(drag.x, drag.y, liftP)
              : raised(dummyPosRef.current.x * s.field.cellW, dummyPosRef.current.y * s.field.cellH, liftP);
          drawChar(sprP, tp, DUMMY_SCALE, DUMMY_ID, false, whiteSpritesRef.current[dummySpriteRef.current] ?? null, false);
          const thP = (s.field.cellH - 10) * (DUMMY_SCALE / 100);
          const nameX = tp.x + (sprP.width / sprP.height) * thP * 0.5;
          ctx.save();
          ctx.translate(nameX, tp.y + thP);
          if (testMode) ctx.rotate(-camYawRef.current);
          ctx.translate(-nameX, -(tp.y + thP));
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
          ctx.restore();
        }
      };
      runOrQueue(
        drawPoch,
        dummyPosRef.current ? Math.round(dummyPosRef.current.x) * s.field.cellW : 0,
        dummyPosRef.current ? Math.round(dummyPosRef.current.y) * s.field.cellH + 3 : -1,
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
            const ny = tp.y;
            const nameX = sprT ? tp.x + (sprT.width / sprT.height) * th0 * 0.5 : tp.x + s.field.cellW / 2;
            ctx.save();
            ctx.translate(nameX, ny + th0);
            if (testMode) ctx.rotate(-camYawRef.current);
            ctx.translate(-nameX, -(ny + th0));
            ctx.font = 'bold 12px Inter, system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.fillText(d.name, nameX + 1, ny - 16);
            ctx.fillStyle = '#f4f4f5';
            ctx.fillText(d.name, nameX, ny - 17);
            ctx.restore();
          }
        }, tpD.x, yD);
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
          if (testMode) {
            ctx.save();
            ctx.translate(cellX + w0 / 2, cellY + th0);
            ctx.rotate(-camYawRef.current);
            ctx.translate(-(cellX + w0 / 2), -(cellY + th0));
          }
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
          if (testMode) ctx.restore();
        }
        // Шкала заряда прыжка: вертикальная полоска справа от своего кота.
        // Заполняется снизу вверх, пока держится Пробел (4 с — полная).
        // Засечка на половине — порог перепада в 2 уровня; верх — перепад в 3.
        if (testMode && !editorOn && selfId === 'main') {
          const spB = spaceHoldRef.current;
          const heldMs = spB.holding ? now - spB.since : 0;
          const showBar = spB.holding || (spB.releaseAt > 0 && now - spB.releaseAt < 420);
          if (showBar) {
            const fillB = spB.holding
              ? Math.min(1, heldMs / 4000)
              : jumpFillOf(spB.charge);
            const th0b = (s.field.cellH - 10) * (s.character.spriteScale / 100);
            const thb = th0b;
            const twb = thb * (spr.width / spr.height);
            const pyb = cellY;
            const barH = Math.max(36, thb * 0.55);
            const barW = Math.max(5, thb * 0.045);
            const bx = cellX + twb + Math.max(8, thb * 0.07);
            const by = pyb + (thb - barH) * 0.35;
            ctx.save();
            ctx.translate(cellX + twb / 2, cellY + thb);
            ctx.rotate(-camYawRef.current);
            ctx.translate(-(cellX + twb / 2), -(cellY + thb));
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
            const fh = barH * fillB;
            ctx.fillStyle = fillB >= 1 ? '#f6e7a1' : fillB >= 0.5 ? '#8ef0b0' : '#e7c48a';
            ctx.fillRect(bx, by + barH - fh, barW, fh);
            ctx.strokeStyle = 'rgba(255,255,255,0.9)';
            ctx.lineWidth = 1;
            const yHalf = by + barH * 0.5;
            ctx.beginPath();
            ctx.moveTo(bx - 2, yHalf);
            ctx.lineTo(bx + barW + 2, yHalf);
            ctx.stroke();
            ctx.strokeStyle = 'rgba(255,255,255,0.7)';
            ctx.strokeRect(bx - 1, by - 1, barW + 2, barH + 2);
            ctx.restore();
          }
        }
        } else if (!spr) {
          ctx.beginPath();
          ctx.arc(cxp, cyp, 18, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.25)';
          ctx.fill();
        }
      };
      runOrQueue(drawSelf, cellX, selfDrawV.key);

      const charBillRect = (x: number, y: number, scalePct: number, aspect: number): PxRect => {
        const th = (s.field.cellH - 10) * (scalePct / 100);
        const tw = th * aspect;
        return { x0: x, y0: y, x1: x + tw, y1: y + th };
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
        const selfRectO = selfBillRect();
        for (const o of testObjects()) {
          if (o.kind === 'dirt' || o.kind === 'entry' || o.kind === 'ground') continue; // земля, покрытие и заходы — часть грунта
          if (o.id === editorPlaceRef.current?.pickId) continue; // поднят в призрак редактора
          // Свободная точка опоры (доли клетки): сдвигает и точку опоры — глубинная
          // сортировка считает по ней же, деревья у края перекрывают корректно.
          // Рельеф: объект на плато стоит на поднятой земле своей клетки.
          const bO = objectBase(o);
          const liftO = elevLiftAtPoint(bO.x, bO.y);
          const objP = raised(bO.x * s.field.cellW, bO.y * s.field.cellH, liftO);
          const objX = objP.x;
          const by = objP.y - 2;
          const byKey = Math.max(by, Math.floor(bO.y) * s.field.cellH + 3.5);
          const vO = hashStr(o.id) & 7;
          const covered =
            !!selfRectO &&
            coveredRatio(testObjectDrawRect(o, s.field.cellH, objX, by, 1, vO), selfRectO) >= OCCLUDE_COVER;
          bills.push({
            x: objX,
            y: byKey,
            fn: () => {
              ctx.save();
              ctx.translate(objX, by);
              ctx.rotate(-camYawRef.current);
              ctx.translate(-objX, -by);
              if (covered) ctx.globalAlpha = OCCLUDE_ALPHA;
              drawTestObject(ctx, o, s.field.cellW, s.field.cellH, objX, by, 1, vO);
              ctx.restore();
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
          const ghostP = raised(pend.x * s.field.cellW, pend.y * s.field.cellH, elevLiftAtPoint(pend.x, pend.y));
          const gX = ghostP.x;
          const gY = ghostP.y - 2;
          bills.push({
            x: gX,
            y: Math.max(gY, Math.floor(pend.y) * s.field.cellH + 3.5),
            fn: () => {
              ctx.save();
              ctx.translate(gX, gY);
              ctx.rotate(-camYawRef.current);
              ctx.translate(-gX, -gY);
              ctx.globalAlpha = 0.62;
              drawTestObject(ctx, ghost, s.field.cellW, s.field.cellH, gX, gY, 1, 0);
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
        bills.sort((a, b) =>
          viewDepth(a.x, a.y, camRef.current.x, camRef.current.y, camYawRef.current) -
          viewDepth(b.x, b.y, camRef.current.x, camRef.current.y, camYawRef.current),
        );
        for (const b of bills) b.fn();
        // метки уровней рельефа в редакторе: рисуются ПОСЛЕ глубинной очереди —
        // плато своей же клеткой накрыло бы их, а уровень должен читаться всегда
        if (editorOn && ed && Object.keys(ed.elev).length > 0) {
          ctx.font = 'bold 11px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          for (const [keyB, lvB] of Object.entries(ed.elev)) {
            if (!lvB) continue;
            const [cB, rB] = keyB.split(',').map(Number);
            if (!Number.isFinite(cB) || !Number.isFinite(rB)) continue;
            if (cB < 0 || rB < 0 || cB >= ed.cols || rB >= ed.rows) continue;
            const labB = raised((cB + 0.5) * s.field.cellW, (rB + 0.5) * s.field.cellH, lvB * TERRAIN_LIFT_PX);
            const xB = labB.x;
            const yB = labB.y;
            ctx.save();
            ctx.translate(xB, yB);
            ctx.rotate(-camYawRef.current);
            ctx.translate(-xB, -yB);
            ctx.fillStyle = 'rgba(10, 14, 8, 0.72)';
            ctx.beginPath();
            ctx.roundRect(xB - 23, yB - 10, 46, 20, 10);
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = '#eafbe7';
            ctx.fillText(`▲ ${lvB}`, xB, yB + 0.5);
            ctx.restore();
          }
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
            yaw: Math.round(camYawRef.current * 100) / 100,
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
      // Сутки, погода и циферблат — только у рисованной локации («тест», Элизия).
      // На клеточном поле (пивные гроты и остальные grid-комнаты) вуаль ложилась
      // не на весь холст: backing store крупнее CSS-размера, и source-atop
      // оставлял светлый прямоугольник. Плашка «День» в том же углу закрывала кота.
      const cam = camRef.current;
      const cp = camPrevRef.current;
      if (fieldFormatRef.current === 'test') {
        atmoRef.current?.setVisible(atmoLayerOnRef.current);
        // Страховка rAF: throw внутри Pixi-слоя не должен рвать цикл — без
        // перепланирования замерзала бы вся игра, а не только атмосфера.
        try {
          atmoRef.current?.frame(now, dt, cp ? cam.x - cp.x : 0, cp ? cam.y - cp.y : 0);
        } catch (error) {
          console.warn('[atmo] слой упал — выключаю до перезагрузки', error);
          try {
            atmoRef.current?.setVisible(false);
          } catch {
            /* слой уже мёртв — прятать нечего */
          }
          atmoRef.current = null;
        }
        tickAtmo();
        const elision = elisionViewRef.current;
        if (elision) {
          try {
            const sNow = settingsRef.current;
            const selfDummy = sNow.dummies.find((d) => d.id === sNow.controlled);
            elision.frame(
              collectElisionFrame({
                now,
                editor: editorState().on,
                day: atmoStateRef.current.dp,
                camX: cam.x,
                camY: cam.y,
                yaw: camYawRef.current,
                zoom: camFxRef.current.z,
                viewW: cv.clientWidth,
                viewH: cv.clientHeight,
                cols: sNow.field.cols,
                rows: sNow.field.rows,
                cellW: sNow.field.cellW,
                cellH: sNow.field.cellH,
                peace: !sNow.arrow.battleMode,
                engine: engineRef.current,
                controlled: sNow.controlled,
                selfSprite: sNow.controlled === 'main' ? sNow.character.sprite : (selfDummy?.sprite ?? sNow.character.sprite),
                selfScale: sNow.controlled === 'main' ? sNow.character.spriteScale : (selfDummy?.scale ?? 100),
                mainSprite: sNow.character.sprite,
                mainScale: sNow.character.spriteScale,
                mainAt: mainSavedRef.current,
                remotes: liveRemotesRef.current,
                remoteFree: remoteFreeRef.current,
                remoteDraw: remoteDrawRef.current,
                drag: dragRef.current
                  ? { key: dragRef.current.key, x: dragRef.current.x, y: dragRef.current.y, w: dragRef.current.w, h: dragRef.current.h }
                  : null,
                spriteImage: (id) => spritesRef.current[id as SpriteId],
                objects: currentTestMap().objects ?? [],
                rab: rabOnRef.current ? { col: RAB_POS.col, row: RAB_POS.row, scale: RAB_SCALE } : null,
              }),
            );
          } catch (error) {
            console.warn('[elision] WebGL-вид упал — остаётся прежний холст', error);
            try {
              elision.destroy();
            } catch {
              /* вид уже разобран */
            }
            elisionViewRef.current = null;
          }
        }
      } else {
        atmoRef.current?.setVisible(false);
        const hud = hudRef.current;
        if (hud && hud.width !== 0) {
          hud.width = 0;
          hud.height = 0;
        }
      }
      camPrevRef.current = { x: cam.x, y: cam.y };
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

  useSimKeyboard({
    sprintRef,
    enteredRef,
    editorOpenRef,
    settingsRef,
    engineRef,
    spaceHoldRef,
    netRef,
    fieldFormatRef,
    battleToggleRef,
    doStrikeRef,
    startStepRef,
    leapRequestRef,
    editorSizeStepRef,
    camYawTargetRef,
    closeEditor,
    editorEsc: () => {
      const d = editorRef.current;
      if (!d) return false;
      if (d.selFloat) {
        dropEditorSelection();
        return true;
      }
      if (d.selRect && d.tool === 'select') {
        d.selRect = null;
        syncEditorView();
        return true;
      }
      return false;
    },
  });

  /* ---------- мышь ---------- */

  const { canvasPoint, hitTargetAt, hitDummyObjAt, onMove, onLeave, onPointerDown, onUp, onContextMenu, onClick, dropTarget } = buildPointerTools({
    canvasRef,
    camRef,
    camFxRef,
    camYawRef,
    cursorScreenRef,
    cursorWorldRef,
    dirtPaintingRef,
    dragRef,
    dummyOnRef,
    dummyPosRef,
    dummySpriteRef,
    dummySyncRef,
    editorOpenRef,
    editorPlaceRef,
    editorRef,
    engineRef,
    fieldFormatRef,
    inZonePrevRef,
    jellyRef,
    liveRemotesRef,
    mainSavedRef,
    netRef,
    paintStrokeRef,
    skipClickRef,
    spritesRef,
    settingsRef,
    objectExtras,
    setSettings,
    patchDummy: (id, p) => patchDummy(id, p),
    addEditorSpawn,
    applyElevBrush,
    beginElevStroke,
    clampPlacePos,
    commitEditorDrag,
    endElevStroke,
    paintEditorCellObject,
    placeBattleCell,
    placeEditorEntry,
    pushEditorUndo,
    toggleEditorSpawn,
    editorPlacementClick,
    pickEditorSelection,
    dragEditorSelection,
    dropEditorSelection,
  });

  useStrike({
    settings,
    settingsRef,
    combatRef,
    doStrikeRef,
    engineRef,
    jellyRef,
    liveRemotesRef,
    mainSavedRef,
    netRef,
    rabOnRef,
    remoteBlockRef,
    spritesRef,
    rabExtra,
    setCombat,
  });

  /* ---------- патчи настроек ---------- */

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
  const sendAuth = useCallback((action: 'register' | 'login' | 'logout', login = '', pass = '') => {
    setAuthMessage(null);
    netRef.current?.emit('auth', authPayload(action, { login, pass }));
  }, []);

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
    const catalog = roomsForMode(mode);
    const rows: RoomRow[] = catalog.map((r) => ({
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
              whoami={whoami}
              authMessage={authMessage}
              playMode={mode}
              onLogin={(login, pass) => sendAuth('login', login, pass)}
              onRegister={(login, pass) => sendAuth('register', login, pass)}
              onLogout={() => sendAuth('logout')}
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
      <SimulatorHeader
        settings={settings}
        roomCode={roomCode}
        peerCount={peerCount}
        netStatus={netStatus}
        theme={theme}
        changeTheme={changeTheme}
        fieldFormat={fieldFormat}
        editorOpen={editorOpen}
        closeEditor={closeEditor}
        openEditor={openEditor}
        testField={testField}
        patchCharacter={patchCharacter}
        toggleBattleMode={toggleBattleMode}
        patchArrow={patchArrow}
        weatherFxOn={weatherFxOn}
        toggleWeatherFx={toggleWeatherFx}
        dayTintOn={dayTintOn}
        toggleDayTint={toggleDayTint}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        setRoomsStale={setRoomsStale}
        setSwitchOpen={setSwitchOpen}
        canSwitch={roomsForMode(mode).length > 1}
      />

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

        <FieldStage
          fieldFrameRef={fieldFrameRef}
          testField={testField}
          fieldFit={fieldFit}
          fieldW={fieldW}
          fieldH={fieldH}
          canvasRef={canvasRef}
          onMove={onMove}
          onPointerDown={onPointerDown}
          onUp={onUp}
          onLeave={onLeave}
          onContextMenu={onContextMenu}
          onClick={onClick}
          pixiRef={pixiRef}
          elisionHostRef={mode === 'elision' ? onElisionHost : undefined}
          showElisionView={mode === 'elision'}
          hudRef={hudRef}
          battleHint={battleHint}
          mapLoading={mapLoading}
          editorOverlay={
            editorOpen && editorView ? (
              <EditorOverlay
                editorRef={editorRef}
                syncEditorView={syncEditorView}
                editorView={editorView}
                setEditorTool={setEditorTool}
                editorSave={editorSave}
                editorEntryDir={editorEntryDir}
                setEditorEntryDir={setEditorEntryDir}
                editorPlace={editorPlace}
                patchEditorPlace={patchEditorPlace}
                confirmEditorPlace={confirmEditorPlace}
                cancelEditorPlace={cancelEditorPlace}
                resizeEditorWorld={resizeEditorWorld}
                undoEditor={undoEditor}
                resetEditor={resetEditor}
                mergeEditorZones={mergeEditorZones}
                toggleEditorSel={toggleEditorSel}
                renameEditorZone={renameEditorZone}
                deleteEditorZone={deleteEditorZone}
                editorPass={editorPass}
                setEditorPass={setEditorPass}
                saveEditorMap={saveEditorMap}
                editorCover={editorCover}
                setEditorCover={setEditorCover}
                editorMsg={editorMsg}
                closeEditor={closeEditor}
              />
            ) : null
          }
        />

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
      {settingsOpen ? <SettingsPanelOverlay
        setSettingsOpen={setSettingsOpen}
        settings={settings}
        testField={testField}
        atmoState={atmoState}
        changeAtmo={changeAtmo}
        changeAtmoCfg={changeAtmoCfg}
        atmoLayerOn={atmoLayerOn}
        toggleAtmoLayer={toggleAtmoLayer}
        dummyOn={dummyOn}
        toggleDummy={toggleDummy}
        dummySprite={dummySprite}
        changeDummySprite={changeDummySprite}
        rabOn={rabOn}
        toggleRab={toggleRab}
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
        getEngineAngle={getEngineAngle}
        setEngineAngle={setEngineAngle}
      /> : null}

      {/* Переход в другую комнату — модалка с тем же выбором гротов.
          Текущая комната помечена «вы здесь», клик по ней disabled. */}
      {switchOpen ? <RoomSwitchOverlay
        setSwitchOpen={setSwitchOpen}
        roomRows={roomRows}
        roomsRows={roomsRows}
        roomsStale={roomsStale}
        pickRoom={pickRoom}
      /> : null}
    </div>
  );
}


/**
 * Network wiring closure of the Simulator, carved out verbatim from
 * simulator.tsx (W5b stage 2, behavior-preserving). Contract: `useSimNet(deps)`
 * creates exactly one coop client (createCoopClient) when `loaded && netStarted`,
 * registers all server-event handlers in the original order (rooms / you / field /
 * map / atmo / fight / chat / dummy / rab / space / block / ...), mirrors frames
 * into the simulator refs and tears the socket down on unmount or re-run.
 * The deps array stays `[loaded, netStarted, applyNetFight, wantedRoomIds]`;
 * everything else captured is a stable ref or a callback from the same render,
 * one-to-one with the former inline effect inside simulator.tsx.
 */
import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import {
  catToDummy,
  createCoopClient,
  nameFromUrl,
  roomTitle,
  type CoopAtmoAnchor,
  type CoopChatMessage,
  type CoopDummyPos,
  type CoopFight,
  type CoopRoomInfo,
} from '@/lib/net/coop';
import { applyOwnMoveAck, rejectOwnMove, seedRemoteDraw, type RemoteDraw } from '@/lib/net/move-book';
import { createRemoteAim, noteRemoteAim, type RemoteAim } from '@/lib/sim/remote-aim';
import { DUMMY_ID, NET_ROLLBACK_LOCK_MS, RAB_ID, RAB_POS } from '@/lib/sim/engine-consts';
import { sanitizeTestMap, type TestMap } from '@/lib/sim/test-map';
import { SPRITES, type DummyConfig, type SimSettings, type SpriteId } from '@/lib/sim/settings';
import { ensureFieldSprite } from '@/lib/sim/sprite-catalog';
import { rememberRemoteCell, type Engine } from '../sim-model';

export interface SimNetDeps {
  onWorldField?: (map:TestMap,locations?:import('@/lib/sim/location-map').LocationPlace[])=>void;
  onWorldDisconnect?:()=>void;
  onWorldLocations?: (items:import('@/lib/sim/location-map').LocationPlace[])=>void;
  onWorldInfo?: (text:string)=>void;
  loaded: boolean;
  netStarted: boolean;
  setChatLines: Dispatch<SetStateAction<CoopChatMessage[]>>;
  setEditorMsg: Dispatch<SetStateAction<string | null>>;
  setFieldFormat: Dispatch<SetStateAction<'grid' | 'test'>>;
  setMeId: Dispatch<SetStateAction<number | null>>;
  setNetReady: Dispatch<SetStateAction<boolean>>;
  setNetStatus: Dispatch<SetStateAction<string>>;
  setPeerCount: Dispatch<SetStateAction<number>>;
  setPlayerName: Dispatch<SetStateAction<string>>;
  setRoomCode: Dispatch<SetStateAction<string>>;
  setRoomsRows: Dispatch<SetStateAction<CoopRoomInfo[] | null>>;
  setRoomsStale: Dispatch<SetStateAction<boolean>>;
  setWhoami?: (row: import('@/lib/net/protocol').CoopWhoami) => void;
  setSettings: Dispatch<SetStateAction<SimSettings>>;
  aimSyncRef: RefObject<{ deg: number | null; at: number; pending: number | null; timer: ReturnType<typeof setTimeout> | null }>;
  battleEntryRef: RefObject<{ c: number; r: number } | null>;
  battleExitRef: RefObject<{ c: number; r: number } | null>;
  camRef: RefObject<{ x: number; y: number; init: boolean }>;
  dummyGrabRef: RefObject<string | null>;
  dummyPosRef: RefObject<CoopDummyPos | null>;
  dummySeenRef: RefObject<number>;
  dummySyncRef: RefObject<{ at: number }>;
  editorOpenRef: RefObject<boolean>;
  engineRef: RefObject<Engine>;
  entryAnchorRef: RefObject<{ c: number; r: number } | null>;
  fieldFormatRef: RefObject<'grid' | 'test'>;
  freshJoinRef: RefObject<boolean>;
  inZonePrevRef: RefObject<boolean>;
  jellyRef: RefObject<Record<string, number>>;
  liveRemotesRef: RefObject<DummyConfig[]>;
  meIdRef: RefObject<number | null>;
  netMovesRef: RefObject<{ server: { col: number; row: number } | null; pending: { col: number; row: number }[] }>;
  netRef: RefObject<ReturnType<typeof createCoopClient> | null>;
  pendingJoinRef: RefObject<{ room: string; login: string; sprite: SpriteId; scale: number } | null>;
  remoteAimRef: RefObject<Map<string, RemoteAim>>;
  remoteBlockRef: RefObject<Set<number>>;
  remoteDrawRef: RefObject<Map<string, RemoteDraw>>;
  remoteFmRef: RefObject<Map<string, number>>;
  remoteFreeRef: RefObject<Map<string, { x: number; y: number; tx: number; ty: number; sp?: boolean; face?: 1 | -1; jpUntil?: number }>>;
  remoteSpaceRef: RefObject<Map<string, { holding: boolean; since: number; releaseAt: number; charge: number }>>;
  settingsRef: RefObject<SimSettings>;
  suppressExitTeleportRef: RefObject<boolean>;
  applyAtmoAnchor: (a: CoopAtmoAnchor) => void;
  applyDummy: (on: boolean, pos: CoopDummyPos | null, sprite?: SpriteId) => void;
  applyNetFight: (fight: CoopFight) => void;
  applyRab: (on: boolean) => void;
  applyTestMap: (map: TestMap) => void;
  closeEditor: () => void;
  /** Прогресс сохранения завершён (локация применена или сервер отказал). */
  clearEditorSave: () => void;
  showMapLoading: () => void;
  wantedRoomIds: () => string[];
}

export function useSimNet(deps: SimNetDeps) {
  const {
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
    clearEditorSave,
    showMapLoading,
    wantedRoomIds,
  } = deps;
  useEffect(() => {
    if (!loaded || !netStarted) return;
    const pending = pendingJoinRef.current;
    const login = (pending?.login || nameFromUrl() || '').trim();
    // Сокет нужен уже на экране входа: он слушает состав комнат (roomsinfo),
    // пока игрок печатает имя. Вход без имени не делаем — join уйдёт из
    // pickRoom(), где имя берётся из pendingJoinRef (его кладёт joinFromEntry).
    if (login) setPlayerName(login);
    let lastMapSignature='';let lastRoom='';
    const receiveMap=(map:TestMap,notify=false)=>{
      const signature=JSON.stringify(map);
      clearEditorSave();
      if(signature===lastMapSignature){
        // Saving an imported/undone copy can legitimately match the last map.
        // Reconcile the draft, but keep duplicate field broadcasts cheap.
        if(notify&&editorOpenRef.current)applyTestMap(map);
        return;
      }
      lastMapSignature=signature;
      if(notify)setEditorMsg('Локация обновлена.');
      applyTestMap(map);showMapLoading();
    };
    const client = createCoopClient({
      onWhoami: (row) => {
        setWhoami?.(row);
        if (row.ok && row.accountId) setPlayerName(row.login || '');
      },
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
        const worn = typeof cat.sprite === 'string' ? cat.sprite.trim() : '';
        if (worn) ensureFieldSprite(worn);
        const size = cat.size;
        setSettings(s => ({ ...s, character: { ...s.character,
          sprite: worn || s.character.sprite,
          spriteScale: typeof size === 'number' && size >= 60 && size <= 100 ? size : s.character.spriteScale,
        } }));
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
        if(field.room&&field.room!==lastRoom){
          setChatLines([]);lastRoom=field.room;
          if(pendingJoinRef.current)pendingJoinRef.current={...pendingJoinRef.current,room:field.room};
          entryAnchorRef.current=null;battleEntryRef.current=null;battleExitRef.current=null;
          netMovesRef.current.pending=[];engineRef.current.step=null;engineRef.current.path=[];
        }
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
            receiveMap(checkedMap);
          }
        }
        // Атмосфера комнаты — общая: якорь часов цикла и погода приходят в снапшоте
        // (вход, переподключение, сохранение локации).
        if (field.atmo) applyAtmoAnchor(field.atmo);
        camRef.current.init = false;
        remoteFreeRef.current.clear();
        remoteFmRef.current.clear();
        for (const cat of others) if (cat.sprite) ensureFieldSprite(cat.sprite);
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
        if(fmt==='test'&&freshJoinRef.current){freshJoinRef.current=false;
          if(settingsRef.current.arrow.battleMode){suppressExitTeleportRef.current=true;setSettings(p=>({...p,arrow:{...p.arrow,battleMode:false}}));}
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
        setNetStatus(`${fmt==='test'?'Вы в локации '+(field.map?.place?.name??roomTitle(field.room||'demo')):'Вы в комнате '+roomTitle(field.room||'demo')} · ${cats.length} на поле`);
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
        if (field.map)deps.onWorldField?.(field.map,field.locations);
      },
      onMap: (map) => receiveMap(map,true),
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
        if (cat.sprite) ensureFieldSprite(cat.sprite);
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
          // jp — одна дуга и одно приземление; повторные пакеты не запускают их заново.
          if (m.jp) {
            const nowJp = performance.now();
            if (!fr.jpUntil) fr.jpUntil = nowJp + 430;
          } else if(fr.jpUntil === -1) fr.jpUntil=undefined;
          else if(fr.jpUntil) fr.jpUntil=Math.min(fr.jpUntil,performance.now());
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
      onLocations:items=>deps.onWorldLocations?.(items),
      onInfo: (text) => {
        deps.onWorldInfo?.(text);
        setNetStatus(text);
        // Ответ сервера на сохранение локации («Редактор: …») — прогресс больше
        // не ждёт. Отказ (троттлинг «слишком часто», игрок вне локации,
        // ошибка записи) обязан быть виден В ПАНЕЛИ редактора, а не
        // только в усечённой статусной строке: молчаливое гашение прогресса
        // выглядело как «сохранилось», хотя правка жила только в черновике
        // и пропадала при повторном открытии («высоты не сохраняются»).
        if (text.startsWith('Редактор:')) {
          clearEditorSave();
          if (editorOpenRef.current) setEditorMsg(text);
        }
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
        // больше не ломает откат предикта. cliff — обрыв: шаг на клетку с перепадом
        // больше одного уровня отвергнут (нужен прыжок), предикт откатывается.
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
        setNetStatus(
          payload?.reason === 'auth_required'
            ? 'Эта комната только для зарегистрированных. Войдите в аккаунт.'
            : payload?.reason || 'Комната полная (макс. 30). Смените ?room=',
        ),
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
        deps.onWorldDisconnect?.();
        clearEditorSave();
        if(editorOpenRef.current)setEditorMsg('Связь прервалась. Подтверждение сохранения не получено; после подключения проверьте карту.');
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

}

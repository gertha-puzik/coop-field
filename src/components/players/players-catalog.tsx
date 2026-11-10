'use client';

/**
 * Каталог игроков (/players) — P5-редизайн, только elyria-вариант. Маршрут
 * вырезается prune-export-ом из grotto-сборки, а на случай случайной сборки
 * гейтимся инлайном (const IS_ELYRIA — спек §2A: свёртка ветки сборщиком).
 *
 * Ночная витрина по лучшим каталогам жанра: таблица-список и плитки, поиск
 * по имени, сортировка колонок, ключет-догрузка. Клиентский контракт прежний:
 *   GET /profiles — серверная пагинация (?limit, ?cursor — кнопка «Ещё») и
 *   поиск (?q, debounce 300 мс либо Enter); клиент НЕ тянет весь список и
 *   НЕ фильтрует его у себя. total в ответе — legacy-поле, НЕ контракт:
 *   подписи «Показано N из …» рисуем только по реально загруженному.
 * Сортировка колонок — КЛИЕНТСКАЯ и только по загруженным карточкам:
 * сервер отдаёт страницы по старшинству, пересортировка переставляет уже
 * показанные строки. Статусы/активность вычисляются из lastSeenAt
 * (players-format.ts) — честная эвристика свежего входа, сам HTTP-каталог
 * живые сокеты не видит.
 * Deep-link /players?id=<accountId> открывает ПОЛНУЮ страницу профиля
 * (GET /profiles/:id) независимо от списка — компонент PlayerProfile;
 * своя карточка редактируется инлайн (PATCH /profiles/me, P4), поток прежний:
 * ошибки сервера показываются целиком, без молчаливых no-op.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Ночная оболочка каталога — родная P5-редизайна (Starscape/styles.sky);
// сайд-эффект админ-люка: компакт-селект темы в шапке каталога.
// Пересводка W2 (2026-11-08): селект/«Мой профиль»/бейдж входа переехали
// в общую шапку сайта — pageHead-ряд демонтирован, тема и профиль несёт SiteHeader.
import { SiteHeader } from '@/components/site/site-header';
import {
  httpMyProfile,
  httpProfileById,
  httpProfileCatalog,
  type ProfileCard,
  type PublicProfile,
} from '@/lib/net/http-profiles';
import { httpMe } from '@/lib/net/http-auth';
import type { CoopWhoami } from '@/lib/net/protocol';
import PlayerProfile, { BrandRow, ProfileSkeleton, Starscape, displayFont } from './player-profile';
import {
  ACTIVITY_TEXT,
  STATUS_TEXT,
  activityOf,
  avatarOf,
  consumeCatalogDeepLink,
  moonsFromMs,
  moonsText,
  plural,
  ruAgo,
  ruDate,
  ruStamp,
  spriteUrl,
  statusOf,
  type ActivityTone,
  type StatusTone,
} from './players-format';
import styles from './players-elyria.module.css';

const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria';

const PAGE_SIZE = 24;
const SEARCH_DEBOUNCE_MS = 300;

/* ——— честная сортировка: ранги статуса/активности, «нет данных» ———
 * Unknown-значения не выезжают наверх реверсом: неизвестное остаётся
 * неизвестным внизу списка в любом направлении. */

type SortKey = 'name' | 'status' | 'born' | 'seen' | 'age' | 'act';

const SORT_TITLE: Record<SortKey, string> = {
  name: 'Персонаж',
  status: 'Статус',
  born: 'Дата рождения',
  seen: 'Последний вход',
  age: 'Возраст',
  act: 'Активность',
};

/** Стартовое направление при выборе колонки (как в каталоге-референсе). */
const DEF_DIR: Record<SortKey, 1 | -1> = { name: 1, status: 1, born: -1, seen: -1, age: -1, act: -1 };

const RANK_STATUS: Record<StatusTone, number> = { online: 0, sleep: 1, recent: 2, away: 3, unknown: 4 };
const RANK_ACT: Record<ActivityTone, number> = { shifting: 0, positive: 1, ideal: 2, unknown: 3 };

const STATUS_PILL: Record<StatusTone, string> = {
  online: styles.stOnline,
  sleep: styles.stSleep,
  recent: styles.stRecent,
  away: styles.stAway,
  unknown: styles.stUnknown,
};

const ACT_COLOR: Record<ActivityTone, string> = {
  ideal: styles.actIdeal,
  positive: styles.actPositive,
  shifting: styles.actShifting,
  unknown: styles.actUnknown,
};

/** Строка таблицы/плитки: производные поля карточки, вычисленные один раз
 *  на загрузку страницы (clock = момент fetch) — статусы не «плывут»
 *  между перерисовками и не расходятся с пререндером (данные — строго
 *  после монтирования). */
type RowModel = {
  card: ProfileCard;
  name: string;
  shortId: string;
  status: StatusTone;
  activity: ActivityTone;
  born: string;
  bornTs: number | null;
  seenAgo: string;
  seenTs: number | null;
  moons: string;
  moonsN: number | null;
  sprite: string | null;
};

function makeRow(card: ProfileCard, clock: number): RowModel {
  const seen = card.lastSeenAt ?? 0;
  return {
    card,
    name: card.displayName || 'Безымянный',
    shortId: `№${card.accountId.slice(0, 8)}`,
    status: statusOf(seen, clock),
    activity: activityOf(seen, clock),
    born: ruDate(card.createdAt),
    bornTs: card.createdAt > 0 ? card.createdAt : null,
    seenAgo: seen > 0 ? ruAgo(seen, clock) : 'неизвестно',
    seenTs: seen > 0 ? seen : null,
    moons: moonsText(card.createdAt, clock),
    moonsN: moonsFromMs(card.createdAt, clock),
    sprite: spriteUrl(avatarOf(card)),
  };
}

function cmpModels(a: RowModel, b: RowModel, key: SortKey, dir: 1 | -1): number {
  // null-пары («нет данных») сравниваются ДО умножения на направление:
  // неизвестная дата или вход не поднимается реверсом вверх.
  const nullsLast = (x: unknown, y: unknown): number => {
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return 0;
  };
  switch (key) {
    case 'name':
      return a.name.localeCompare(b.name, 'ru') * dir;
    case 'status':
      return (RANK_STATUS[a.status] - RANK_STATUS[b.status]) * dir;
    case 'act':
      return (RANK_ACT[a.activity] - RANK_ACT[b.activity]) * dir;
    case 'born': {
      const n = nullsLast(a.bornTs, b.bornTs);
      return n !== 0 ? n : ((a.bornTs ?? 0) - (b.bornTs ?? 0)) * dir;
    }
    case 'seen': {
      const n = nullsLast(a.seenTs, b.seenTs);
      return n !== 0 ? n : ((a.seenTs ?? 0) - (b.seenTs ?? 0)) * dir;
    }
    case 'age': {
      const n = nullsLast(a.moonsN, b.moonsN);
      return n !== 0 ? n : ((a.moonsN ?? 0) - (b.moonsN ?? 0)) * dir;
    }
  }
  return 0;
}

/** Человекочитаемое пояснение к reason из ответа сервера. */
function humanError(reason: string | undefined, fallback: string): string {
  switch (reason) {
    case 'auth_required':
      return 'Нужен вход в аккаунт.';
    case 'unknown':
      return 'Игрок не найден.';
    case 'csrf':
      return 'Запрос отклонён защитой CSRF.';
    case 'invalid_body':
      return 'Запрос не читается как корректный JSON.';
    case 'empty_patch':
      return 'Нет полей для сохранения.';
    case 'invalid_limit':
      return 'Передан некорректный размер страницы каталога.';
    case 'invalid_cursor':
      return 'Продолжение списка устарело — открываем каталог заново.';
    case 'offline':
      return 'Сервер недоступен.';
    default:
      return fallback;
  }
}

/** Текст ошибки сервера, какой пришёл — таким и покажем (без раскройки). */
function ServerError({ title, details }: { title: string; details?: string }) {
  return (
    <div className={styles.errBox}>
      <p className={styles.errTitle}>{title}</p>
      {details ? <pre className={styles.errDetails}>{details}</pre> : null}
    </div>
  );
}

/** Кнопка сортировки в шапке таблицы (стрелка показывается при hover/фокусе). */
function SortHead({
  label,
  hint,
  active,
  dir,
  cellClass,
  onSort,
}: {
  label: string;
  hint?: string;
  active: boolean;
  dir: 1 | -1;
  cellClass?: string;
  onSort: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.sortBtn} ${active ? styles.sortOn : ''} ${cellClass || ''}`}
      onClick={onSort}
      aria-label={`Сортировать: ${label}`}
      title={hint}
    >
      {label}
      <span className={styles.arr} aria-hidden>
        {active ? (dir === 1 ? '↑' : '↓') : '↕'}
      </span>
    </button>
  );
}

/** Мини-арена со спрайтом аватара и точкой «свежий вход» (пульс гасится
 *  prefers-reduced-motion). Без спрайта — пустая сцена, без выдуманных лиц. */
function MiniArena({ m, big }: { m: RowModel; big?: boolean }) {
  return (
    <span className={`${styles.miniArena} ${big ? styles.tileArena : ''}`} aria-hidden>
      {m.status === 'online' ? <span className={styles.onlineDot} /> : null}
      {m.sprite ? <img src={m.sprite} alt="" /> : null}
    </span>
  );
}

/** Строка таблицы: клик открывает полную страницу профиля. */
function RowBtn({ m, onOpen }: { m: RowModel; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={styles.row}
      onClick={onOpen}
      aria-label={`Открыть профиль: ${m.name}`}
      title={`Профиль ${m.name} (${m.card.displayName ? 'карточка с сервера' : '—'})`}
    >
      <MiniArena m={m} />
      <span className={styles.cName}>
        <span className={styles.catName}>{m.name}</span>
        <span className={styles.acc} title={m.card.accountId}>
          {m.shortId}
        </span>
      </span>
      <span className={`${styles.bornC} ${styles.cBorn}`} title={m.bornTs ? `дата регистрации — ${m.born}` : 'дата регистрации неизвестна'}>
        {m.born}
      </span>
      <span
        className={`${styles.bornC} ${styles.cSeen}`}
        title={m.seenTs ? `последний вход — ${ruDate(m.seenTs)}` : 'записей о входе нет'}
      >
        {m.seenAgo}
      </span>
      <span className={`${styles.ageC} ${styles.cAge}`} title="возраст карточки в лунах (1 луна = 30 дней с регистрации)">
        {m.moons}
      </span>
      <span className={`${styles.actW} ${ACT_COLOR[m.activity]} ${styles.cAct}`}>
        {m.activity === 'unknown' ? 'неизвестно' : `${ACTIVITY_TEXT[m.activity]} активность`}
      </span>
      <span className={styles.cStatus}>
        <span className={`${styles.pill} ${STATUS_PILL[m.status]}`}>{STATUS_TEXT[m.status]}</span>
      </span>
    </button>
  );
}

/** Каркас каталога на время первого fetch: панель .listPanel той же сетки --
 *  заголовки колонок настоящие (они не грузятся), строки/плитки -- полосы .skel
 *  ровно на местах значений. Приход списка меняет полосы на контент, верстка
 *  не перестраивается -- страница не дёргается (аналог ProfileSkeleton, #111). */
const SKEL_ROWS = 14;

function CatalogSkeleton({ viewMode }: { viewMode: 'table' | 'tiles' }) {
  const strip = (w: string, h = 12) => (
    <span className={styles.skel} style={{ width: w, height: h }} />
  );
  const pill = (w: number) => (
    <span className={`${styles.skel} ${styles.skelPill}`} style={{ width: w, height: 24 }} />
  );
  const idx = Array.from({ length: SKEL_ROWS }, (_, i) => i);
  if (viewMode === 'table') {
    return (
      <section
        className={`${styles.panel} ${styles.listPanel}`}
        role="status"
        aria-label="Загружаем каталог"
      >
        <div className={styles.tableWrap}>
          <div className={styles.thead} aria-hidden>
            <div />
            <div>{SORT_TITLE.name}</div>
            <div className={styles.cBorn}>{SORT_TITLE.born}</div>
            <div className={styles.cSeen}>{SORT_TITLE.seen}</div>
            <div className={styles.cAge}>{SORT_TITLE.age}</div>
            <div className={styles.cAct}>{SORT_TITLE.act}</div>
            <div className={styles.cStatus}>{SORT_TITLE.status}</div>
          </div>
          <div className={styles.tbody} aria-hidden>
            {idx.map((i) => (
              <div className={styles.row} key={i}>
                <span className={`${styles.miniArena} ${styles.skel}`} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {strip('62%', 14)}
                  {strip('44%', 10)}
                </span>
                {strip('84%')}
                {strip('96%')}
                {strip('58%')}
                {strip('88%')}
                {pill(78)}
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }
  return (
    <section
      className={`${styles.panel} ${styles.listPanel}`}
      role="status"
      aria-label="Загружаем каталог"
    >
      <div className={styles.tiles} aria-hidden>
        {idx.map((i) => (
          <div className={styles.tile} key={i}>
            <span className={`${styles.miniArena} ${styles.tileArena} ${styles.skel}`} />
            {strip('68%', 15)}
            {strip('46%', 10)}
            {pill(74)}
            {strip('72%')}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Плитка плиточного вида: те же честные данные, компактнее. */
function TileBtn({ m, onOpen }: { m: RowModel; onOpen: () => void }) {
  return (
    <button type="button" className={styles.tile} onClick={onOpen} aria-label={`Открыть профиль: ${m.name}`}>
      <MiniArena m={m} big />
      <span className={styles.catName}>{m.name}</span>
      <span className={styles.acc} title={m.card.accountId}>
        {m.shortId}
      </span>
      <span className={`${styles.pill} ${STATUS_PILL[m.status]}`}>{STATUS_TEXT[m.status]}</span>
      <span className={styles.tAge}>
        <b>{m.moons}</b>
        {` · ${m.seenAgo}`}
      </span>
    </button>
  );
}

/* ================================ страница ================================ */

export default function PlayersCatalog() {
  const [session, setSession] = useState<CoopWhoami | null>(null);
  const [cards, setCards] = useState<ProfileCard[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingFirst, setLoadingFirst] = useState(IS_ELYRIA);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listFail, setListFail] = useState<{
    reason: string;
    message: string;
    details?: string;
    retryCursor: string | null;
  } | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'status', dir: 1 });
  /** Вид каталога персистится между визитами (паттерн elyria-admin-tab, W2-δ3):
   *  так скелетон первой загрузки сразу рисует правильный режим — и ветка
   *  tiles-каркаса достижима на возвратных заходах, а не только в теории. */
  const [viewMode, setViewMode] = useState<'table' | 'tiles'>(() => {
    if (typeof window === 'undefined') return 'table';
    return window.localStorage.getItem('elyria-players-view') === 'tiles' ? 'tiles' : 'table';
  });
  const pickView = useCallback((mode: 'table' | 'tiles') => {
    setViewMode(mode);
    try {
      window.localStorage.setItem('elyria-players-view', mode);
    } catch {
      /* приватный режим/квота — вид просто не переживёт перезагрузку */
    }
  }, []);
  const [focused, setFocused] = useState<ProfileCard | null>(null);
  const [focusMissing, setFocusMissing] = useState<string | null>(null);
  const [myProfile, setMyProfile] = useState<PublicProfile | null>(null);
  /** #84 ч.2: ?mine= — подсветка возврата из редактора; в3: ?coat= — автозаполнение кода KNS. */
  const [mineFlash, setMineFlash] = useState<string | null>(null);
  const [coatLink, setCoatLink] = useState<string | null>(null);
  /** Момент последней успешной загрузки: от него считаются статусы и
   *  «обновлено …» — «сейчас» фиксируется, а не тикает на каждом рендере. */
  const [fetchedAt, setFetchedAt] = useState(0);
  /** Счётчик ходов за списком: ответ с устаревшим номером молча отбрасывается. */
  const seqRef = useRef(0);
  /** Deep-link ?id=<accountId> при заходе по ссылке: пока он не разрешён
   *  (страница ждёт карточку по GET /profiles/:id), каталог не запрашивается
   *  и не рисуется — по ссылке ?id= не мигает список перед профилем.
   *  deepLinkHoldRef читает каталог-эффект СИНХРОННО в том же mount-flush
   *  (ref, а не state, — замыкание эффекта не отстаёт от первого рендера),
   *  profileWait включает экран «Загружаем профиль…» со стороны рендера. */
  const [profileWait, setProfileWait] = useState(false);
  const deepLinkHoldRef = useRef(false);

  /** Поиск: debounce 300 мс; применённый запрос живёт отдельно от поля. */
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(searchInput), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  /** Сессия + своя карточка + deep-link ?id= — поток ОТДЕЛЬНЫЙ от пагинации:
   *  карточка открывается по GET /profiles/:id, даже если списка ещё нет.
   *  Запрос карточки стартует ПЕРВЫМ, параллельно /auth/me (сессия нужна
   *  только бейджу «своя карточка», не самому профилю); каталог-эффект ниже
   *  по коду видит deepLinkHoldRef и не грузит список, пока ссылка не
   *  разрешена. Порядок объявления важен: эффекты одного mount-flush идут
   *  сверху вниз, hold ставится до запуска каталог-эффекта. */
  useEffect(() => {
    if (!IS_ELYRIA) return;
    let dead = false;
    (async () => {
      const dl = consumeCatalogDeepLink();
      const wantId = dl.id;
      deepLinkHoldRef.current = !!wantId;
      if (wantId) setProfileWait(true);
      setMineFlash(dl.mine); // null без параметра — подсветки нет
      setCoatLink(dl.coat ?? null); // null без coat — автозаполнения нет
      const profileP = wantId ? httpProfileById(wantId) : null;
      const me = await httpMe();
      if (dead) return;
      setSession(me);
      const mineP = me.ok && me.accountId ? httpMyProfile() : null;
      const mine = mineP ? await mineP : null;
      const one = profileP ? await profileP : null;
      if (dead) return;
      if (mine?.ok && mine.profile) setMyProfile(mine.profile);
      if (one && wantId) {
        if (one.ok && one.card) setFocused(one.card);
        else {
          // Карточка по ссылке не открылась: честная ошибка поверх каталога —
          // hold снимаем и сами запускаем загрузку списка (он в паузе).
          deepLinkHoldRef.current = false;
          setProfileWait(false);
          setFocusMissing(humanError(one.reason, 'Игрок не найден.'));
          setReloadTick((t) => t + 1);
        }
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

  /** Первая страница каталога: монтирование, смена запроса, повтор. Никакой
   *  клиентской фильтрации — фильтрует сервер (q), и он же режет страницы.
   *  Deep-link ?id= держит список на паузе: пока hold не снят (карточка
   *  получена/ошибка/профиль закрыли), запрос каталога не стартует вовсе. */
  useEffect(() => {
    if (!IS_ELYRIA) return;
    if (deepLinkHoldRef.current) return;
    let dead = false;
    const seq = ++seqRef.current;
    setLoadingFirst(true);
    setListFail(null);
    (async () => {
      const res = await httpProfileCatalog({ q: query || undefined, limit: PAGE_SIZE });
      if (dead || seq !== seqRef.current) return;
      setLoadingFirst(false);
      if (res.ok) {
        setCards(res.items);
        setNextCursor(res.nextCursor);
        setFetchedAt(Date.now());
        return;
      }
      setCards(null);
      setListFail({
        reason: res.reason ?? 'error',
        message: humanError(res.reason, 'Каталог не загрузился.'),
        details: res.details,
        retryCursor: null,
      });
    })();
    return () => {
      dead = true;
    };
  }, [query, reloadTick]);

  /** Следующая страница по nextCursor: append к уже показанным, дубликаты
   *  по accountId отбрасываются (страховка от гонки с правками профилей). */
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const seq = ++seqRef.current;
    setLoadingMore(true);
    setListFail(null);
    const res = await httpProfileCatalog({ q: query || undefined, cursor: nextCursor, limit: PAGE_SIZE });
    if (seq !== seqRef.current) {
      // Параллельно сменился поиск/перезагрузка — ответ устарел; флаг снимаем,
      // иначе «Ещё» навсегда остался бы задизейбленным.
      if (loadingMore) setLoadingMore(false);
      return;
    }
    setLoadingMore(false);
    if (res.ok) {
      setNextCursor(res.nextCursor);
      setFetchedAt(Date.now());
      setCards((prev) => {
        if (!prev) return res.items;
        const seen = new Set(prev.map((c) => c.accountId));
        const add = res.items.filter((c) => !seen.has(c.accountId));
        return add.length ? [...prev, ...add] : prev;
      });
      return;
    }
    setListFail({
      reason: res.reason ?? 'error',
      message: humanError(res.reason, 'Не получилось подгрузить продолжение списка.'),
      details: res.details,
      // Битый курсор — постоянная ошибка: повтор с ним лишь повторил бы её,
      // поэтому откатываемся к перезагрузке первой страницы.
      retryCursor: res.reason === 'invalid_cursor' ? null : nextCursor,
    });
  }, [nextCursor, loadingMore, query]);

  /** Повтор неудачного хода: тот же курсор (сетевая ошибка), либо первая
   *  страница заново (сбой первой страницы и битый курсор). */
  const retryLoad = useCallback(() => {
    if (!listFail) return;
    if (listFail.retryCursor) {
      void loadMore();
      return;
    }
    setReloadTick((t) => t + 1);
  }, [listFail, loadMore]);

  /** Стереть поиск: и поле, и применённый запрос — сразу, без debounce. */
  const clearSearch = useCallback(() => {
    setSearchInput('');
    setQuery('');
  }, []);

  const applySort = useCallback((key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: DEF_DIR[key] }));
  }, []);

  const openCard = useCallback((card: ProfileCard) => {
    setFocused(card);
    setFocusMissing(null);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('id', card.accountId);
      window.history.replaceState(null, '', url);
    } catch {
      /* deep-link в адресе — удобство, не критерий */
    }
  }, []);

  const closeCard = useCallback(() => {
    setFocused(null);
    setFocusMissing(null);
    // Закрыли профиль, открытый по deep-link-ссылке: список так и не грузился
    // (hold) — снимаем паузу и дёргаем загрузку сами. Из обычного захода
    // (клик по строке) каталог уже на месте, тик не нужен.
    if (deepLinkHoldRef.current) {
      deepLinkHoldRef.current = false;
      setProfileWait(false);
      setReloadTick((t) => t + 1);
    }
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('id');
      window.history.replaceState(null, '', url);
    } catch {
      /* без адреса — просто закрываем */
    }
  }, []);

  /** PATCH прошёл: свежий /profiles/me + перерисовка карточки в каталоге. */
  const handleSaved = useCallback(
    (fresh: PublicProfile) => {
      setMyProfile(fresh);
      setCards((prev) => {
        if (!prev) return prev;
        const me = session?.accountId;
        return prev.map((c) =>
          me && c.accountId === me
            ? { ...c, displayName: fresh.displayName, bio: fresh.bio, avatarCharacterId: fresh.avatarCharacterId }
            : c,
        );
      });
      setFocused((prev) =>
        prev && session?.accountId && prev.accountId === session.accountId
          ? { ...prev, displayName: fresh.displayName, bio: fresh.bio, avatarCharacterId: fresh.avatarCharacterId }
          : prev,
      );
    },
    [session],
  );

  /** Производные строки: статусы фиксированы моментом загрузки (fetchedAt),
   *  сортировка — перестановка уже загруженных карточек, ничего выдуманного. */
  const rows = useMemo<RowModel[]>(() => {
    if (!cards) return [];
    const models = cards.map((c) => makeRow(c, fetchedAt || 1));
    const sorted = [...models].sort((a, b) => cmpModels(a, b, sort.key, sort.dir));
    return sorted;
  }, [cards, fetchedAt, sort]);

  if (!IS_ELYRIA) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-6 text-[var(--sim-text-soft)]">
        <p>Страница недоступна в этом варианте сайта.</p>
      </main>
    );
  }

  // Открытый профиль — ПОЛНАЯ страница профиля (свой небосвод и бренд внутри).
  if (focused) {
    const me = session?.ok ? session : null;
    return (
      <PlayerProfile
        card={focused}
        mine={!!(me?.accountId && focused.accountId === me.accountId)}
        myProfile={myProfile}
        onSaved={handleSaved}
        onClose={closeCard}
        mineHighlight={mineFlash}
        coatLink={coatLink}
      />
    );
  }

  // Deep-link-заход (?id=), карточка в пути: каталог не грузится и не
  // рисуется. Вместо текстовой заглушки — каркас будущего профиля той же
  // геометрии (заголовки/лейблы настоящие, контентные места — полосы):
  // страница стоит на месте, приход карточки не перестраивает верстку.
  if (profileWait) {
    return <ProfileSkeleton />;
  }

  const onlineNow = rows.filter((r) => r.status === 'online').length;
  const appliedQuery = query.trim();
  const qPart = appliedQuery ? ` по запросу «${appliedQuery}»` : '';
  const sortNote = `сортировка: ${SORT_TITLE[sort.key].toLowerCase()} ${sort.dir === 1 ? '↑' : '↓'} (по загруженным)`;

  return (
    <div className={styles.sky}>
      <Starscape />
      {/* Пересводка W2 (2026-11-08): общая шапка сайта вверху страницы
          (sticky-полоса); заголовок и BrandRow каталога ниже — как были. */}
      <SiteHeader />
      <div className={styles.page}>
        <BrandRow />

        <header className={styles.pageHead}>
          <h1 className={styles.h1}>
            Игроки <span className={`${styles.lite} ${displayFont.className}`}>Elyria Eides</span>
          </h1>
          {cards && cards.length ? (
            <p className={styles.sub}>
              Загружено {rows.length} {plural(rows.length, 'карточка', 'карточки', 'карточек')}
              {qPart} · <b>{onlineNow} {plural(onlineNow, 'кот', 'кота', 'котов')}</b> с активным входом · обновлено{' '}
              {ruStamp(fetchedAt)}
            </p>
          ) : (
            <p className={styles.sub}>Публичные карточки игроков закрытой локации.</p>
          )}
          <p className={styles.hint} style={{ marginTop: 10 }}>
            <a className={styles.backLink} href="/">
              ← Главное меню
            </a>
          </p>
        </header>

        <form
          className={`${styles.panel} ${styles.controls}`}
          aria-label="Поиск и вид списка"
          onSubmit={(ev) => {
            ev.preventDefault();
            setQuery(searchInput);
          }}
        >
          <div className={styles.search}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="6.5" />
              <path d="m16 16 4.5 4.5" />
            </svg>
            <input
              className={styles.searchInput}
              type="search"
              inputMode="search"
              aria-label="Поиск игрока по имени"
              maxLength={64}
              value={searchInput}
              placeholder="Поиск по имени"
              onChange={(e) => setSearchInput(e.target.value)}
            />
            {searchInput ? (
              <button type="button" className={styles.clearBtn} aria-label="Очистить поиск" title="Очистить поиск" onClick={clearSearch}>
                ×
              </button>
            ) : null}
          </div>
          <div className={styles.seg} role="group" aria-label="Вид списка">
            <button
              type="button"
              className={`${styles.segBtn} ${viewMode === 'table' ? styles.segOn : ''}`}
              aria-pressed={viewMode === 'table'}
              onClick={() => pickView('table')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="4" y="5" width="16" height="14" rx="2.5" />
                <path d="M4 10h16" />
                <path d="M10.5 10v9" />
              </svg>
              Таблица
            </button>
            <button
              type="button"
              className={`${styles.segBtn} ${viewMode === 'tiles' ? styles.segOn : ''}`}
              aria-pressed={viewMode === 'tiles'}
              onClick={() => pickView('tiles')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
                <rect x="4" y="4" width="7" height="7" rx="1.5" />
                <rect x="13" y="4" width="7" height="7" rx="1.5" />
                <rect x="4" y="13" width="7" height="7" rx="1.5" />
                <rect x="13" y="13" width="7" height="7" rx="1.5" />
              </svg>
              Плитки
            </button>
          </div>
        </form>

        {focusMissing ? <ServerError title={focusMissing} /> : null}

        {listFail ? (
          <div style={{ marginBottom: 16 }} className={styles.errBox}>
            <p className={styles.errTitle}>{listFail.message}</p>
            {listFail.details ? <pre className={styles.errDetails}>{listFail.details}</pre> : null}
            <button
              type="button"
              className={`${styles.pbtn} ${styles.pbtnGold}`}
              style={{ marginTop: 10 }}
              onClick={retryLoad}
            >
              Повторить
            </button>
          </div>
        ) : null}

        {loadingFirst && !cards ? <CatalogSkeleton viewMode={viewMode} /> : null}

        {!loadingFirst && cards && cards.length === 0 ? (
          <div className={`${styles.panel} ${styles.empty}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="6.5" />
              <path d="m16 16 4.5 4.5" />
            </svg>
            {appliedQuery ? (
              <>
                <div className={styles.eTitle}>Совпадений нет</div>
                <p>
                  По запросу <span className={styles.hl}>{appliedQuery}</span> не нашлось ни одного кота.
                </p>
                <p>Попробуйте другое имя либо очистите поиск.</p>
              </>
            ) : (
              <>
                <div className={styles.eTitle}>Карточек пока нет</div>
                <p>Пока ни одной публичной карточки. Зарегистрируйся и расскажи о себе — карточка появится здесь.</p>
              </>
            )}
          </div>
        ) : null}

        {rows.length ? (
          <section className={`${styles.panel} ${styles.listPanel}`} aria-label="Каталог игроков">
            {viewMode === 'table' ? (
              <div className={styles.tableWrap}>
                <div className={styles.thead} role="row">
                  <div aria-hidden />
                  <SortHead
                    label={SORT_TITLE.name}
                    hint="имя карточки по алфавиту"
                    active={sort.key === 'name'}
                    dir={sort.dir}
                    onSort={() => applySort('name')}
                  />
                  <SortHead
                    label={SORT_TITLE.born}
                    hint="дата регистрации аккаунта"
                    cellClass={styles.cBorn}
                    active={sort.key === 'born'}
                    dir={sort.dir}
                    onSort={() => applySort('born')}
                  />
                  <SortHead
                    label={SORT_TITLE.seen}
                    hint="последнее появление: сессия или запись кота на поле"
                    cellClass={styles.cSeen}
                    active={sort.key === 'seen'}
                    dir={sort.dir}
                    onSort={() => applySort('seen')}
                  />
                  <SortHead
                    label={SORT_TITLE.age}
                    hint="луны с регистрации (1 луна = 30 дней)"
                    cellClass={styles.cAge}
                    active={sort.key === 'age'}
                    dir={sort.dir}
                    onSort={() => applySort('age')}
                  />
                  <SortHead
                    label={SORT_TITLE.act}
                    hint="активность выводится из времени последнего входа"
                    cellClass={styles.cAct}
                    active={sort.key === 'act'}
                    dir={sort.dir}
                    onSort={() => applySort('act')}
                  />
                  <SortHead
                    label={SORT_TITLE.status}
                    hint="«в игре» — вход был в последние 15 минут"
                    cellClass={styles.cStatus}
                    active={sort.key === 'status'}
                    dir={sort.dir}
                    onSort={() => applySort('status')}
                  />
                </div>
                <div className={styles.tbody}>
                  {rows.map((m) => (
                    <RowBtn key={m.card.accountId} m={m} onOpen={() => openCard(m.card)} />
                  ))}
                </div>
              </div>
            ) : (
              <div className={styles.tiles}>
                {rows.map((m) => (
                  <TileBtn key={m.card.accountId} m={m} onOpen={() => openCard(m.card)} />
                ))}
              </div>
            )}
          </section>
        ) : null}

        {cards && cards.length ? (
          <nav className={`${styles.panel} ${styles.pager}`} aria-label="Дозагрузка списка">
            <div className={styles.pagerInfo}>
              Загружено <b>{rows.length}</b> {plural(rows.length, 'карточка', 'карточки', 'карточек')}
              {qPart} · {sortNote}
              {loadingFirst ? ' · обновляем…' : ''}
            </div>
            {nextCursor ? (
              <button
                type="button"
                className={`${styles.pbtn} ${styles.pbtnGold}`}
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? 'Загружаем…' : 'Ещё'}
              </button>
            ) : (
              <span className={styles.pagerInfo}>Это все карточки{qPart}</span>
            )}
          </nav>
        ) : null}

        <p className={styles.footNote}>Каталог показывает только публичные карточки — входы и пароли не раскрываются</p>
      </div>
    </div>
  );
}

/**
 * Чистые хелперы представления для страниц игроков (P5-редизайн каталога):
 * даты и «луны», статусы и активность из lastSeenAt, аватар/спрайт карточки.
 * Всё детерминировано и без внешних источников: любой вывод ЛЕЖИТ на данных
 * DTO карточки (createdAt/lastSeenAt/lastSeenRoom) — отсутствующие данные
 * оформляются честным «неизвестно»/«—», а не выдуманным значением.
 *
 * Пороги статуса/активности — сознательное решение редизайна: сервер не
 * хранит «в игре прямо сейчас», поэтому статус выводится КЛИЕНТОМ из
 * lastSeenAt (последнее появление: свежая сессия или запись позиции кота).
 * Формулировки согласованы с референсом лучших профилей жанра.
 */

import { namedRoom } from '@/lib/net/modes';
import type { ProfileCharacter } from '@/lib/net/http-profiles';

/** Луна = 30 дней (жанровый «месяц» котёнка). */
export const MOON_DAYS = 30;
const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** Русские окончания: plural(3, 'кот', 'кота', 'котов'). */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.round(n));
  const m10 = abs % 10;
  const m100 = abs % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/* ---------------------------- время и луны ---------------------------- */

const MONTHS_GEN = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

/** «14 мая 2024» по метке времени; 0/мусор → '—' (неизвестная дата). */
export function ruDate(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  try {
    const d = new Date(ts);
    return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`;
  } catch {
    return '—';
  }
}

/** «8 ноября, 14:32» — момент последней успешной загрузки каталога. */
export function ruStamp(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  try {
    const d = new Date(ts);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}, ${hm}`;
  } catch {
    return '';
  }
}

/** Относительное «сколько назад»: сейчас / минуты / часы / дни / недели / месяцы. */
export function ruAgo(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return 'неизвестно';
  const ms = Math.max(0, now - ts);
  if (ms < 2 * MIN_MS) return 'только что';
  if (ms < HOUR_MS) {
    const v = Math.max(1, Math.round(ms / MIN_MS));
    return `${v} ${plural(v, 'минуту', 'минуты', 'минут')} назад`;
  }
  if (ms < DAY_MS) {
    const v = Math.max(1, Math.round(ms / HOUR_MS));
    return `${v} ${plural(v, 'час', 'часа', 'часов')} назад`;
  }
  if (ms < 7 * DAY_MS) {
    const v = Math.round(ms / DAY_MS);
    return v === 1 ? 'вчера' : `${v} ${plural(v, 'день', 'дня', 'дней')} назад`;
  }
  if (ms < 30 * DAY_MS) {
    const v = Math.round(ms / (7 * DAY_MS));
    return `${v} ${plural(v, 'неделю', 'недели', 'недель')} назад`;
  }
  // в кошачьем лоре месяц = луна (MOON_DAYS): старые регистрации считаем в лунах
  const v = Math.round(ms / (MOON_DAYS * DAY_MS));
  return `${v} ${plural(v, 'луна', 'луны', 'лун')} назад`;
}

/** Возраст в лунах (1 луна = 30 дней), дробное; null — даты нет. */
export function moonsFromMs(createdAt: number, now: number = Date.now()): number | null {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
  return Math.max(0, (now - createdAt) / (MOON_DAYS * DAY_MS));
}

/** «30 лун», «22 луны», «0,3 луны» — окончания как в референсе; нет даты → «—». */
export function moonsText(createdAt: number, now: number = Date.now()): string {
  const n = moonsFromMs(createdAt, now);
  if (n === null) return '—';
  const v = Math.round(n * 10) / 10;
  const num = v % 1 === 0 ? String(v) : v.toFixed(1).replace('.', ',');
  const word = v % 1 !== 0 ? plural(2, 'луна', 'луны', 'лун') : plural(v, 'луна', 'луны', 'лун');
  return `${num} ${word}`;
}

/** Целых дней с регистрации для таблицы статистики; null — даты нет. */
export function daysSince(createdAt: number, now: number = Date.now()): number | null {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
  return Math.max(0, Math.floor((now - createdAt) / DAY_MS));
}

/* --------------------- статус и активность из lastSeenAt --------------------- */

export type StatusTone = 'online' | 'sleep' | 'recent' | 'away' | 'unknown';

export const STATUS_TEXT: Record<StatusTone, string> = {
  online: 'В игре',
  sleep: 'Спит',
  recent: 'Недавно ушёл',
  away: 'На удалении',
  unknown: 'Неизвестно',
};

/** Статус по времени последнего появления (честный клиентский вывод):
 *  < 15 мин — «В игре», < 3 ч — «Спит», < 3 дней — «Недавно ушёл», дольше —
 *  «На удалении», данных нет — «Неизвестно». «В игре» — эвристика свежего
 *  входа: HTTP-каталог не видит живых сокетов, поэтому опирается на lastSeenAt. */
export function statusOf(seen: number, now: number = Date.now()): StatusTone {
  if (!Number.isFinite(seen) || seen <= 0) return 'unknown';
  const age = Math.max(0, now - seen);
  if (age < 15 * MIN_MS) return 'online';
  if (age < 3 * HOUR_MS) return 'sleep';
  if (age < 3 * DAY_MS) return 'recent';
  return 'away';
}

export type ActivityTone = 'ideal' | 'positive' | 'shifting' | 'unknown';

export const ACTIVITY_TEXT: Record<ActivityTone, string> = {
  ideal: 'идеальная',
  positive: 'положительная',
  shifting: 'переходная',
  unknown: 'неизвестно',
};

/** Активность-слово из lastSeenAt: < 15 мин — «идеальная», < 3 дней —
 *  «положительная», < 30 дней — «переходная», дольше/нет данных — «неизвестно». */
export function activityOf(seen: number, now: number = Date.now()): ActivityTone {
  if (!Number.isFinite(seen) || seen <= 0) return 'unknown';
  const age = Math.max(0, now - seen);
  if (age < 15 * MIN_MS) return 'ideal';
  if (age < 3 * DAY_MS) return 'positive';
  if (age < 30 * DAY_MS) return 'shifting';
  return 'unknown';
}

/* ------------------------------ карточка ------------------------------ */

export type CardLike = {
  displayName: string;
  avatarCharacterId: string | null;
  characters: ProfileCharacter[];
  activeCharacterId: string | null;
};

/** Персонаж-аватар карточки: явный avatarCharacterId → активный → первый. */
export function avatarOf(card: CardLike): ProfileCharacter | null {
  if (card.avatarCharacterId) {
    const hit = card.characters.find((c) => c.id === card.avatarCharacterId);
    if (hit) return hit;
  }
  return card.characters.find((c) => c.id === card.activeCharacterId) || card.characters[0] || null;
}

/** URL спрайта персонажа (общий whitelist сервера; пустой спрайт → null). */
export function spriteUrl(char: ProfileCharacter | null): string | null {
  return char && char.sprite ? `/sprites/${char.sprite}.png` : null;
}

/** Человеческое название комнаты «дома»: канон каталога комнат, иначе честный
 *  код комнаты (без выдуманных названий — в каталоге этого варианта комнаты
 *  может не оказаться, тогда показываем ровно то, что есть в данных). */
export function homeRoomTitle(room: string | null | undefined): string | null {
  if (!room) return null;
  const hit = namedRoom(room);
  return hit ? hit.title : room;
}

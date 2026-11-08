'use client';

/**
 * Страница-профиль игрока (P5-редизайн /players?id=): ночная панель-карточка
 * по образу лучших профилей жанра — портрет-арена, имя и статус, строки
 * данных, капсулы-резюме, грид достижений и таблица статистики.
 *
 * ЧЕСТНОСТЬ ДАННЫХ: каждый вывод лежит на полях реального DTO карточки
 * (server/profiles.js): createdAt → дата рождения/возраст, lastSeenAt →
 * статус/активность/«последний вход» (пороги в players-format.ts),
 * characters → аватар/персонажи/размер, lastSeenRoom → «дом» (Элизия).
 * Чего в аккаунтах нет — того на странице нет: боевые счётчики («убито
 * мышей» и пр.) сервер не собирает, поэтому достижения и статистика —
 * только вычислимые факты карточки, без выдуманных чисел.
 * Свою карточку можно править инлайн (PATCH /profiles/me, P4) — поток тот же;
 * там же «Игровые параметры» (скрытые настройки: скорость стрелы, урон,
 * броня) — только владелец, сервер хранит их в записи профиля.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Lilita_One } from 'next/font/google';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import type { ProfileCard, ProfileMe, ProfilePatch, ProfileSp, PublicProfile } from '@/lib/net/http-profiles';
import {
  DAMAGE_LEVELS,
  DEFAULT_SETTINGS,
  SP_PROFILE_PERIOD_MAX,
  SP_PROFILE_PERIOD_MIN,
  damageLevelLabel,
  persistProfileSp,
} from '@/lib/sim/settings';
import {
  ACTIVITY_TEXT,
  STATUS_TEXT,
  activityOf,
  avatarOf,
  daysSince,
  homeRoomTitle,
  moonsFromMs,
  moonsText,
  plural,
  ruAgo,
  ruDate,
  spriteUrl,
  statusOf,
  type StatusTone,
} from './players-format';
import styles from './players-elyria.module.css';

/** Латинский шрифт бренда один на обе страницы (Lilita One, только latin:
 *  русские заголовки — system-ui 600); инстанс переиспользуется каталогом. */
export const displayFont = Lilita_One({ weight: '400', subsets: ['latin'], display: 'swap' });

const NAME_MAX = 24;
const BIO_MAX = 280;
const UNKNOWN = 'неизвестно';

const STATUS_COLOR: Record<StatusTone, string> = {
  online: '#7dcaa0',
  sleep: '#9aa3c0',
  recent: '#e2c15a',
  away: '#b9b3d9',
  unknown: 'rgba(185,179,217,.55)',
};

/** Тот же детерминированный генератор звёзд, что в меню Wanderpaws:
 *  пререндер и клиент рисуют одинаковые точки (без hydration-дребезга). */
const rnd = (seed: number) => {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

export function Starscape() {
  const stars: ReactNode[] = [];
  for (let i = 0; i < 72; i += 1) {
    const tiny = rnd(i + 1) < 0.78;
    const twinkle = rnd(i + 51) < 0.24;
    stars.push(
      <span
        key={i}
        className={twinkle ? `${styles.star} ${styles.starTw}` : styles.star}
        style={{
          left: `${(rnd(i + 11) * 100).toFixed(2)}%`,
          top: `${(rnd(i + 90) * 100).toFixed(2)}%`,
          width: tiny ? '1px' : '2px',
          height: tiny ? '1px' : '2px',
          opacity: (0.14 + rnd(i + 17) * 0.7).toFixed(2),
          animationDuration: twinkle ? `${(2.6 + rnd(i + 31) * 3.4).toFixed(1)}s` : undefined,
          animationDelay: twinkle ? `${(rnd(i + 61) * 4).toFixed(1)}s` : undefined,
        }}
      />,
    );
  }
  return <div aria-hidden>{stars}</div>;
}

const moonPath = 'M20.4 14.2A8.6 8.6 0 1 1 9.8 3.6a7 7 0 0 0 10.6 10.6Z';

/** Строка бренда над страницей («Wanderpaws: Elyria Eides», латиница — Lilita One). */
export function BrandRow() {
  return (
    <header className={styles.brand} aria-label="Название игры">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d={moonPath} />
      </svg>
      <span className={`${displayFont.className} ${styles.brandName}`}>Wanderpaws: Elyria Eides</span>
    </header>
  );
}

/* ——— контурные иконки строк данных (стиль референса) ——— */

const stroke = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

type InfoIcon = 'id' | 'calendar' | 'moon' | 'activity' | 'home' | 'paw' | 'feather';

const INFO_ICONS: Record<InfoIcon, ReactNode> = {
  id: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden>
      <rect x="3" y="5" width="18" height="14.5" rx="3" />
      <circle cx="8.6" cy="11" r="1.9" />
      <path d="M13.2 10.2h4.6" />
      <path d="M13.2 14h4.6" />
    </svg>
  ),
  calendar: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden>
      <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
      <path d="M3.5 10.4h17" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
    </svg>
  ),
  moon: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d={moonPath} />
    </svg>
  ),
  activity: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M3 12.2h3.5l2.4-5.8 4 11.2 2.4-5.4H21" />
    </svg>
  ),
  home: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M3.6 10.2 12 3.6l8.4 6.6" />
      <path d="M5.6 9.6V20a1 1 0 0 0 1 1h10.8a1 1 0 0 0 1-1V9.6" />
      <path d="M9.8 21v-6.2h4.4V21" />
    </svg>
  ),
  paw: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden>
      <ellipse cx="12" cy="16.6" rx="4.4" ry="3.4" />
      <circle cx="5.8" cy="12.4" r="1.6" />
      <circle cx="9.4" cy="9.6" r="1.8" />
      <circle cx="14.6" cy="9.6" r="1.8" />
      <circle cx="18.2" cy="12.4" r="1.6" />
    </svg>
  ),
  feather: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M20.2 4.2C11.6 5 7 10 6.4 19.8 15.4 19.6 20 14.8 20.2 4.2Z" />
      <path d="M7.2 18.9C9.8 12.8 13.6 8.8 19.4 6.2" />
    </svg>
  ),
};

/* заливные иконки достижений (как в референсе) */
type AchIcon = 'star' | 'moon' | 'paw' | 'leaf' | 'eye' | 'flame';

const ACH_ICONS: Record<AchIcon, ReactNode> = {
  star: <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />,
  moon: <path d={moonPath} />,
  paw: (
    <>
      <ellipse cx="12" cy="16.4" rx="4.6" ry="3.5" />
      <circle cx="5.5" cy="12.2" r="1.9" />
      <circle cx="9.3" cy="9.3" r="2" />
      <circle cx="14.7" cy="9.3" r="2" />
      <circle cx="18.5" cy="12.2" r="1.9" />
    </>
  ),
  leaf: (
    <>
      <path d="M20.6 3.4C9.8 4.4 4.4 10.2 3.9 20.6 14.2 20.2 19.6 14.4 20.6 3.4Z" />
      <path d="M4.8 19.7C7.6 12.9 12 8.4 18.9 5.1" stroke="#070b18" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </>
  ),
  eye: (
    <>
      <path d="M12 5.4C6.6 5.4 2.7 9.8 1.5 12 2.7 14.2 6.6 18.6 12 18.6 17.4 18.6 21.3 14.2 22.5 12 21.3 9.8 17.4 5.4 12 5.4Z" />
      <circle cx="12" cy="12" r="4.1" fill="#070b18" />
    </>
  ),
  flame: (
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
  ),
};

const spark = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 3l2.1 6.9L21 12l-6.9 2.1L12 21l-2.1-6.9L3 12l6.9-2.1z" />
  </svg>
);

/* ——— честные «достижения»: каждый — вычислимый факт карточки ——— */

type AchFact = { title: string; hint: string; icon: AchIcon; earned: boolean; color: string };

function achFacts(card: ProfileCard, now: number): AchFact[] {
  const seen = card.lastSeenAt ?? 0;
  const moons = moonsFromMs(card.createdAt, now) ?? 0;
  return [
    {
      title: 'Звёздный дебют',
      hint: 'публичная карточка в каталоге создана',
      icon: 'star',
      earned: card.createdAt > 0,
      color: '#f6d7a2',
    },
    {
      title: 'Первая луна',
      hint: '30 дней с того дня, как карточка появилась',
      icon: 'moon',
      earned: moons >= 1,
      color: '#f6d7a2',
    },
    {
      title: 'Свой облик',
      hint: 'выбран персонаж-аватар карточки',
      icon: 'paw',
      earned: card.avatarCharacterId !== null,
      color: '#efe7ff',
    },
    {
      title: 'Летописец',
      hint: 'заполнено поле «о себе»',
      icon: 'leaf',
      earned: card.bio.trim().length > 0,
      color: '#7dcaa0',
    },
    {
      title: 'Многоликий',
      hint: 'в аккаунте больше одного персонажа',
      icon: 'eye',
      earned: card.characters.length >= 2,
      color: '#efe7ff',
    },
    {
      title: 'Ночной патруль',
      hint: 'появлялась в последние три дня',
      icon: 'flame',
      earned: seen > 0 && now - seen < 3 * 24 * 60 * 60 * 1000,
      color: '#f6d7a2',
    },
  ];
}

/* ——— портрет: арена-лужайка со спрайтом выбранного персонажа ——— */

function Portrait({ card, name }: { card: ProfileCard; name: string }) {
  const char = avatarOf(card);
  const url = spriteUrl(char);
  const scale = Math.min(120, Math.max(60, char?.size || 100));
  return (
    <figure className={styles.avatar}>
      <span className={styles.avatarArt}>
        <span className={styles.meadow} aria-hidden>
          <svg className={styles.grass} viewBox="0 0 198 74" preserveAspectRatio="none" aria-hidden>
            <g fill="#101d3c" opacity=".85">
              <path d="M8 74C10 52 14 40 12 24c5 16 7 34 8 50z" />
              <path d="M30 74c3-24-1-40 4-56 4 18 6 38 7 56z" />
              <path d="M55 74c2-20 6-32 4-46 5 16 7 32 8 46z" />
              <path d="M132 74c2-18-2-34 4-48 4 16 5 34 7 48z" />
              <path d="M158 74c2-22 6-36 3-52 6 18 8 38 9 52z" />
              <path d="M179 74c2-18-1-32 4-44 3 16 5 32 5 44z" />
            </g>
            <g fill="#060d1e" opacity=".95">
              <path d="M0 74C3 48 6 30 4 12c7 20 9 42 10 62z" />
              <path d="M22 74c4-30 2-48 8-66 4 22 5 44 6 66z" />
              <path d="M163 74c3-28 0-46 7-64 3 22 4 44 4 64z" />
              <path d="M184 74c3-24 1-40 6-54 3 18 3 38 4 54z" />
            </g>
            <g fill="#ffffff">
              <circle cx="34" cy="22" r="1.2" opacity=".55" />
              <circle cx="164" cy="14" r="1.4" opacity=".45" />
              <circle cx="99" cy="9" r="1" opacity=".5" />
            </g>
          </svg>
        </span>
        {url ? (
          <img
            className={styles.portrait}
            src={url}
            alt={`Спрайт персонажа: ${name}`}
            style={{ width: `${scale}%`, height: 'auto' }}
          />
        ) : (
          // спрайт не выбран — безликая лапа, а не выдуманный портрет
          <span className={styles.portraitPaw} aria-hidden>
            🐾
          </span>
        )}
      </span>
      <figcaption className={styles.avatarCap}>{name}</figcaption>
    </figure>
  );
}

/* ——— инлайн-редактор своей карточки (P4, поток прежний) ——— */

/** Черновик СП: все три значения заполнены (незаданное в профиле берётся из
 *  дефолтов движка) — контролам всегда есть что показать. */
type SpDraft = { periodSec: number; damageLevel: number; armorLevel: number };

const fmtSec = (v: number) => `${v.toFixed(1).replace('.', ',')} сек`;

/** Стартовые СП редактора: сохранённые в профиле, недостающее — дефолты
 *  симулятора (те же значения, с которых начинался экран входа). */
const spDefaults = (sp: ProfileSp | undefined): SpDraft => ({
  periodSec: typeof sp?.periodSec === 'number' ? sp.periodSec : DEFAULT_SETTINGS.arrow.periodSec,
  damageLevel: typeof sp?.damageLevel === 'number' ? sp.damageLevel : DEFAULT_SETTINGS.combat.damageLevel,
  armorLevel: typeof sp?.armorLevel === 'number' ? sp.armorLevel : DEFAULT_SETTINGS.combat.armorLevel,
});

/** Кнопка-пресет урона/брони: как чипы экрана входа, компактная. */
function SpChip({ active, onClick, children: label }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={
        active
          ? 'h-6 shrink-0 rounded bg-[var(--sim-accent)] px-2 text-[10px] font-semibold leading-none text-black'
          : 'h-6 shrink-0 rounded border border-[var(--sim-line-strong)] px-2 text-[10px] font-semibold leading-none text-[var(--sim-text)] hover:border-[var(--sim-line-hover)]'
      }
    >
      {label}
    </button>
  );
}

function humanEditError(reason: string | undefined): string {
  switch (reason) {
    case 'auth_required':
      return 'Нужен вход в аккаунт.';
    case 'csrf':
      return 'Запрос отклонён защитой CSRF.';
    case 'invalid_body':
      return 'Запрос не читается как корректный JSON.';
    case 'empty_patch':
      return 'Нет полей для сохранения.';
    case 'invalid':
      return 'Проверьте поля карточки — что-то заполнено неверно.';
    case 'offline':
      return 'Сервер недоступен.';
    default:
      return 'Не получилось сохранить.';
  }
}

function OwnProfileEditor({ profile, onSaved }: { profile: ProfileMe; onSaved: (fresh: PublicProfile) => void }) {
  const [draftName, setDraftName] = useState(profile.displayName);
  const [draftBio, setDraftBio] = useState(profile.bio);
  const [draftAvatar, setDraftAvatar] = useState<string>(profile.avatarCharacterId || '');
  const [draftSp, setDraftSp] = useState<SpDraft>(() => spDefaults(profile.sp));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [fail, setFail] = useState<{ title: string; details?: string } | null>(null);

  useEffect(() => {
    setDraftName(profile.displayName);
    setDraftBio(profile.bio);
    setDraftAvatar(profile.avatarCharacterId || '');
    setDraftSp(spDefaults(profile.sp));
  }, [profile]);

  /** СП едут в PATCH только если игрок их реально тронул: неточно равные
   *  наборы не перезаписывают профиль (и не мешают правке имени/био). */
  const spOrigin = spDefaults(profile.sp);
  const spChanged =
    draftSp.periodSec !== spOrigin.periodSec ||
    draftSp.damageLevel !== spOrigin.damageLevel ||
    draftSp.armorLevel !== spOrigin.armorLevel;

  const save = async () => {
    setFail(null);
    const name = draftName.replace(/\s+/g, ' ').trim();
    if (!name) {
      setFail({ title: 'Имя не может быть пустым (1–24 символа).' });
      return;
    }
    setBusy(true);
    const { httpPatchProfile, httpMyProfile } = await import('@/lib/net/http-profiles');
    const patch: ProfilePatch = {
      displayName: name,
      bio: draftBio.trim(),
      avatarCharacterId: draftAvatar || null,
    };
    if (spChanged) patch.sp = { ...draftSp };
    const res = await httpPatchProfile(patch);
    if (!res.ok) {
      setFail({ title: humanEditError(res.reason), details: res.details || undefined });
      setBusy(false);
      return;
    }
    // перечитка своим GET /profiles/me: свежий источник правды после PATCH
    const fresh = await httpMyProfile();
    setBusy(false);
    if (fresh.ok && fresh.profile) {
      // применяем подтверждённые сервером СП к локальным настройкам сессии —
      // тот же стор, что и панель настроек; вход Элизии применит их при входе
      if (spChanged) persistProfileSp({ ...draftSp, ...(fresh.profile.sp ?? {}) });
      onSaved(fresh.profile);
      setNote('Сохранено.');
      window.setTimeout(() => setNote(null), 2500);
    } else {
      setFail({ title: 'Изменения сохранились, но свежий профиль не прочитался — обновите страницу.' });
    }
  };

  return (
    <form
      className={styles.edBox}
      onSubmit={(ev) => {
        ev.preventDefault();
        void save();
      }}
    >
      <h3 className={styles.edTitle}>Правка своей карточки</h3>
      <div className={styles.edRow}>
        <label className={styles.edField}>
          <span className={styles.edLabel}>Имя (до {NAME_MAX} символов)</span>
          <Input
            className="mt-1 h-8 text-sm"
            value={draftName}
            maxLength={NAME_MAX}
            onChange={(e) => setDraftName(e.target.value)}
          />
        </label>
        <label className={styles.edField}>
          <span className={styles.edLabel}>Аватар (персонаж)</span>
          <select
            className="mt-1 h-8 w-full rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] px-2 text-sm text-[var(--sim-text)]"
            value={draftAvatar}
            onChange={(e) => setDraftAvatar(e.target.value)}
          >
            <option value="">Без аватара</option>
            {profile.characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={styles.edField}>
        <span className={styles.edLabel}>О себе (до {BIO_MAX} символов)</span>
        <textarea
          className="mt-1 min-h-20 w-full rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-2 text-sm text-[var(--sim-text)] outline-none focus-visible:border-[var(--sim-line-hover)]"
          value={draftBio}
          maxLength={BIO_MAX}
          onChange={(e) => setDraftBio(e.target.value)}
        />
      </label>

      {/* Игровые параметры: приватные настройки владельца — применяются на
          поле в этой игре; меняются отсюда и на входе больше не спрашиваются. */}
      <h3 className={`${styles.edTitle} mt-4`}>Игровые параметры</h3>
      <div className={styles.edRow}>
        <label className={styles.edField}>
          <span className={styles.edLabel}>Скорость стрелы ({fmtSec(SP_PROFILE_PERIOD_MIN)}–{fmtSec(SP_PROFILE_PERIOD_MAX)})</span>
          <div className="mt-2 flex items-center gap-2">
            <Slider
              className="flex-1"
              value={[draftSp.periodSec]}
              min={SP_PROFILE_PERIOD_MIN}
              max={SP_PROFILE_PERIOD_MAX}
              step={0.1}
              aria-label="Скорость стрелы"
              onValueChange={(vals) => {
                const v = vals[0];
                if (typeof v === 'number') setDraftSp((d) => ({ ...d, periodSec: Math.round(v * 10) / 10 }));
              }}
            />
            <span className="w-14 text-right text-sm tabular-nums text-[var(--sim-text-soft)]">
              {fmtSec(draftSp.periodSec)}
            </span>
          </div>
        </label>
      </div>
      <div className={styles.edRow}>
        <div className={styles.edField}>
          <span className={styles.edLabel}>Урон</span>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {DAMAGE_LEVELS.map((k) => (
              <SpChip
                key={k}
                active={draftSp.damageLevel === k}
                onClick={() => setDraftSp((d) => ({ ...d, damageLevel: k }))}
              >
                {damageLevelLabel(k)}
              </SpChip>
            ))}
          </div>
        </div>
        <div className={styles.edField}>
          <span className={styles.edLabel}>Броня</span>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {DAMAGE_LEVELS.map((k) => (
              <SpChip
                key={k}
                active={draftSp.armorLevel === k}
                onClick={() => setDraftSp((d) => ({ ...d, armorLevel: k }))}
              >
                {damageLevelLabel(k)}
              </SpChip>
            ))}
          </div>
        </div>
      </div>
      <div className={styles.edActions}>
        <Button
          type="submit"
          size="sm"
          className="h-8 bg-[var(--sim-accent)] text-xs text-black hover:bg-[var(--sim-accent-hover)]"
          disabled={busy}
        >
          {busy ? 'Сохраняем…' : 'Сохранить'}
        </Button>
        {note ? <span className={styles.edOk}>{note}</span> : null}
      </div>
      {fail ? (
        <div className={`${styles.errBox} mt-3`}>
          <p className={styles.errTitle}>{fail.title}</p>
          {fail.details ? <pre className={styles.errDetails}>{fail.details}</pre> : null}
        </div>
      ) : null}
    </form>
  );
}

/* ——— страница профиля ——— */

export default function PlayerProfile({
  card,
  mine,
  myProfile,
  onSaved,
  onClose,
}: {
  card: ProfileCard;
  mine: boolean;
  myProfile: ProfileMe | null;
  onSaved: (fresh: PublicProfile) => void;
  onClose: () => void;
}) {
  // Компонент живёт только на клиенте: в пререндере каталога focused=null,
  // карточка приходит после fetch — поэтому «сейчас» можно взять один раз
  // при появлении карточки; статусы/«сколько назад» не дребезжат между
  // перерисовками и не расходятся с пререндером.
  const [now] = useState(() => Date.now());

  const seen = card.lastSeenAt ?? 0;
  const status = statusOf(seen, now);
  const activity = activityOf(seen, now);
  const home = homeRoomTitle(card.lastSeenRoom);
  const days = daysSince(card.createdAt, now);
  const char = avatarOf(card);
  const name = card.displayName || 'Безымянный кот';
  const shortId = card.accountId ? `№${card.accountId.slice(0, 8)}` : '№—';

  const birth = ruDate(card.createdAt);
  const birthNote =
    card.createdAt > 0 ? `дата регистрации аккаунта — ${ruDate(card.createdAt)}` : 'дата регистрации неизвестна';
  const seenAgo = seen > 0 ? ruAgo(seen, now) : UNKNOWN;

  // честная строка-резюме: только факты карточки в читаемом виде
  const regPart = card.createdAt > 0 ? `регистрация: ${ruAgo(card.createdAt, now)}` : 'регистрация: неизвестно';
  const summary = `${regPart} · активность: ${ACTIVITY_TEXT[activity]} · ${STATUS_TEXT[status].toLowerCase()}`;

  const facts = achFacts(card, now);
  const moonsLine = moonsText(card.createdAt, now);

  const infoRows: { icon: InfoIcon; label: string; value: string; title?: string }[] = [
    { icon: 'id', label: 'ID профиля', value: shortId, title: card.accountId || undefined },
    { icon: 'calendar', label: 'Дата рождения', value: birth, title: birthNote },
    { icon: 'moon', label: 'Возраст (в лунах)', value: moonsLine },
    { icon: 'activity', label: 'Последний вход', value: seenAgo, title: seen > 0 ? ruDate(seen) : 'нет записей о входе' },
    { icon: 'home', label: 'Дом', value: home || UNKNOWN, title: 'комната последней записи кота на поле' },
    {
      icon: 'paw',
      label: 'Персонажи',
      value: card.characters.length ? card.characters.map((c) => c.name).join(', ') : UNKNOWN,
    },
    { icon: 'feather', label: 'О себе', value: card.bio || 'Пока ничего не рассказала о себе.' },
  ];

  const stats: [string, string][] = [
    ['Дней в стае', days !== null ? `${days} ${plural(days, 'день', 'дня', 'дней')}` : UNKNOWN],
    ['Персонажей в аккаунте', String(card.characters.length)],
    ['Активный персонаж', char ? `${char.name} · размер ${char.size}` : UNKNOWN],
  ];

  const badges: { text: string; gold: boolean }[] = [];
  if (activity !== 'unknown') badges.push({ text: `${ACTIVITY_TEXT[activity]} активность`, gold: activity === 'ideal' });
  if (home) badges.push({ text: `дом: ${home}`, gold: false });
  if (card.createdAt > 0) badges.push({ text: `${moonsLine} с нами`, gold: false });

  return (
    <div className={styles.sky}>
      <Starscape />
      <div className={styles.page}>
        <BrandRow />
        <main className={styles.panel} style={{ padding: 'clamp(18px, 3.4vw, 30px) clamp(16px, 3.2vw, 30px)' }}>
          <div className={styles.head}>
            <Portrait card={card} name={name} />
            <div className={styles.headMain}>
              <h1 className={styles.catNameBig}>
                {name}{' '}
                <span className={styles.statusInline} style={{ color: STATUS_COLOR[status] }}>
                  — [ {STATUS_TEXT[status]} ]
                </span>
              </h1>
              <p className={styles.sub}>{summary}</p>
              <ul className={styles.info}>
                {infoRows.map((row) => (
                  <li key={row.label}>
                    <span className={styles.iIco}>{INFO_ICONS[row.icon]}</span>
                    <span className={styles.iLabel} title={row.title}>
                      {row.label}
                    </span>
                    <span className={styles.iValue} title={row.title}>
                      {row.value}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className={styles.badges}>
            {badges.length ? (
              badges.map((b) => (
                <span key={b.text} className={b.gold ? `${styles.badge} ${styles.badgeGold}` : styles.badge}>
                  {spark}
                  {b.text}
                </span>
              ))
            ) : (
              <span className={styles.badge}>{spark} данных о карточке пока немного</span>
            )}
          </div>

          <section className={styles.section} aria-labelledby="ach-title">
            <h2 className={styles.secTitle} id="ach-title">
              Достижения
            </h2>
            <div className={styles.ach}>
              {facts.map((f) => (
                <div
                  key={f.title}
                  className={f.earned ? styles.achItem : `${styles.achItem} ${styles.achLocked}`}
                  title={f.earned ? `получено: ${f.hint}` : `не получено: ${f.hint}`}
                >
                  <div className={styles.achTile} style={{ color: f.earned ? f.color : '#a4abc4' }}>
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      {ACH_ICONS[f.icon]}
                    </svg>
                  </div>
                  <div className={styles.achCap}>{f.title}</div>
                </div>
              ))}
            </div>
          </section>

          <section className={styles.section} aria-labelledby="stats-title">
            <h2 className={styles.secTitle} id="stats-title">
              Статистика
            </h2>
            <table className={styles.stats}>
              <tbody>
                {stats.map(([k, v]) => (
                  <tr key={k}>
                    <td className={styles.statsK}>{k}</td>
                    <td className={styles.statsV}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className={styles.sub} style={{ marginTop: 10, fontSize: 12 }}>
              Боевые счётчики («убито мышей» и т.п.) сервер пока не собирает — строки появятся, когда появятся реальные
              данные.
            </p>
          </section>

          <footer className={styles.panelFoot}>
            <button type="button" className={styles.backLink} onClick={onClose}>
              ← Вернуться в каталог
            </button>
            <span className={styles.footNum} title={card.accountId}>
              Профиль {shortId}
            </span>
          </footer>
        </main>
        {mine && myProfile ? (
          <div style={{ marginTop: 20 }}>
            <OwnProfileEditor profile={myProfile} onSaved={onSaved} />
          </div>
        ) : null}
        <p className={styles.footNote}>
          <a className={styles.backLink} href="/">
            ← Главное меню
          </a>
        </p>
      </div>
    </div>
  );
}

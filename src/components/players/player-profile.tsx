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
import { httpMyProfile, httpPatchProfile, type ProfileCard, type ProfileMe, type ProfilePatch, type ProfileSp, type PublicProfile } from '@/lib/net/http-profiles';
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
  moonsText,
  plural,
  ruAgo,
  ruDate,
  statusOf,
  type StatusTone,
} from './players-format';
import styles from './players-elyria.module.css';
import {
  ACH_ICONS,
  Portrait,
  SKIN_GROUPS,
  SpChip,
  achFacts,
  activeCharOf,
  humanEditError,
  moonPath,
} from './player-profile-ui';

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



const spark = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 3l2.1 6.9L21 12l-6.9 2.1L12 21l-2.1-6.9L3 12l6.9-2.1z" />
  </svg>
);




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









function OwnProfileEditor({ profile, onSaved }: { profile: ProfileMe; onSaved: (fresh: PublicProfile) => void }) {
  const [draftName, setDraftName] = useState(profile.displayName);
  const [draftBio, setDraftBio] = useState(profile.bio);
  const [draftAvatar, setDraftAvatar] = useState<string>(profile.avatarCharacterId || '');
  const [draftSp, setDraftSp] = useState<SpDraft>(() => spDefaults(profile.sp));
  const originChar = activeCharOf(profile);
  const originSprite = originChar?.sprite || '';
  const originScale =
    originChar && Number.isFinite(originChar.size)
      ? Math.min(100, Math.max(60, Math.round(originChar.size)))
      : 100;
  const [draftSprite, setDraftSprite] = useState(originSprite);
  const [draftScale, setDraftScale] = useState(originScale);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [fail, setFail] = useState<{ title: string; details?: string } | null>(null);

  useEffect(() => {
    setDraftName(profile.displayName);
    setDraftBio(profile.bio);
    setDraftAvatar(profile.avatarCharacterId || '');
    setDraftSp(spDefaults(profile.sp));
    const ch = activeCharOf(profile);
    setDraftSprite(ch?.sprite || '');
    setDraftScale(
      ch && Number.isFinite(ch.size) ? Math.min(100, Math.max(60, Math.round(ch.size))) : 100,
    );
  }, [profile]);

  /** СП едут в PATCH только если игрок их реально тронул: неточно равные
   *  наборы не перезаписывают профиль (и не мешают правке имени/био). */
  const spOrigin = spDefaults(profile.sp);
  const spChanged =
    draftSp.periodSec !== spOrigin.periodSec ||
    draftSp.damageLevel !== spOrigin.damageLevel ||
    draftSp.armorLevel !== spOrigin.armorLevel;

  /** Внешность (скин/рост) — та же дисциплина: менять — только тронутое,
   *  пустой скин не сохраняем (сервер требует валидный id). */
  const appearanceChanged = draftSprite !== originSprite || draftScale !== originScale;

  const save = async () => {
    setFail(null);
    const name = draftName.replace(/\s+/g, ' ').trim();
    if (!name) {
      setFail({ title: 'Имя не может быть пустым (1–24 символа).' });
      return;
    }
    setBusy(true);
    // Статический импорт (дин-импорт ломался: turbopack-карта → 404 чанк,
    // см. owner report 2026-11-08); маршруты модуля — env-DCE канон P3.
    const patch: ProfilePatch = {
      displayName: name,
      bio: draftBio.trim(),
      avatarCharacterId: draftAvatar || null,
    };
    if (spChanged) patch.sp = { ...draftSp };
    // скин и рост персонажа — плоские поля активной записи; сервер валидирует
    // id по каталогу и зажимает рост в 60–100
    if (appearanceChanged && draftSprite) patch.sprite = draftSprite;
    if (appearanceChanged) patch.scale = draftScale;
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
    // id="settings" — якорь ссылок «Настройки» в шапке сайта: /players/?id=…#settings
    <form
      id="settings"
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

      {/* Внешность: скин и рост активного персонажа — выбор хранится в аккаунте
          и применяется на поле сам; плитки те же группы, что на карусели входа. */}
      <h3 className={`${styles.edTitle} mt-4`}>Внешность</h3>
      <div className={styles.edField}>
        <span className={styles.edLabel}>Скин{originSprite ? '' : ' (не выбран — на поле будет обычный)'}</span>
        <div className="mt-1.5 max-h-44 overflow-y-auto rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-inset-strong)] p-2">
          {SKIN_GROUPS.map((g) => (
            <div key={g.id} className="mb-2 last:mb-0">
              <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--sim-text-soft)]">
                {g.name}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {g.sprites.map((sp) => {
                  const active = draftSprite === sp.id;
                  return (
                    <button
                      key={sp.id}
                      type="button"
                      title={sp.name}
                      aria-pressed={active}
                      onClick={() => setDraftSprite(sp.id)}
                      className={`flex w-16 flex-col items-center rounded-lg border px-1 pb-1 pt-1 transition-colors ${
                        active
                          ? 'border-[var(--sim-accent-hover)] bg-[var(--sim-accent-tint)]'
                          : 'border-transparent hover:border-[var(--sim-line-hover)]'
                      }`}
                    >
                      <img src={sp.src} alt={sp.name} className="h-10 w-auto object-contain" draggable={false} />
                      <span className="w-full truncate text-center text-[10px] font-medium text-[var(--sim-text-soft)]">
                        {sp.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <label className={styles.edField}>
        <span className={styles.edLabel}>Рост ({draftScale}%)</span>
        <div className="mt-1.5 flex items-center gap-2">
          <Slider
            className="flex-1"
            value={[draftScale]}
            min={60}
            max={100}
            step={1}
            aria-label="Рост персонажа"
            onValueChange={(vals) => {
              const v = vals[0];
              if (typeof v === 'number') setDraftScale(Math.round(v));
            }}
          />
        </div>
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

'use client';

/**
 * Страница-профиль игрока (P5-редизайн /players?id=): ночная панель-карточка
 * по образу лучших профилей жанра — портрет-арена, имя и статус, строки
 * данных, капсулы-резюме, грид достижений и таблица статистики.
 *
 * ЧЕСТНОСТЬ ДАННЫХ: каждый вывод лежит на полях реального DTO карточки
 * (server/profiles.js): createdAt → дата регистрации/возраст, lastSeenAt →
 * статус/активность/«последний вход» (пороги в players-format.ts),
 * characters → аватар/персонажи/размер, birthday → день и месяц
 * (год только на своей карточке). Комнату последней записи не показываем.
 * Чего в аккаунтах нет — того на странице нет: боевые счётчики («убито
 * мышей» и пр.) сервер не собирает, поэтому достижения и статистика —
 * только вычислимые факты карточки, без выдуманных чисел.
 * Свою карточку можно править инлайн (PATCH /profiles/me, P4) — поток тот же;
 * там же «Игровые параметры» (скрытые настройки: скорость стрелы, урон,
 * броня) — только владелец, сервер хранит их в записи профиля.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Lilita_One } from 'next/font/google';

import { Button } from '@/components/ui/button';
import { Dropdown } from '@/components/ui';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { SiteHeader } from '@/components/site/site-header';
import { httpDeleteAccount, httpMyProfile, httpPatchProfile, type ProfileCard, type ProfileMe, type ProfilePatch, type ProfileSp, type PublicProfile } from '@/lib/net/http-profiles';
import { httpLogout } from '@/lib/net/http-auth';
import { httpDeleteAvatar, httpUploadAvatar, humanAvatarError } from '@/lib/net/http-avatars';
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
  moonsText,
  plural,
  ruAgo,
  ruBirthday,
  ruDate,
  statusOf,
  type StatusTone,
} from './players-format';
import styles from './players-elyria.module.css';
import {
  ACH_ICONS,
  AvatarField,
  MineSpritesSection,
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

type InfoIcon = 'id' | 'calendar' | 'moon' | 'activity' | 'paw' | 'feather';

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









function OwnProfileEditor({
  profile,
  onSaved,
  mineHighlight = null,
}: {
  profile: ProfileMe;
  onSaved: (fresh: PublicProfile) => void;
  /** #84 ч.2: id свежего окраса из редактора — подсветить в «Свой окрас». */
  mineHighlight?: string | null;
}) {
  const [draftName, setDraftName] = useState(profile.displayName);
  const [draftBio, setDraftBio] = useState(profile.bio);
  /** День рождения черновика: '' — очищено (в PATCH уедет null). */
  const [draftBirthday, setDraftBirthday] = useState(profile.birthday || '');
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
  // Своя картинка-аватар: DTO-URL профиля; мутацию подтверждают ответ
  // сервера и рефреш (onSaved обновляет myProfile-кэш каталога).
  const [avatarUrl, setAvatarUrl] = useState(profile.avatar || '');
  const [avatarBusy, setAvatarBusy] = useState(false);
  /** Вооружённое удаление картинки: второй клик подтверждает (5 сек). */
  const [armedAvatar, setArmedAvatar] = useState(false);
  const armAvatarTimer = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [fail, setFail] = useState<{ title: string; details?: string } | null>(null);
  const [deletePass, setDeletePass] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteFail, setDeleteFail] = useState<string | null>(null);

  useEffect(() => {
    setDraftName(profile.displayName);
    setDraftBio(profile.bio);
    setDraftBirthday(profile.birthday || '');
    setAvatarUrl(profile.avatar || '');
    setDraftAvatar(profile.avatarCharacterId || '');
    setDraftSp(spDefaults(profile.sp));
    const ch = activeCharOf(profile);
    setDraftSprite(ch?.sprite || '');
    setDraftScale(
      ch && Number.isFinite(ch.size) ? Math.min(100, Math.max(60, Math.round(ch.size))) : 100,
    );
  }, [profile]);

  // вооружённое «Убрать картинку» гаснет само — таймер чистим на выходе
  useEffect(() => () => {
    if (armAvatarTimer.current) window.clearTimeout(armAvatarTimer.current);
  }, []);

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

  /** День рождения: едет в PATCH только тронутое; '' → null (сброс). */
  const originBirthday = profile.birthday || null;
  const birthdayChanged = (draftBirthday || null) !== originBirthday;

  /** Верхняя граница календаря — сегодня локали (нижняя — 1900-01-01). */
  const todayDate = new Date();
  const birthdayMax = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, '0')}-${String(todayDate.getDate()).padStart(2, '0')}`;

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
    // день рождения — строка или null, только при отличии от исходного
    if (birthdayChanged) patch.birthday = draftBirthday || null;
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

  /** Рефреш профиля после аватара — канон PATCH-успехов соседей:
   *  свежий /profiles/me + onSaved. */
  const refreshMineAfterAvatar = async () => {
    const fresh = await httpMyProfile();
    if (fresh.ok && fresh.profile) onSaved(fresh.profile);
  };

  /** Загрузка своей картинки: размер проверяем локально, остальное —
   *  за сервером; по успеху свежий URL в превью и рефреш карточки. */
  const uploadOwnAvatar = async (file: File) => {
    if (avatarBusy) return;
    if (file.size > 2 * 1024 * 1024) {
      setFail({ title: 'Файл больше 2 МБ не принимается — уменьшите картинку.' });
      return;
    }
    setFail(null);
    setAvatarBusy(true);
    const res = await httpUploadAvatar(file);
    setAvatarBusy(false);
    if (!res.ok) {
      setFail({ title: humanAvatarError(res.reason, 'Загрузить картинку не удалось.'), details: res.message || undefined });
      return;
    }
    setAvatarUrl(res.avatar || '');
    setArmedAvatar(false);
    setNote('Картинка загружена.');
    window.setTimeout(() => setNote(null), 2500);
    await refreshMineAfterAvatar();
  };

  /** Удаление своей картинки — уже подтверждённый второй клик кнопки. */
  const removeOwnAvatar = async () => {
    setAvatarBusy(true);
    const res = await httpDeleteAvatar();
    setAvatarBusy(false);
    if (!res.ok) {
      setFail({ title: humanAvatarError(res.reason, 'Убрать картинку не удалось.'), details: res.message || undefined });
      return;
    }
    setAvatarUrl('');
    setArmedAvatar(false);
    setNote('Картинка убрана.');
    window.setTimeout(() => setNote(null), 2500);
    await refreshMineAfterAvatar();
  };

  /** Первый клик «Убрать картинку» — вооружение на 5 секунд, второй — ход. */
  const armAvatarRemoval = () => {
    setArmedAvatar(true);
    if (armAvatarTimer.current) window.clearTimeout(armAvatarTimer.current);
    armAvatarTimer.current = window.setTimeout(() => setArmedAvatar(false), 5000);
  };

  const removeAccount = async () => {
    if (!deletePass) {
      setDeleteFail('Введите текущий пароль.');
      return;
    }
    setDeleteBusy(true);
    setDeleteFail(null);
    const res = await httpDeleteAccount(deletePass);
    if (!res.ok) {
      setDeleteBusy(false);
      setDeleteFail(res.message);
      return;
    }
    await httpLogout();
    window.location.assign('/');
  };

  return (
    <>
    {/* id="settings" — якорь /players/?id&mine=#settings: кнопка в карточке и мост Paint */}
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
          <Dropdown
            className="mt-1"
            value={draftAvatar}
            onChange={(v) => setDraftAvatar(v)}
            options={[
              { value: '', label: 'Без аватара' },
              ...profile.characters.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
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
      <label className={styles.edField}>
        <span className={styles.edLabel}>День рождения</span>
        <input
          type="date"
          className="mt-1 h-8 w-full rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] px-2 text-sm text-[var(--sim-text)]"
          min="1900-01-01"
          max={birthdayMax}
          value={draftBirthday}
          onChange={(e) => setDraftBirthday(e.target.value)}
        />
        <span className="mt-1 block text-[10px] text-[var(--sim-text-faint)]">
          виден на карточке; пусто — показываем дату регистрации
        </span>
      </label>

      {/* Своя картинка-аватар: сетевым клиентом владеет этот модуль,
          превью обновляется сразу, портрет карточки — рефрешем профиля. */}
      <AvatarField
        avatarUrl={avatarUrl}
        busy={avatarBusy}
        armed={armedAvatar}
        onFile={(file) => void uploadOwnAvatar(file)}
        onRemoveClick={() => (armedAvatar ? void removeOwnAvatar() : armAvatarRemoval())}
      />

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
      {/* Свой окрас (#83): личные PNG игрока — выбор как у обычных скинов
          (черновик сохраняется общей кнопкой «Сохранить»), удаление с
          подтверждением — блок сам ходит в /sprites/mine (edField внутри). */}
      <MineSpritesSection
        accountName={profile.displayName || 'игрока'}
        draftSprite={draftSprite}
        wornSprite={originSprite}
        onPick={setDraftSprite}
        mineHighlight={mineHighlight}
      />
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
    <form
      className={`${styles.edBox} ${styles.edDanger}`}
      onSubmit={(ev) => {
        ev.preventDefault();
        void removeAccount();
      }}
    >
      <span className={styles.edLabel}>Удаление аккаунта</span>
      <p className={styles.edWarn}>
        Аккаунт пропадёт из каталога, а войти с прежним паролем будет нельзя.
        Введите текущий пароль и подтвердите кнопкой.
      </p>
      <label className={styles.edField}>
        <span className={styles.edLabel}>Текущий пароль</span>
        <Input
          type="password"
          autoComplete="current-password"
          value={deletePass}
          onChange={(ev) => setDeletePass(ev.target.value)}
          disabled={deleteBusy}
        />
      </label>
      <div className={styles.edActions}>
        <Button type="submit" size="sm" variant="destructive" disabled={deleteBusy || deletePass.length === 0}>
          {deleteBusy ? 'Удаляем…' : 'Удалить аккаунт'}
        </Button>
        {deleteFail ? <span className={styles.edWarn}>{deleteFail}</span> : null}
      </div>
    </form>
    </>
  );
}

/* ——— скелетоны: deep-link-загрузка на месте, без прыжка страницы ——— */

/** Инфостроки: иконки и лейблы статичны (не грузятся) — скелет повторяет
 *  их один в один, полоса стоит только на месте ЗНАЧЕНИЯ. Ширины полос —
 *  порядок настоящего контента; высота 1em = строка текста. */
const SKEL_INFO: { icon: InfoIcon; label: string; width: string }[] = [
  { icon: 'id', label: 'ID профиля', width: 'min(46%, 180px)' },
  { icon: 'calendar', label: 'Дата рождения', width: 'min(40%, 150px)' },
  { icon: 'moon', label: 'Возраст (в лунах)', width: 'min(36%, 120px)' },
  { icon: 'activity', label: 'Последний вход', width: 'min(38%, 130px)' },
  { icon: 'paw', label: 'Персонажи', width: 'min(45%, 170px)' },
  { icon: 'feather', label: 'О себе', width: 'min(70%, 260px)' },
];

/** Лейблы статистики тоже известны заранее — полоса только на значении. */
const SKEL_STATS = ['Дней в стае', 'Персонажей в аккаунте', 'Активный персонаж'];

/** Каркас страницы профиля той же геометрии (deep-link ?id=): шапка/панель/
 *  разметка/заголовки секций — настоящие, контентные места — полосы .skel.
 *  Приход карточки меняет полосы на значения, верстка не перестраивается. */
export function ProfileSkeleton() {
  return (
    <div className={styles.sky} role="status" aria-label="Загружаем профиль">
      <Starscape />
      <SiteHeader />
      <div className={styles.page}>
        <BrandRow />
        <main className={styles.panel} style={{ padding: 'clamp(18px, 3.4vw, 30px) clamp(16px, 3.2vw, 30px)' }}>
          <div className={styles.head}>
            <figure className={styles.avatar}>
              <span className={`${styles.avatarArt} ${styles.skel}`} />
              <figcaption className={styles.avatarCap}>
                <span className={styles.skel} style={{ width: '82%', height: '1em' }} />
              </figcaption>
            </figure>
            <div className={styles.headMain}>
              <h1 className={styles.catNameBig}>
                <span className={styles.skel} style={{ width: 'min(58%, 300px)', height: '1.05em' }} />
              </h1>
              <p className={styles.sub}>
                <span className={styles.skel} style={{ width: 'min(72%, 400px)', height: '1em' }} />
              </p>
              <ul className={styles.info}>
                {SKEL_INFO.map((row) => (
                  <li key={row.label}>
                    <span className={styles.iIco}>{INFO_ICONS[row.icon]}</span>
                    <span className={styles.iLabel}>{row.label}</span>
                    <span className={styles.skel} style={{ width: row.width, height: '1em', alignSelf: 'center' }} />
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className={styles.badges}>
            {[0, 1, 2].map((i) => (
              <span key={i} className={`${styles.skel} ${styles.skelPill}`} style={{ width: 138 - i * 26, height: 25 }} />
            ))}
          </div>

          <section className={styles.section}>
            <h2 className={styles.secTitle}>Достижения</h2>
            <div className={styles.ach}>
              {SKEL_INFO.map((_, i) => (
                <span key={i} className={styles.achItem}>
                  <span className={`${styles.skel} ${styles.skelTile}`} style={{ width: 72, height: 72 }} />
                  <span className={styles.skel} style={{ width: 76, height: 10 }} />
                </span>
              ))}
            </div>
          </section>

          <section className={styles.section}>
            <h2 className={styles.secTitle}>Статистика</h2>
            <table className={styles.stats}>
              <tbody>
                {SKEL_STATS.map((k, i) => (
                  <tr key={k}>
                    <td className={styles.statsK}>{k}</td>
                    <td className={styles.statsV}>
                      <span className={styles.skel} style={{ width: 96 + i * 26, height: '1em' }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <footer className={styles.panelFoot}>
            <span className={styles.skel} style={{ width: 172, height: 14 }} />
            <span className={styles.skel} style={{ width: 92, height: 12, borderRadius: 7 }} />
          </footer>
        </main>
        <p className={styles.footNote}>
          <a className={styles.backLink} href="/">
            ← Главное меню
          </a>
        </p>
      </div>
    </div>
  );
}

/** Каркас блока «Правка своей карточки» на время полёта /profiles/me:
 *  панель .edBox той же природы (заголовок статичен, поля — полосы), чтобы
 *  собственный профиль не «выезжал» вторым этажом после карточки. */
function OwnEditorSkeleton() {
  const field = (w: number) => (
    <label className={styles.edField}>
      <span className={styles.edLabel}>
        <span className={styles.skel} style={{ width: w, height: 10, borderRadius: 5 }} />
      </span>
      <span className={styles.skel} style={{ width: '100%', height: 32, marginTop: 4 }} />
    </label>
  );
  return (
    <div style={{ marginTop: 20 }} role="status" aria-label="Загружаем настройки профиля">
      <form className={styles.edBox}>
        <h3 className={styles.edTitle}>Правка своей карточки</h3>
        <div className={styles.edRow}>
          {field(120)}
          {field(150)}
          {field(110)}
        </div>
        <div className={styles.edRow} style={{ marginTop: 14 }}>
          {field(140)}
          {field(160)}
        </div>
        <span className={styles.skel} style={{ width: 128, height: 34, marginTop: 14, borderRadius: 99 }} />
      </form>
    </div>
  );
}


/* ——— страница профиля ——— */

export default function PlayerProfile({
  card,
  mine,
  myProfile,
  onSaved,
  onClose,
  mineHighlight = null,
}: {
  card: ProfileCard;
  mine: boolean;
  myProfile: ProfileMe | null;
  onSaved: (fresh: PublicProfile) => void;
  onClose: () => void;
  /** #84 ч.2: id свежего окраса из редактора (возврат ?back=profile) —
   *  своя карточка подсвечивает его в блоке «Свой окрас». */
  mineHighlight?: string | null;
}) {
  // Компонент живёт только на клиенте: в пререндере каталога focused=null,
  // карточка приходит после fetch — поэтому «сейчас» можно взять один раз
  // при появлении карточки; статусы/«сколько назад» не дребезжат между
  // перерисовками и не расходятся с пререндером.
  const [now] = useState(() => Date.now());
  /** Подстраница настроек: с карточки её не видно. #settings и возврат из
   *  редактора окрасов (?mine=#settings) открывают её сразу. */
  const [settingsView, setSettingsView] = useState(
    () => typeof window !== 'undefined' && window.location.hash === '#settings',
  );
  useEffect(() => {
    const sync = () => setSettingsView(window.location.hash === '#settings');
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);
  const openSettings = () => {
    const next = `${window.location.pathname}${window.location.search}#settings`;
    window.history.pushState(null, '', next);
    setSettingsView(true);
  };
  const closeSettings = () => {
    const next = `${window.location.pathname}${window.location.search}`;
    window.history.pushState(null, '', next);
    setSettingsView(false);
  };
  const showSettings = mine && settingsView;

  // Своя карточка: myProfile (/profiles/me) после правок свежее deep-link-
  // карточки каталога (его обновляет onSaved), поэтому день рождения и свою
  // картинку своей карточки берём из него — правки и аватар видны сразу.
  const shownCard = mine && myProfile ? { ...card, birthday: myProfile.birthday, avatar: myProfile.avatar } : card;
  const seen = card.lastSeenAt ?? 0;
  const status = statusOf(seen, now);
  const activity = activityOf(seen, now);
  const days = daysSince(card.createdAt, now);
  const char = avatarOf(card);
  const name = card.displayName || 'Безымянный кот';
  const shortId = card.accountId ? `№${card.accountId.slice(0, 8)}` : '№—';

  const birth = ruDate(card.createdAt);
  const birthNote =
    card.createdAt > 0 ? `дата регистрации аккаунта — ${ruDate(card.createdAt)}` : 'дата регистрации неизвестна';
  /** День рождения, если он указан. Чужим — «5 марта» без года даже если
   *  в строке случайно оказалась полная дата. Своя карточка (mine) может
   *  показать год: его прислал /profiles/me, им же правят поле. Пусто →
   *  строка даты регистрации, дату не выдумываем. */
  const ownBirthday = ruBirthday(shownCard.birthday, mine);
  const seenAgo = seen > 0 ? ruAgo(seen, now) : UNKNOWN;

  // честная строка-резюме: только факты карточки в читаемом виде
  const regPart = card.createdAt > 0 ? `регистрация: ${ruAgo(card.createdAt, now)}` : 'регистрация: неизвестно';
  const summary = `${regPart} · активность: ${ACTIVITY_TEXT[activity]} · ${STATUS_TEXT[status].toLowerCase()}`;

  const facts = achFacts(card, now);
  const moonsLine = moonsText(card.createdAt, now);

  const infoRows: { icon: InfoIcon; label: string; value: string; title?: string }[] = [
    { icon: 'id', label: 'ID профиля', value: shortId, title: card.accountId || undefined },
    ownBirthday
      ? { icon: 'calendar', label: 'День рождения', value: ownBirthday, title: 'день рождения, указанный самим игроком' }
      : { icon: 'calendar', label: 'Дата рождения', value: birth, title: birthNote },
    { icon: 'moon', label: 'Возраст (в лунах)', value: moonsLine },
    { icon: 'activity', label: 'Последний вход', value: seenAgo, title: seen > 0 ? ruDate(seen) : 'нет записей о входе' },
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
  if (card.createdAt > 0) badges.push({ text: `${moonsLine} с нами`, gold: false });

  return (
    <div className={styles.sky}>
      <Starscape />
      {/* W2 (2026-11-08): общая шапка сайта и над открытым профилем —
          из карточки/настроек можно уйти в любой раздел и выйти из аккаунта;
          паттерн каталога: sticky-полоса лежит на звёздном небе .sky. */}
      <SiteHeader />
      <div className={styles.page}>
        <BrandRow />
        <main className={styles.panel} style={{ padding: 'clamp(18px, 3.4vw, 30px) clamp(16px, 3.2vw, 30px)' }}>
          {showSettings ? (
            <div className={styles.settingsView}>
              <div className={styles.settingsHead}>
                <button type="button" className={styles.backLink} onClick={closeSettings}>
                  ← К карточке
                </button>
                <h1 className={styles.catNameBig}>Настройки</h1>
              </div>
              <p className={styles.sub}>
                {name}: внешность, день рождения, аватар и игровые параметры. На карточке этого блока нет.
              </p>
              {myProfile ? (
                <OwnProfileEditor profile={myProfile} onSaved={onSaved} mineHighlight={mineHighlight} />
              ) : (
                <OwnEditorSkeleton />
              )}
            </div>
          ) : (
          <>
          <div className={styles.head}>
            <Portrait card={shownCard} name={name} />
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
          </section>

          <footer className={styles.panelFoot}>
            <button type="button" className={styles.backLink} onClick={onClose}>
              ← Вернуться в каталог
            </button>
            {mine ? (
              <button type="button" className={styles.settingsBtn} onClick={openSettings}>
                Настройки
              </button>
            ) : null}
            <span className={styles.footNum} title={card.accountId}>
              Профиль {shortId}
            </span>
          </footer>
          </>
          )}
        </main>
        <p className={styles.footNote}>
          <a className={styles.backLink} href="/">
            ← Главное меню
          </a>
        </p>
      </div>
    </div>
  );
}

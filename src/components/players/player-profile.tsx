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
import { httpDeleteBanner, httpUploadBanner, humanBannerError } from '@/lib/net/http-banners';
import {
  DAMAGE_LEVELS,
  DEFAULT_SETTINGS,
  SP_PROFILE_PERIOD_MAX,
  SP_PROFILE_PERIOD_MIN,
  damageLevelLabel,
  persistProfileSp,
} from '@/lib/sim/settings';
import styles from './players-elyria.module.css';
import {
  AvatarField,
  MineSpritesSection,
  SKIN_GROUPS,
  SpChip,
  activeCharOf,
  humanEditError,
  moonPath,
} from './player-profile-ui';
import { ProfileCardView } from './profile-card-view';

/** Латинский шрифт бренда один на обе страницы (Lilita One, только latin:
 *  русские заголовки — system-ui 600); инстанс переиспользуется каталогом. */
export const displayFont = Lilita_One({ weight: '400', subsets: ['latin'], display: 'swap' });

const NAME_MAX = 24;
const BIO_MAX = 280;

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









export function OwnProfileEditor({
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
  const [bannerUrl, setBannerUrl] = useState(profile.banner || '');
  const [bannerBusy, setBannerBusy] = useState(false);
  const [armedBanner, setArmedBanner] = useState(false);
  const armBannerTimer = useRef<number | null>(null);
  const bannerFileRef = useRef<HTMLInputElement | null>(null);
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
    setBannerUrl(profile.banner || '');
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
    if (armBannerTimer.current) window.clearTimeout(armBannerTimer.current);
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

  const refreshMineAfterBanner = async () => {
    const fresh = await httpMyProfile();
    if (fresh.ok && fresh.profile) onSaved(fresh.profile);
  };

  const uploadOwnBanner = async (file: File) => {
    if (bannerBusy) return;
    if (file.size > 2 * 1024 * 1024) {
      setFail({ title: 'Файл больше 2 МБ не принимается — уменьшите картинку.' });
      return;
    }
    setFail(null);
    setBannerBusy(true);
    const res = await httpUploadBanner(file);
    setBannerBusy(false);
    if (!res.ok) {
      setFail({ title: humanBannerError(res.reason, 'Загрузить фон не удалось.'), details: res.message || undefined });
      return;
    }
    setBannerUrl(res.banner || '');
    setArmedBanner(false);
    setNote('Фон загружен.');
    window.setTimeout(() => setNote(null), 2500);
    await refreshMineAfterBanner();
  };

  const removeOwnBanner = async () => {
    setBannerBusy(true);
    const res = await httpDeleteBanner();
    setBannerBusy(false);
    if (!res.ok) {
      setFail({ title: humanBannerError(res.reason, 'Убрать фон не удалось.'), details: res.message || undefined });
      return;
    }
    setBannerUrl('');
    setArmedBanner(false);
    setNote('Фон убран.');
    window.setTimeout(() => setNote(null), 2500);
    await refreshMineAfterBanner();
  };

  const armBannerRemoval = () => {
    setArmedBanner(true);
    if (armBannerTimer.current) window.clearTimeout(armBannerTimer.current);
    armBannerTimer.current = window.setTimeout(() => setArmedBanner(false), 5000);
  };

  /** «Надеть» — сразу в профиль, без отдельного «Сохранить»: иначе игрок
   *  уходит в комнату с черновиком, а кот остаётся в прежнем окрасе. */
  const wearSprite = async (id: string) => {
    setDraftSprite(id);
    setFail(null);
    const res = await httpPatchProfile({ sprite: id });
    if (!res.ok) {
      setFail({ title: humanEditError(res.reason), details: res.details || undefined });
      return;
    }
    const fresh = await httpMyProfile();
    if (fresh.ok && fresh.profile) {
      onSaved(fresh.profile);
      setNote('Окрас надет.');
      window.setTimeout(() => setNote(null), 2500);
      return;
    }
    setFail({ title: 'Окрас сохранился, но свежий профиль не прочитался — обновите страницу.' });
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

      <div className={styles.edField}>
        <span className={styles.edLabel}>Фон профиля</span>
        <div className="mt-1.5 flex flex-wrap items-center gap-2.5 rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-inset-strong)] p-2">
          {bannerUrl ? (
            <img
              src={bannerUrl}
              alt="Фон профиля"
              className="h-14 w-36 shrink-0 rounded-md border border-[var(--sim-line)] bg-black/20 object-cover"
              draggable={false}
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <p className="text-[10px] text-[var(--sim-text-faint)]">
              Горизонтальная картинка (PNG/JPEG/GIF, до 1200×400, до 2 МБ). Без файла — звёздный градиент.
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <input
                ref={bannerFileRef}
                type="file"
                accept="image/png,image/jpeg,image/gif"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files && e.target.files[0] ? e.target.files[0] : null;
                  e.target.value = '';
                  if (file) void uploadOwnBanner(file);
                }}
              />
              <Button
                type="button"
                size="sm"
                className="h-8 bg-[var(--sim-accent)] text-xs text-black hover:bg-[var(--sim-accent-hover)]"
                disabled={bannerBusy}
                onClick={() => bannerFileRef.current?.click()}
              >
                {bannerBusy ? 'Загружаем…' : 'Загрузить фон'}
              </Button>
              {bannerUrl ? (
                <button
                  type="button"
                  disabled={bannerBusy}
                  onClick={() => (armedBanner ? void removeOwnBanner() : armBannerRemoval())}
                  className={`rounded border px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-50 ${
                    armedBanner
                      ? 'border-red-500 bg-red-950 font-bold text-red-300'
                      : 'border-[var(--sim-line)] text-[var(--sim-text-soft)] hover:border-[var(--sim-line-hover)]'
                  }`}
                  title={armedBanner ? 'Ещё раз — и фона не будет' : 'Убрать фон'}
                >
                  {armedBanner ? 'Точно убрать?' : 'Убрать фон'}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

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
        onWear={wearSprite}
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

/** Каркас редизайна профиля (баннер + герой + вкладки) — полосы на местах
 *  значений, чтобы deep-link ?id= не дёргал верстку при приходе карточки. */
export function ProfileSkeleton() {
  return (
    <div className={styles.sky} role="status" aria-label="Загружаем профиль">
      <Starscape />
      <SiteHeader />
      <div className={styles.page}>
        <BrandRow />
        <main className={`${styles.panel} ${styles.profileCard}`} style={{ padding: 0 }}>
          <div className={`${styles.profileBanner} ${styles.profileBannerStar}`} />
          <div className={styles.profileHero}>
            <span className={`${styles.profileFaceWrap} ${styles.skel}`} />
            <div className={styles.profileHeroMain}>
              <h1 className={styles.profileName}>
                <span className={styles.skel} style={{ width: 'min(58%, 260px)', height: '1.05em' }} />
              </h1>
              <div className={styles.profilePills}>
                <span className={`${styles.skel} ${styles.skelPill}`} style={{ width: 120, height: 24 }} />
                <span className={`${styles.skel} ${styles.skelPill}`} style={{ width: 88, height: 24 }} />
              </div>
            </div>
          </div>
          <div className={styles.profileTabs} aria-hidden>
            <span className={styles.profileTab}>Профиль</span>
            <span className={styles.profileTab}>Настройки</span>
          </div>
          <div className={styles.profileBody}>
            <div className={styles.profileGrid}>
              <figure className={styles.avatar}>
                <span className={`${styles.avatarArt} ${styles.skel}`} />
              </figure>
              <div className={styles.profileAside}>
                <h2 className={styles.secTitle}>Статистика</h2>
                <span className={styles.skel} style={{ width: '70%', height: 14 }} />
                <h2 className={styles.secTitle} style={{ marginTop: 18 }}>
                  О себе
                </h2>
                <span className={styles.skel} style={{ width: '92%', height: 14 }} />
              </div>
            </div>
          </div>
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
  onOpenFriend,
  onFriendsChanged,
}: {
  card: ProfileCard;
  mine: boolean;
  myProfile: ProfileMe | null;
  onSaved: (fresh: PublicProfile) => void;
  onClose: () => void;
  /** #84 ч.2: id свежего окраса из редактора (возврат ?back=profile) —
   *  своя карточка подсвечивает его в блоке «Свой окрас». */
  mineHighlight?: string | null;
  onOpenFriend?: (accountId: string) => void;
  onFriendsChanged?: () => void;
}) {
  const [now] = useState(() => Date.now());

  // Своя карточка: myProfile после правок свежее deep-link-карточки каталога.
  const shownCard: ProfileCard =
    mine && myProfile
      ? {
          ...card,
          ...myProfile,
          accountId: card.accountId,
          friends: myProfile.friends ?? card.friends,
          friendRelation: myProfile.friendRelation ?? card.friendRelation ?? 'self',
          friendCount: myProfile.friendCount ?? card.friendCount,
        }
      : card;

  return (
    <div className={styles.sky}>
      <Starscape />
      <SiteHeader />
      <div className={styles.page}>
        <BrandRow />
        <ProfileCardView
          card={card}
          mine={mine}
          shown={shownCard}
          now={now}
          onClose={onClose}
          onOpenFriend={onOpenFriend}
          onFriendsChanged={onFriendsChanged}
          settingsSlot={
            mine ? (
              myProfile ? (
                <OwnProfileEditor profile={myProfile} onSaved={onSaved} mineHighlight={mineHighlight} />
              ) : (
                <OwnEditorSkeleton />
              )
            ) : null
          }
        />
        <p className={styles.footNote}>
          <a className={styles.backLink} href="/">
            ← Главное меню
          </a>
        </p>
      </div>
    </div>
  );
}

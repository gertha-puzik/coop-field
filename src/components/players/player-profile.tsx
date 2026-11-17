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
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { SiteHeader } from '@/components/site/site-header';
import { httpDeleteAccount, httpMyProfile, httpPatchProfile, type ProfileCard, type ProfileMe, type ProfilePatch, type ProfileSp, type ProfileSocials, type PublicProfile } from '@/lib/net/http-profiles';
import { httpLogout } from '@/lib/net/http-auth';
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
  SpChip,
  activeCharOf,
  humanEditError,
} from './player-profile-ui';
import { ProfileSocialFields } from './profile-social-fields';
import { ProfileAppearance } from './profile-appearance';
import { Icon } from './profile-icons';
import settingsStyles from './profile-settings.module.css';
import { ProfileCardView, ProfileCardSkeleton } from './profile-card-view';

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
  const [birthday,setBirthday] = useState(profile.birthday || '');
  const [socials,setSocials] = useState<ProfileSocials>(profile.socials || {});
  const [settingsTab, setSettingsTab] = useState<'info' | 'appearance' | 'game' | 'delete'>(mineHighlight ? 'appearance' : 'info');
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
  const [deletePass, setDeletePass] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteFail, setDeleteFail] = useState<string | null>(null);

  useEffect(() => { if (mineHighlight) setSettingsTab('appearance'); }, [mineHighlight]);

  useEffect(() => {
    setDraftName(profile.displayName);
    setDraftBio(profile.bio);
    setBirthday(profile.birthday || '');
    setSocials(profile.socials || {});
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
      socials,
      ...(birthday !== (profile.birthday || '') ? {birthday: birthday || null} : {}),
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
    <div className={settingsStyles.subtabs} role="tablist" aria-label="Мои настройки">
      {([{ id: 'info', name: 'Основная информация', icon: 'users' }, { id: 'appearance', name: 'Внешность', icon: 'brush' }, { id: 'game', name: 'Игровые параметры', icon: 'gear' }, { id: 'delete', name: 'Удаление персонажа', icon: 'trash' }] as const).map((item) =>
        <button key={item.id} type="button" role="tab" id={`settings-tab-${item.id}`} aria-controls={`settings-panel-${item.id}`} aria-selected={settingsTab === item.id} className={settingsStyles.subtab} onClick={() => setSettingsTab(item.id)}><Icon name={item.icon} size={16} />{item.name}</button>)}
    </div>
    {/* id="settings" — якорь /players/?id&mine=#settings: кнопка в карточке и мост Paint */}
    <form
      id="settings"
      hidden={settingsTab === 'delete'}
      className={settingsStyles.settingsForm}
      onSubmit={(ev) => {
        ev.preventDefault();
        void save();
      }}
    >
      <section role="tabpanel" id="settings-panel-info" aria-labelledby="settings-tab-info" hidden={settingsTab !== 'info'}>
      <h3 className={styles.edTitle}>Основная информация</h3>
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
      <ProfileSocialFields birthday={birthday} socials={socials} onBirthday={setBirthday} onSocials={setSocials}/>
      </section>
      <section role="tabpanel" id="settings-panel-appearance" aria-labelledby="settings-tab-appearance" hidden={settingsTab !== 'appearance'}>
        <ProfileAppearance accountName={profile.displayName || 'игрока'} sprite={draftSprite} wornSprite={originSprite} scale={draftScale}
          onPick={setDraftSprite} onScale={setDraftScale} onWear={wearSprite} mineHighlight={mineHighlight} />
      </section>
      <section className={settingsStyles.gamePanel} role="tabpanel" id="settings-panel-game" aria-labelledby="settings-tab-game" hidden={settingsTab !== 'game'}>
      {/* Игровые параметры: приватные настройки владельца — применяются на
          поле в этой игре; меняются отсюда и на входе больше не спрашиваются. */}
      <h3 className={`${styles.edTitle} mt-4`}>Игровые параметры</h3>
      <div className={settingsStyles.gameBlocks}>
        <label className={settingsStyles.parameter}>
          <span className={styles.edLabel}>Скорость стрелы ({fmtSec(SP_PROFILE_PERIOD_MIN)}–{fmtSec(SP_PROFILE_PERIOD_MAX)})</span>
          <div className={settingsStyles.arrowControl}>
            <Slider
              className={settingsStyles.arrowSlider}
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
      <div className={settingsStyles.gameBlocks}>
        <div className={settingsStyles.parameter}>
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
        <div className={settingsStyles.parameter}>
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
      </section>
      <div className={`${styles.edActions} ${settingsTab === 'game' ? settingsStyles.gameActions : ''}`}>
        <Button
          type="submit"
          size="sm"
          className={settingsStyles.action}
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
    <section role="tabpanel" id="settings-panel-delete" aria-labelledby="settings-tab-delete" hidden={settingsTab !== 'delete'}>
    <form
      className={`${settingsStyles.settingsForm} ${styles.edDanger}`}
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
    </section>
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
      <div className={`${styles.page} ${styles.profilePage}`}>
        <ProfileCardSkeleton />
      </div>
    </div>
  );
}

/** Каркас блока «Правка своей карточки» на время полёта /profiles/me:
 *  форма без внутренней рамки (заголовок статичен, поля — полосы), чтобы
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
      <form className={settingsStyles.settingsForm}>
        <h3 className={styles.edTitle}>Мои настройки</h3>
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
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(tick);
  }, []);

  // Своя карточка: myProfile после правок свежее deep-link-карточки каталога.
  const shownCard: ProfileCard =
    mine && myProfile
      ? {
          ...card,
          ...myProfile,
          accountId: card.accountId,
          friends: card.friends ?? myProfile.friends,
          friendRelation: myProfile.friendRelation ?? card.friendRelation ?? 'self',
          friendCount: card.friendCount ?? myProfile.friendCount,
        }
      : card;

  return (
    <div className={styles.sky}>
      <Starscape />
      <SiteHeader />
      <div className={`${styles.page} ${styles.profilePage}`}>
        <ProfileCardView
          card={shownCard}
          mine={mine}
          shown={shownCard}
          now={now}
          onClose={onClose}
          onOpenFriend={onOpenFriend}
          onFriendsChanged={onFriendsChanged}
          onBannerChanged={async () => {
            const fresh = await httpMyProfile();
            if (fresh.ok && fresh.profile) onSaved(fresh.profile);
          }}
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
      </div>
    </div>
  );
}

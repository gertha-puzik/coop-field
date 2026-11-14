'use client';

/**
 * Карточка профиля по макету владелицы 2026-11-14
 * (docs/superpowers/specs/2026-11-14-profile-banner-activity-design.md):
 * шапка-баннер с аватаром (ProfileHero), вкладки «Профиль» / «Настройки
 * профиля», две колонки карточек — слева активный персонаж на лугу, краткая
 * статистика и «о себе», справа друзья сеткой и «Последние действия».
 * Только честные данные DTO: боевых счётчиков и достижений сервер не
 * собирает — их на странице нет.
 *
 * Правка своей карточки остаётся в OwnProfileEditor (player-profile.tsx) —
 * вкладка «Настройки» только монтирует переданный settingsSlot.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import type { ProfileCard, ProfileFriend, PublicProfile } from '@/lib/net/http-profiles';
import {
  httpFriendAccept,
  httpFriendCancel,
  httpFriendDecline,
  httpFriendRemove,
  httpFriendRequest,
  humanFriendError,
  type FriendRelation,
} from '@/lib/net/http-friends';
import { ProfileActivity } from './profile-activity';
import { ProfileFriendsGrid } from './profile-friends-grid';
import { ProfileHero } from './profile-hero';
import { Icon, type IconName } from './profile-icons';
import { avatarOf, daysSince, plural, presenceLabel, playtimeShort, playtimeText, spriteUrl } from './players-format';
import styles from './players-elyria.module.css';
import card2 from './profile-card.module.css';

/** Активный персонаж всегда на лугу — аватар-фото живёт в шапке баннера. */
function MeadowPortrait({ card, name }: { card: ProfileCard | PublicProfile; name: string }) {
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
            draggable={false}
          />
        ) : (
          <span className={styles.portraitPaw} aria-hidden>
            🐾
          </span>
        )}
      </span>
      <figcaption className={styles.avatarCap}>{char?.name || name}</figcaption>
    </figure>
  );
}

function StatTile({
  icon,
  value,
  label,
  title,
  wide = false,
}: {
  icon: IconName;
  value: string;
  label: string;
  title?: string;
  wide?: boolean;
}) {
  return (
    <li className={wide ? `${card2.statTile} ${card2.statWide}` : card2.statTile} title={title}>
      <Icon name={icon} size={22} className={card2.statIcon} />
      <span className={card2.statText}>
        <span className={card2.statValue}>{value}</span>
        <span className={card2.statLabel}>{label}</span>
      </span>
    </li>
  );
}

export type ProfileCardViewProps = {
  card: ProfileCard;
  mine: boolean;
  /** Свежий срез своей карточки (баннер/био после правок). */
  shown: ProfileCard | PublicProfile;
  now?: number;
  settingsSlot?: ReactNode;
  /** Открыть чужой профиль из списка друзей (каталог подменяет focused). */
  onOpenFriend?: (accountId: string) => void;
  onClose: () => void;
  /** После мутации дружбы — обновить карточку снаружи. */
  onFriendsChanged?: () => void;
  /** После смены шапки — освежить свою карточку (GET /profiles/me). */
  onBannerChanged?: () => void | Promise<void>;
};

export function ProfileCardView({
  card,
  mine,
  shown,
  now = Date.now(),
  settingsSlot,
  onOpenFriend,
  onClose,
  onFriendsChanged,
  onBannerChanged,
}: ProfileCardViewProps) {
  const [tab, setTab] = useState<'profile' | 'settings'>(() =>
    typeof window !== 'undefined' && window.location.hash === '#settings' && mine ? 'settings' : 'profile',
  );
  const [relation, setRelation] = useState<FriendRelation>(card.friendRelation || (mine ? 'self' : 'none'));
  const [friends, setFriends] = useState<ProfileFriend[]>(card.friends || []);
  const [friendBusy, setFriendBusy] = useState(false);
  const [friendNote, setFriendNote] = useState<string | null>(null);
  const [activityTick, setActivityTick] = useState(0);

  // Poll каталога может обновить friendRelation/friends на card — синхронизируем.
  useEffect(() => {
    if (card.friendRelation) setRelation(card.friendRelation);
    if (card.friends) setFriends(card.friends);
  }, [card.friendRelation, card.friends]);

  const name = shown.displayName || card.displayName || 'Безымянный кот';
  const pr = presenceLabel(shown.presence ?? card.presence, card.lastSeenAt, now);
  const playMs = shown.playtimeMs ?? card.playtimeMs ?? 0;
  const location = (shown.locationLabel ?? card.locationLabel) || 'неизвестно';
  const rawBio = (shown.bio ?? card.bio) || '';
  const bio = rawBio || 'Пока ничего не рассказано о себе.';
  const banner = shown.banner ?? card.banner;
  const avatarUrl = shown.avatar ?? card.avatar;
  const char = avatarOf(shown);
  const faceUrl = avatarUrl || spriteUrl(char);
  const friendCount = card.friendCount ?? friends.length;
  const days = daysSince(card.createdAt, now);
  const charCount = shown.characters?.length ?? card.characters.length;
  const shortId = card.accountId ? `№${card.accountId.slice(0, 8)}` : '№—';

  const pickTab = (next: 'profile' | 'settings') => {
    if (next === 'settings' && !mine) return;
    setTab(next);
    try {
      const base = `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(null, '', next === 'settings' ? `${base}#settings` : base);
    } catch {
      /* адрес — удобство */
    }
  };

  const runFriend = useCallback(
    async (action: 'request' | 'accept' | 'decline' | 'cancel' | 'remove', id: string) => {
      if (friendBusy || !id) return;
      setFriendBusy(true);
      setFriendNote(null);
      const fn =
        action === 'request'
          ? httpFriendRequest
          : action === 'accept'
            ? httpFriendAccept
            : action === 'decline'
              ? httpFriendDecline
              : action === 'cancel'
                ? httpFriendCancel
                : httpFriendRemove;
      const res = await fn(id);
      setFriendBusy(false);
      if (!res.ok) {
        setFriendNote(humanFriendError(res.reason, 'Не получилось изменить дружбу.'));
        return;
      }
      if (action === 'request') setRelation('outgoing');
      else if (action === 'accept') {
        setRelation('friends');
        setFriends((prev) =>
          prev.some((f) => f.accountId === id)
            ? prev
            : [...prev, { accountId: id, displayName: name, avatar: null, presence: 'resting' }],
        );
      } else if (action === 'decline' || action === 'cancel' || action === 'remove') {
        setRelation(action === 'remove' ? 'none' : 'none');
        if (action === 'remove') setFriends((prev) => prev.filter((f) => f.accountId !== id));
      }
      onFriendsChanged?.();
    },
    [friendBusy, name, onFriendsChanged],
  );

  const openFriend = (id: string) => {
    if (onOpenFriend) onOpenFriend(id);
    else {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('id', id);
        window.location.assign(url.toString());
      } catch {
        /* noop */
      }
    }
  };

  const friendActions =
    !mine && relation !== 'self' ? (
      <>
        {relation === 'none' ? (
          <Button type="button" size="sm" className={card2.primaryBtn} disabled={friendBusy} onClick={() => void runFriend('request', card.accountId)}>
            В друзья
          </Button>
        ) : null}
        {relation === 'outgoing' ? (
          <Button type="button" size="sm" variant="outline" disabled={friendBusy} onClick={() => void runFriend('cancel', card.accountId)}>
            Отменить заявку
          </Button>
        ) : null}
        {relation === 'incoming' ? (
          <>
            <Button type="button" size="sm" className={card2.primaryBtn} disabled={friendBusy} onClick={() => void runFriend('accept', card.accountId)}>
              Принять
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={friendBusy} onClick={() => void runFriend('decline', card.accountId)}>
              Отклонить
            </Button>
          </>
        ) : null}
        {relation === 'friends' ? (
          <Button type="button" size="sm" variant="outline" disabled={friendBusy} onClick={() => void runFriend('remove', card.accountId)}>
            Удалить из друзей
          </Button>
        ) : null}
        {friendNote ? <span className={styles.friendNote}>{friendNote}</span> : null}
      </>
    ) : null;

  return (
    <main className={card2.page}>
      <ProfileHero
        accountId={card.accountId}
        mine={mine}
        name={name}
        bioLine={rawBio.split('\n')[0] || ''}
        banner={banner}
        faceUrl={faceUrl}
        createdAt={card.createdAt}
        presence={pr}
        now={now}
        actions={friendActions}
        onBannerChanged={async () => {
          await onBannerChanged?.();
          setActivityTick((t) => t + 1);
        }}
      />

      <div className={card2.tabs} role="tablist" aria-label="Разделы профиля">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'profile'}
          className={tab === 'profile' ? `${card2.tab} ${card2.tabOn}` : card2.tab}
          onClick={() => pickTab('profile')}
        >
          <Icon name="paw" size={16} /> Профиль
        </button>
        {mine ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'settings'}
            className={tab === 'settings' ? `${card2.tab} ${card2.tabOn}` : card2.tab}
            onClick={() => pickTab('settings')}
          >
            <Icon name="gear" size={16} /> Настройки профиля
          </button>
        ) : null}
      </div>

      {tab === 'settings' && mine ? (
        <div className={`${styles.panel} ${card2.settingsBody}`} role="tabpanel">
          {settingsSlot}
        </div>
      ) : (
        <div className={card2.grid} role="tabpanel">
          <div className={card2.col}>
            <section className={card2.card} aria-labelledby="prof-char">
              <header className={card2.cardHead}>
                <h2 className={card2.cardTitle} id="prof-char">
                  <Icon name="paw" className={card2.cardIcon} />
                  Активный персонаж
                </h2>
                {charCount > 1 ? <span className={card2.cardMeta}>{charCount} {plural(charCount, 'персонаж', 'персонажа', 'персонажей')}</span> : null}
              </header>
              <div className={card2.charBody}>
                <MeadowPortrait card={shown} name={name} />
              </div>
            </section>

            <section className={card2.card} aria-labelledby="prof-stats">
              <header className={card2.cardHead}>
                <h2 className={card2.cardTitle} id="prof-stats">
                  <Icon name="chart" className={card2.cardIcon} />
                  Краткая статистика
                </h2>
              </header>
              <ul className={card2.stats}>
                <StatTile icon="cat" value={days === null ? '—' : `${days} ${plural(days, 'день', 'дня', 'дней')}`} label="В стае" />
                <StatTile icon="paw" value={String(charCount)} label={plural(charCount, 'Персонаж', 'Персонажа', 'Персонажей')} />
                <StatTile icon="pin" value={location} label="Текущая локация" title={location} wide />
                <StatTile icon="clock" value={playtimeShort(playMs)} label="В игре" title={playtimeText(playMs)} />
                <StatTile icon="users" value={String(friendCount)} label={plural(friendCount, 'Друг', 'Друга', 'Друзей')} />
              </ul>
            </section>

            <section className={card2.card} aria-labelledby="prof-about">
              <header className={card2.cardHead}>
                <h2 className={card2.cardTitle} id="prof-about">
                  <Icon name="leaf" className={card2.cardIcon} />О себе
                </h2>
                {mine ? (
                  <button type="button" className={card2.iconBtn} aria-label="Изменить «о себе»" onClick={() => pickTab('settings')}>
                    <Icon name="pencil" size={16} />
                  </button>
                ) : null}
              </header>
              <p className={card2.bio}>{bio}</p>
            </section>
          </div>

          <div className={card2.col}>
            <ProfileFriendsGrid
              friends={friends}
              count={friendCount}
              mine={mine}
              onOpen={openFriend}
              onRemove={(id) => void runFriend('remove', id)}
              onFind={onClose}
            />
            <ProfileActivity accountId={card.accountId} now={now} refreshKey={activityTick} onOpenFriend={openFriend} />
          </div>
        </div>
      )}

      <footer className={card2.foot}>
        <button type="button" className={styles.backLink} onClick={onClose}>
          ← Вернуться в каталог
        </button>
        <span className={styles.footNum} title={card.accountId}>
          Профиль {shortId}
        </span>
      </footer>
    </main>
  );
}

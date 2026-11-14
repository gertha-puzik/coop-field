'use client';

/**
 * Редизайн карточки профиля: баннер / звёздный градиент, аватар, presence,
 * пилюли дней и playtime, вкладки «Профиль» / «Настройки», персонаж на лугу,
 * статистика = локация, «о себе», список друзей с заявками.
 *
 * Правка своей карточки остаётся в OwnProfileEditor (player-profile.tsx) —
 * вкладка «Настройки» только монтирует переданный settingsSlot.
 */

import { useCallback, useState, type ReactNode } from 'react';

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
import {
  avatarOf,
  existsDaysText,
  presenceLabel,
  playtimeShort,
  playtimeText,
  spriteUrl,
  type PresenceTone,
} from './players-format';
import styles from './players-elyria.module.css';

const PRESENCE_PILL: Record<PresenceTone, string> = {
  online: styles.stOnline,
  traveling: styles.stTravel,
  away: styles.stAway,
  resting: styles.stRest,
};

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

function FriendRow({
  friend,
  canManage,
  onOpen,
  onRemove,
}: {
  friend: ProfileFriend;
  canManage: boolean;
  onOpen: (id: string) => void;
  onRemove?: (id: string) => void;
}) {
  const pr = presenceLabel(friend.presence, undefined);
  return (
    <li className={styles.friendRow}>
      <button type="button" className={styles.friendOpen} onClick={() => onOpen(friend.accountId)}>
        <span className={styles.friendAvatar} aria-hidden>
          {friend.avatar ? <img src={friend.avatar} alt="" /> : <span className={styles.friendAvatarEmpty} />}
        </span>
        <span className={styles.friendMeta}>
          <span className={styles.friendName}>{friend.displayName}</span>
          <span className={`${styles.pill} ${PRESENCE_PILL[pr.tone]}`}>{pr.text}</span>
        </span>
      </button>
      {canManage && onRemove ? (
        <button type="button" className={styles.friendActGhost} onClick={() => onRemove(friend.accountId)}>
          Удалить
        </button>
      ) : null}
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
}: ProfileCardViewProps) {
  const [tab, setTab] = useState<'profile' | 'settings'>(() =>
    typeof window !== 'undefined' && window.location.hash === '#settings' && mine ? 'settings' : 'profile',
  );
  const [relation, setRelation] = useState<FriendRelation>(card.friendRelation || (mine ? 'self' : 'none'));
  const [friends, setFriends] = useState<ProfileFriend[]>(card.friends || []);
  const [friendBusy, setFriendBusy] = useState(false);
  const [friendNote, setFriendNote] = useState<string | null>(null);

  const name = shown.displayName || card.displayName || 'Безымянный кот';
  const pr = presenceLabel(shown.presence ?? card.presence, card.lastSeenAt, now);
  const playMs = shown.playtimeMs ?? card.playtimeMs ?? 0;
  const daysPill = existsDaysText(card.createdAt, now);
  const playPill = playtimeShort(playMs);
  const playFull = playtimeText(playMs);
  const location = (shown.locationLabel ?? card.locationLabel) || 'неизвестно';
  const bio = (shown.bio ?? card.bio) || 'Пока ничего не рассказала о себе.';
  const banner = shown.banner ?? card.banner;
  const avatarUrl = shown.avatar ?? card.avatar;
  const char = avatarOf(shown);
  const faceUrl = avatarUrl || spriteUrl(char);
  const friendCount = card.friendCount ?? friends.length;
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

  return (
    <main className={`${styles.panel} ${styles.profileCard}`} style={{ padding: 0 }}>
      <div
        className={banner ? styles.profileBanner : `${styles.profileBanner} ${styles.profileBannerStar}`}
        style={banner ? { backgroundImage: `url(${banner})` } : undefined}
        role="img"
        aria-label={banner ? 'Фон профиля' : 'Звёздный фон профиля'}
      />

      <div className={styles.profileHero}>
        <div className={styles.profileFaceWrap}>
          {faceUrl ? (
            <img className={styles.profileFace} src={faceUrl} alt={name} draggable={false} />
          ) : (
            <span className={styles.profileFaceEmpty} aria-hidden>
              🐾
            </span>
          )}
        </div>
        <div className={styles.profileHeroMain}>
          <h1 className={styles.profileName}>{name}</h1>
          <p className={styles.profilePresence}>
            <span className={`${styles.pill} ${PRESENCE_PILL[pr.tone]}`}>{pr.text}</span>
          </p>
          <div className={styles.profilePills}>
            <span className={styles.metaPill} title={daysPill}>
              {daysPill}
            </span>
            <span className={styles.metaPill} title={playFull}>
              {playPill}
            </span>
            {friendCount > 0 ? (
              <span className={styles.metaPill}>
                {friendCount}{' '}
                {friendCount === 1 ? 'друг' : friendCount < 5 ? 'друга' : 'друзей'}
              </span>
            ) : null}
          </div>
          {!mine && relation !== 'self' ? (
            <div className={styles.profileFriendActs}>
              {relation === 'none' ? (
                <Button
                  type="button"
                  size="sm"
                  className="h-8 bg-[var(--sim-accent)] text-xs text-black hover:bg-[var(--sim-accent-hover)]"
                  disabled={friendBusy}
                  onClick={() => void runFriend('request', card.accountId)}
                >
                  В друзья
                </Button>
              ) : null}
              {relation === 'outgoing' ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  disabled={friendBusy}
                  onClick={() => void runFriend('cancel', card.accountId)}
                >
                  Отменить заявку
                </Button>
              ) : null}
              {relation === 'incoming' ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 bg-[var(--sim-accent)] text-xs text-black hover:bg-[var(--sim-accent-hover)]"
                    disabled={friendBusy}
                    onClick={() => void runFriend('accept', card.accountId)}
                  >
                    Принять
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={friendBusy}
                    onClick={() => void runFriend('decline', card.accountId)}
                  >
                    Отклонить
                  </Button>
                </>
              ) : null}
              {relation === 'friends' ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  disabled={friendBusy}
                  onClick={() => void runFriend('remove', card.accountId)}
                >
                  Удалить из друзей
                </Button>
              ) : null}
              {friendNote ? <span className={styles.friendNote}>{friendNote}</span> : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className={styles.profileTabs} role="tablist" aria-label="Разделы профиля">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'profile'}
          className={tab === 'profile' ? `${styles.profileTab} ${styles.profileTabOn}` : styles.profileTab}
          onClick={() => pickTab('profile')}
        >
          Профиль
        </button>
        {mine ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'settings'}
            className={tab === 'settings' ? `${styles.profileTab} ${styles.profileTabOn}` : styles.profileTab}
            onClick={() => pickTab('settings')}
          >
            Настройки
          </button>
        ) : null}
      </div>

      {tab === 'settings' && mine ? (
        <div className={styles.profileBody} role="tabpanel">
          {settingsSlot}
        </div>
      ) : (
        <div className={styles.profileBody} role="tabpanel">
          <div className={styles.profileGrid}>
            <MeadowPortrait card={shown} name={name} />
            <div className={styles.profileAside}>
              <section className={styles.profileSection} aria-labelledby="prof-stats">
                <h2 className={styles.secTitle} id="prof-stats">
                  Статистика
                </h2>
                <table className={styles.stats}>
                  <tbody>
                    <tr>
                      <td className={styles.statsK}>Локация</td>
                      <td className={styles.statsV}>{location}</td>
                    </tr>
                  </tbody>
                </table>
              </section>

              <section className={styles.profileSection} aria-labelledby="prof-about">
                <h2 className={styles.secTitle} id="prof-about">
                  О себе
                </h2>
                <p className={styles.profileBio}>{bio}</p>
              </section>
            </div>
          </div>

          <section className={styles.profileSection} aria-labelledby="prof-friends">
            <h2 className={styles.secTitle} id="prof-friends">
              Друзья{friendCount ? ` · ${friendCount}` : ''}
            </h2>
            {friends.length ? (
              <ul className={styles.friendList}>
                {friends.map((f) => (
                  <FriendRow
                    key={f.accountId}
                    friend={f}
                    canManage={mine}
                    onOpen={openFriend}
                    onRemove={mine ? (id) => void runFriend('remove', id) : undefined}
                  />
                ))}
              </ul>
            ) : (
              <p className={styles.profileMuted}>Пока никого в списке друзей.</p>
            )}
          </section>
        </div>
      )}

      <footer className={styles.panelFoot}>
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

'use client';

/**
 * Карточка «Друзья» по макету 2026-11-14: сетка аватаров с точкой
 * присутствия. Владелец может удалить друга (второй клик подтверждает)
 * и перейти в каталог плиткой «Добавить».
 */

import { useState } from 'react';

import type { ProfileFriend } from '@/lib/net/http-profiles';

import { Icon } from './profile-icons';
import { presenceLabel } from './players-format';
import styles from './profile-card.module.css';

const DOT: Record<string, string> = {
  online: styles.dotOnline,
  traveling: styles.dotTravel,
  away: styles.dotAway,
  resting: styles.dotRest,
};

export function ProfileFriendsGrid({
  friends,
  count,
  mine,
  onOpen,
  onRemove,
  onFind,
}: {
  friends: ProfileFriend[];
  count: number;
  mine: boolean;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  onFind: () => void;
}) {
  const [armed, setArmed] = useState<string | null>(null);
  return (
    <section className={styles.card} aria-labelledby="prof-friends">
      <header className={styles.cardHead}>
        <h2 className={styles.cardTitle} id="prof-friends">
          <Icon name="users" className={styles.cardIcon} />
          Друзья{count ? ` · ${count}` : ''}
        </h2>
      </header>
      {friends.length || mine ? (
        <ul className={styles.friendGrid}>
          {friends.map((f) => {
            const pr = presenceLabel(f.presence, undefined);
            return (
              <li key={f.accountId} className={styles.friendTile}>
                <button type="button" className={styles.friendBtn} onClick={() => onOpen(f.accountId)} title={pr.text}>
                  <span className={styles.friendFace}>
                    {f.avatar ? <img src={f.avatar} alt="" draggable={false} /> : <Icon name="cat" size={28} />}
                  </span>
                  <span className={styles.friendLabel}>
                    <span className={`${styles.dot} ${DOT[pr.tone]}`} aria-label={pr.text} />
                    <span className={styles.friendNameText}>{f.displayName}</span>
                  </span>
                </button>
                {mine ? (
                  <button
                    type="button"
                    className={armed === f.accountId ? `${styles.friendDrop} ${styles.friendDropArmed}` : styles.friendDrop}
                    title={armed === f.accountId ? 'Ещё раз — и удалим из друзей' : 'Удалить из друзей'}
                    aria-label={`Удалить ${f.displayName} из друзей`}
                    onClick={() => {
                      if (armed === f.accountId) {
                        setArmed(null);
                        onRemove(f.accountId);
                      } else setArmed(f.accountId);
                    }}
                  >
                    {armed === f.accountId ? 'Точно?' : '×'}
                  </button>
                ) : null}
              </li>
            );
          })}
          {mine ? (
            <li className={styles.friendTile}>
              <button type="button" className={styles.friendBtn} onClick={onFind}>
                <span className={`${styles.friendFace} ${styles.friendAdd}`}>
                  <Icon name="plus" size={24} />
                </span>
                <span className={styles.friendLabel}>
                  <span className={styles.friendNameText}>Найти</span>
                </span>
              </button>
            </li>
          ) : null}
        </ul>
      ) : (
        <p className={styles.muted}>Пока никого в списке друзей.</p>
      )}
    </section>
  );
}

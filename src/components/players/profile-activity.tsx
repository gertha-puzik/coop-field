'use client';

/**
 * Карточка «Последние действия» (спека 2026-11-14): публичная лента
 * GET /cfg/activity/:id. Пола в DTO нет — тексты нейтральные.
 */

import { useEffect, useState } from 'react';

import { httpActivity, type ActivityItem } from '@/lib/net/http-activity';

import { Icon, type IconName } from './profile-icons';
import { ruAgo } from './players-format';
import styles from './profile-card.module.css';

const ICON: Record<ActivityItem['type'], IconName> = {
  joined_site: 'paw',
  entered_game: 'door',
  moved: 'pin',
  friend_added: 'users',
  avatar_changed: 'cat',
  banner_changed: 'image',
};

const SOMEONE = 'кто-то';

function ActivityText({ item, onOpen }: { item: ActivityItem; onOpen: (id: string) => void }) {
  const { label, friendId, friendName } = item.data;
  switch (item.type) {
    case 'joined_site':
      return <>Регистрация на сайте</>;
    case 'entered_game':
      return <>Вход в игру{label ? ` · ${label}` : ''}</>;
    case 'moved':
      return <>Переход в локацию «{label || 'неизвестно'}»</>;
    case 'friend_added':
      return (
        <>
          Новый друг:{' '}
          {friendId && friendName && friendName !== SOMEONE ? (
            <button type="button" className={styles.inlineLink} onClick={() => onOpen(friendId)}>
              {friendName}
            </button>
          ) : (
            friendName || SOMEONE
          )}
        </>
      );
    case 'avatar_changed':
      return <>Новый аватар</>;
    case 'banner_changed':
      return <>Новая шапка профиля</>;
  }
}

export function ProfileActivity({
  accountId,
  now,
  refreshKey = 0,
  onOpenFriend,
}: {
  accountId: string;
  now: number;
  /** Смена значения перечитывает ленту (после правок своей карточки). */
  refreshKey?: number;
  onOpenFriend: (id: string) => void;
}) {
  const [state, setState] = useState<{ id: string; items: ActivityItem[] | null; failed: boolean }>({
    id: '',
    items: null,
    failed: false,
  });

  useEffect(() => {
    let live = true;
    void httpActivity(accountId).then((res) => {
      if (!live) return;
      setState(res.ok ? { id: accountId, items: res.items, failed: false } : { id: accountId, items: [], failed: true });
    });
    return () => {
      live = false;
    };
  }, [accountId, refreshKey]);

  const items = state.id === accountId ? state.items : null;

  return (
    <section className={styles.card} aria-labelledby="prof-activity">
      <header className={styles.cardHead}>
        <h2 className={styles.cardTitle} id="prof-activity">
          <Icon name="pulse" className={styles.cardIcon} />
          Последние действия
        </h2>
      </header>
      {items === null ? (
        <ul className={styles.actList} aria-busy="true">
          {[0, 1, 2].map((k) => (
            <li key={k} className={`${styles.actRow} ${styles.actSkel}`} />
          ))}
        </ul>
      ) : state.failed ? (
        <p className={styles.muted}>Ленту не удалось загрузить.</p>
      ) : items.length ? (
        <ul className={styles.actList}>
          {items.map((it) => (
            <li key={it.id} className={styles.actRow}>
              <Icon name={ICON[it.type]} className={styles.actIcon} />
              <span className={styles.actText}>
                <ActivityText item={it} onOpen={onOpenFriend} />
              </span>
              <time className={styles.actTime} dateTime={new Date(it.at).toISOString()}>
                {ruAgo(it.at, now)}
              </time>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>Пока тихо.</p>
      )}
    </section>
  );
}

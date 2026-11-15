'use client';

/** Общая шапка Elysiae Aedes: бренд, текущие ссылки с иконками,
 * уведомления, профиль, выход и тема. На узком экране тот же набор в меню.
 * Сессия использует общий me-cache; закрытые ссылки остаются за IS_ELYRIA.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { httpLogout } from '@/lib/net/http-auth';
import { meBadgeName, meHasAccount, myProfileHref, useMeRow } from '@/lib/net/me-cache';
import {
  httpNotificationsMe,
  httpNotificationsRead,
  type NotificationItem,
} from '@/lib/net/http-notifications';
import { httpFriendAccept, httpFriendDecline } from '@/lib/net/http-friends';
import { startPresenceBeat } from '@/lib/net/presence-beat';
import { ThemeSelect } from '@/components/site/theme-select';
import styles from './site-header.module.css';

/** Пункт вертикального меню бургера: та же пара цветов, но строка с
 *  площадкой тапа; hover-фон — существующий rgba auth-модалки (0.09). */
const MENU_LINK =
  'block rounded-lg px-3 py-2 text-left text-[13px] text-[#b9b3d9] transition-colors hover:bg-[rgba(226,220,255,0.09)] hover:text-[#f4f0ff]';

/** Бургер: кант/стекло сессий-панелей auth-gate, h-9 w-9, три полоски. */
const BURGER_BUTTON =
  'flex h-9 w-9 items-center justify-center rounded-lg border border-[rgba(226,220,255,0.28)] bg-[rgba(226,220,255,0.06)] text-[#f4f0ff] transition-colors hover:bg-[rgba(226,220,255,0.14)]';

/** Dropdown-панель: карточка auth-модалки (кант/стекло/blur 8px, тень
 *  18px 40px), absolute под бургером. */
const MENU_PANEL =
  'absolute left-0 top-full z-50 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-[18px] border border-[rgba(226,220,255,0.28)] bg-[rgba(10,14,32,0.62)] p-2 shadow-[0_18px_40px_rgba(0,0,0,0.28)] backdrop-blur-[8px]';

const BELL_PANEL =
  'absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-[18px] border border-[rgba(226,220,255,0.28)] bg-[rgba(10,14,32,0.92)] p-2 shadow-[0_18px_40px_rgba(0,0,0,0.28)] backdrop-blur-[8px]';

const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria';

/** id dropdown-панели для aria-controls бургера (шапка на странице одна). */
const NAV_ICONS = {
  home: 'M3 11 12 3l9 8M6 10v11h12V10M10 21v-7h4v7',
  game: 'M7 7h10c3 0 5 9 3 11-2 2-4-3-5-3H9c-1 0-3 5-5 3-2-2 0-11 3-11zM8 9v5M5.5 11.5h5M16 10h.01M18 13h.01',
  players: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 21v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6M17 15a5 5 0 0 1 5 5',
  profile: 'M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 22a8 8 0 0 1 16 0',
  admin: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM9 12l2 2 4-4',
};
const MENU_ID = 'site-nav-menu';
const BELL_ID = 'site-notify-panel';

function NotifyBell({ inAccount }: { inAccount: boolean }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    if (!inAccount || !IS_ELYRIA) return;
    setLoading(true);
    const res = await httpNotificationsMe();
    setLoading(false);
    if (!res) return;
    setItems(res.items);
    setUnread(res.unread);
  }, [inAccount]);

  useEffect(() => {
    if (!inAccount) {
      setItems([]);
      setUnread(0);
      return;
    }
    void reload();
    const t = window.setInterval(() => void reload(), 45_000);
    return () => window.clearInterval(t);
  }, [inAccount, reload]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (ev: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) setOpen(false);
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const openPanel = async () => {
    const next = !open;
    setOpen(next);
    if (next) await reload();
  };

  const markAllRead = async () => {
    const res = await httpNotificationsRead({ all: true });
    if (res.ok) {
      setUnread(res.unread);
      setItems((prev) => prev.map((it) => ({ ...it, read: true })));
    }
  };

  if (!inAccount) return null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-[rgba(226,220,255,0.28)] bg-[rgba(226,220,255,0.06)] text-[#f4f0ff] transition-colors hover:bg-[rgba(226,220,255,0.14)]"
        aria-label={unread ? `Уведомления, непрочитанных: ${unread}` : 'Уведомления'}
        aria-expanded={open}
        aria-controls={BELL_ID}
        onClick={() => void openPanel()}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 3a5.5 5.5 0 0 0-5.5 5.5v2.2c0 .7-.2 1.4-.6 2L4.6 15a1 1 0 0 0 .8 1.6h13.2a1 1 0 0 0 .8-1.6l-1.3-2.3c-.4-.6-.6-1.3-.6-2V8.5A5.5 5.5 0 0 0 12 3Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M9.5 18.2a2.5 2.5 0 0 0 5 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        {unread > 0 ? (
          <span
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[#e05252] shadow-[0_0_0_2px_rgba(10,14,32,0.85)]"
            aria-hidden
          />
        ) : null}
      </button>
      {open ? (
        <div id={BELL_ID} className={BELL_PANEL} role="dialog" aria-label="Уведомления">
          <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
            <span className="text-[12.5px] font-semibold text-[#efe7ff]">Уведомления</span>
            <div className="flex items-center gap-2">
              {unread > 0 ? (
                <button
                  type="button"
                  className="text-[11px] text-[#b9b3d9] underline-offset-2 hover:text-[#f4f0ff] hover:underline"
                  onClick={() => void markAllRead()}
                >
                  Прочитать все
                </button>
              ) : null}
              <button
                type="button"
                className="text-[11px] text-[#b9b3d9] underline-offset-2 hover:text-[#f4f0ff] hover:underline"
                onClick={() => void reload()}
              >
                {loading ? '…' : 'Обновить'}
              </button>
            </div>
          </div>
          {items.length === 0 ? (
            <p className="px-3 py-4 text-center text-[12.5px] text-[#b9b3d9]">Пока тихо — новых уведомлений нет.</p>
          ) : (
            <ul className="max-h-72 space-y-1 overflow-y-auto">
              {items.map((it) => {
                const fromId =
                  it.type === 'friend_request' && typeof it.payload?.fromId === 'string'
                    ? it.payload.fromId
                    : '';
                return (
                  <li
                    key={it.id}
                    className={`rounded-lg px-3 py-2 ${it.read ? 'bg-transparent' : 'bg-[rgba(226,220,255,0.07)]'}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-[12.5px] font-semibold text-[#f4f0ff]">{it.title || 'Событие'}</div>
                      {!it.read ? (
                        <span className="mt-0.5 shrink-0 rounded bg-[rgba(224,82,82,0.2)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[#ffb4b4]">
                          новое
                        </span>
                      ) : null}
                    </div>
                    {it.body ? <p className="mt-0.5 text-[12px] leading-snug text-[#b9b3d9]">{it.body}</p> : null}
                    {fromId ? (
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          className="rounded-md border border-[rgba(226,220,255,0.28)] px-2 py-1 text-[11px] text-[#efe7ff] hover:bg-[rgba(226,220,255,0.1)]"
                          onClick={() => {
                            void (async () => {
                              await httpFriendAccept(fromId);
                              await httpNotificationsRead({ ids: [it.id] });
                              void reload();
                            })();
                          }}
                        >
                          Принять
                        </button>
                        <button
                          type="button"
                          className="rounded-md px-2 py-1 text-[11px] text-[#b9b3d9] hover:text-[#f4f0ff]"
                          onClick={() => {
                            void (async () => {
                              await httpFriendDecline(fromId);
                              await httpNotificationsRead({ ids: [it.id] });
                              void reload();
                            })();
                          }}
                        >
                          Отклонить
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function SiteHeader({ ghost = false, home = false }: { ghost?: boolean; home?: boolean }) {
  const [open, setOpen] = useState(false);
  /** Бургер + панель одним контейнером: «клик вне» меряется от него. */
  const menuRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const update = () => document.documentElement.style.setProperty('--site-header-height', `${header.getBoundingClientRect().height}px`);
    update();
    const observer = new ResizeObserver(update);observer.observe(header);
    return () => { observer.disconnect();document.documentElement.style.removeProperty('--site-header-height'); };
  }, []);
  const me = useMeRow();
  const inAccount = meHasAccount(me);
  const isAdmin = inAccount && me?.role === 'admin';

  useEffect(() => {
    if (!IS_ELYRIA || !inAccount) return;
    startPresenceBeat('site');
  }, [inAccount]);

  /** Закрытие панели: повторный тап (toggle в кнопке), клик вне
   *  (pointerdown мимо menuRef) и Esc — слушатели живут только пока
   *  панель открыта. Переход пункта (в т.ч. anchor на той же странице)
   *  тоже сворачивает панель — closeMenu на каждом пункте. */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (ev: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(ev.target as Node)) setOpen(false);
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  /** Выход: httpLogout гасит куку и me-кэш вкладки (бейджи слушают ME_EVENT),
   *  дальше — главная. Сбой сети не блокирует выход: уходим всё равно. */
  const logout = useCallback(async () => {
    try {
      await httpLogout();
    } catch {
      /* одна попытка: сервер недоступен — уходим без него */
    }
    window.location.replace('/');
  }, []);
  const closeMenu = useCallback(() => setOpen(false), []);

  /** Пункты шапки — единственный источник разметки: и горизонтальная
   *  полоса (lg+), и вертикальное меню бургера (<lg) рендерят этот
   *  массив. Элизия-маршруты — только в инлайн-тернарниках над
   *  IS_ELYRIA (правило P3: grotto-сборка вырезает литералы, DCE). */
  const navItems = [
    { key: 'home', label: 'Главная', href: IS_ELYRIA ? 'https://abnocw.phainonsmilk.ru/' : '/' },
    { key: 'game', label: 'Игровая комната', href: IS_ELYRIA ? '/game/' : '/' },
    { key: 'players', label: 'Игроки', href: IS_ELYRIA ? '/players/' : '/' },
    { key: 'profile', label: 'Мой профиль', href: myProfileHref(me) },
    ...(isAdmin ? [{ key: 'admin', label: 'Админка', href: IS_ELYRIA ? '/admin/' : '/' }] : []),
  ];

  /** Один и тот же рендер пунктов для обеих поверхностей. */
  const renderNav = (link: string) =>
    navItems.map((item) => (
      <a key={item.key} className={link} href={item.href} onClick={closeMenu}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={NAV_ICONS[item.key as keyof typeof NAV_ICONS]} /></svg>
        {item.label}
      </a>
    ));

  /** Переиспользование сессии без дублирования: бейдж и «Выйти» — те же
   *  элементы в полосе (lg+) и в меню бургера (<lg). */
  const sessionBadge = inAccount ? (
    <a className={styles.identity} href={myProfileHref(me)} onClick={closeMenu}>
      <span className={styles.identityAvatar} aria-hidden>{meBadgeName(me).slice(0, 1)}</span>
      <span>{meBadgeName(me)}</span>
    </a>
  ) : null;
  const logoutButton = inAccount ? (
    <button
      type="button"
      onClick={() => {
        closeMenu();
        void logout();
      }}
      className="text-[12.5px] text-[#b9b3d9] underline-offset-2 transition-colors hover:text-[#f4f0ff] hover:underline"
    >
      Выйти
    </button>
  ) : null;

  /** Главная использует тот же бренд и навигацию; остальные страницы — sticky. */
  const shellClass = `${styles.header} ${home ? styles.home : ''}`;

  return (
    <header ref={headerRef} className={shellClass}>
      <a href={IS_ELYRIA ? '/' : '/'} className={styles.brand} aria-label="Wanderpaws: Elysiae Aedes — главная">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.4 14.2A8.6 8.6 0 1 1 9.8 3.6a7 7 0 0 0 10.6 10.6Z" /></svg>
        <span><strong>WANDERPAWS</strong><small>ELYSIAE AEDES</small></span>
      </a>
      {/* <lg: бургер; на lg+ контейнер не виден (lg:hidden) */}
      <div ref={menuRef} className={styles.mobileMenu}>
        <button
          type="button"
          className={BURGER_BUTTON}
          aria-label="Меню"
          aria-expanded={open}
          aria-controls={MENU_ID}
          onClick={() => setOpen((v) => !v)}
        >
          <svg width="18" height="14" viewBox="0 0 18 14" fill="none" aria-hidden="true">
            <rect y="0.75" width="18" height="1.5" rx="0.75" fill="currentColor" />
            <rect y="6.25" width="18" height="1.5" rx="0.75" fill="currentColor" />
            <rect y="11.75" width="18" height="1.5" rx="0.75" fill="currentColor" />
          </svg>
        </button>
        {open ? (
          <div id={MENU_ID} className={MENU_PANEL}>
            <nav aria-label="Разделы сайта" className="flex flex-col">
              {renderNav(`${MENU_LINK} ${styles.menuLink}`)}
            </nav>
            {inAccount ? (
              <div className="mt-1 flex flex-col items-start gap-2 border-t border-[rgba(226,220,255,0.12)] px-3 py-2.5">
                {sessionBadge}
                {logoutButton}
              </div>
            ) : null}
            <div className="flex items-center px-3 py-2.5">
              <ThemeSelect />
            </div>
          </div>
        ) : null}
      </div>
      {/* <lg: колокольчик справа от бургера */}
      <div className={styles.mobileBell}>
        <NotifyBell inAccount={inAccount} />
      </div>
      {/* lg+: прежняя полоса; на <lg скрыта (hidden lg:flex — вид ноль) */}
      <div className={styles.desktop}>
        <nav aria-label="Разделы сайта" className={styles.navigation}>
          {renderNav(styles.navLink)}
        </nav>
        <div className={styles.session}>
          <NotifyBell inAccount={inAccount} />
          {sessionBadge}
          {logoutButton}
          <ThemeSelect />
        </div>
      </div>
    </header>
  );
}

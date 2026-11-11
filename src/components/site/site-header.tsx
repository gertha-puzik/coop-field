'use client';

/**
 * Общая шапка закрытого сайта (пересводка волны W2, мандат владелицы
 * 2026-11-08): тонкая стеклянная ночная полоса (52px, кант/стекло/цвета
 * существующих сессий-панелей auth-gate) — единая для страниц Элизии
 * (/, /game/, /players/, /admin/); на главной — ghost без стекла (2026-11-10).
 *
 * Мобильная нав-волна 2026-11-10 (<lg): прежнее содержимое полосы скрыто
 * целиком (обёртка hidden lg:flex), слева остаётся один бургер; dropdown
 * под ним несёт ТОТ ЖЕ состав — пункты задаются один раз массивом
 * navItems (горизонтальная полоса и вертикальное меню рендерят его),
 * сессию и ThemeSelect переиспользуют те же элементы. Закрытие:
 * повторный тап, клик вне, Esc, клик по пункту. На lg+ вид прежней
 * полосы не менялся вовсе — добавлена только обёртка hidden lg:flex.
 *
 * Состав полосы — навигация: Главная, Игровая комната, Игроки, Мой
 * профиль (пункт «Настройки» упразднён решением владелицы 2026-11-10: он
 * вёл на ту же страницу профиля, что и «Мой профиль»; якорь #settings
 * формы правки живёт в deep-link); «Админка» — только при role==='admin'.
 * Справа — сессия: «Вы вошли как …» (гость: бейджа и админ-пункта нет —
 * он видит окно входа гейта), «Выйти» (POST /auth/logout через
 * httpLogout — он же сбрасывает общий me-кэш вкладки и рассылает
 * ME_EVENT) и возврат на главную, плюс селект темы (существующий
 * ThemeSelect: статья про новый механизм темы не открывается).
 *
 * Данные — useMeRow/meCached из src/lib/net/me-cache.tsx: шапка не шлёт
 * второго GET /auth/me, если страницу уже спросил AuthGate/каталог/админка
 * (кэш «one fetch per tab», прецедент cfg-live.ts).
 *
 * Монтируется ТОЛЬКО в местах с инлайн-гейтом IS_ELYRIA (wander-gate,
 * страницы каталога/симулятора/админки): сам файл env-строк не носит —
 * grotto-сборка вырезает ветку целиком вместе с компонентом (DCE).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { httpLogout } from '@/lib/net/http-auth';
import { meBadgeName, meHasAccount, myProfileHref, useMeRow } from '@/lib/net/me-cache';
import { ThemeSelect } from '@/components/site/theme-select';

/** Текстовая ссылка полосы: тонкая, без рамок — стеклянная ночь шапки. */
const NAV_LINK =
  'whitespace-nowrap text-[13px] text-[#b9b3d9] underline-offset-2 transition-colors hover:text-[#f4f0ff] hover:underline';

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

const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria';

/** id dropdown-панели для aria-controls бургера (шапка на странице одна). */
const MENU_ID = 'site-nav-menu';

export function SiteHeader({ ghost = false }: { ghost?: boolean }) {
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
        {item.label}
      </a>
    ));

  /** Переиспользование сессии без дублирования: бейдж и «Выйти» — те же
   *  элементы в полосе (lg+) и в меню бургера (<lg). */
  const sessionBadge = inAccount ? (
    <span className="max-w-[24ch] truncate text-xs text-[#b9b3d9]">Вы вошли как {meBadgeName(me)}</span>
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

  return (
    <header ref={headerRef} className={ghost ? 'sticky top-0 z-[45] flex min-h-[52px] flex-wrap items-center gap-x-5 gap-y-2 px-4' : 'sticky top-0 z-[45] flex min-h-[52px] flex-wrap items-center gap-x-5 gap-y-2 border-b border-[rgba(226,220,255,0.28)] bg-[rgba(10,14,32,0.62)] px-4 backdrop-blur-[8px]'}>
      {/* <lg: бургер; на lg+ контейнер не виден (lg:hidden) */}
      <div ref={menuRef} className="relative lg:hidden">
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
              {renderNav(MENU_LINK)}
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
      {/* lg+: прежняя полоса; на <lg скрыта (hidden lg:flex — вид ноль) */}
      <div className="hidden min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-2 lg:flex">
        <nav aria-label="Разделы сайта" className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          {renderNav(NAV_LINK)}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {sessionBadge}
          {logoutButton}
          <ThemeSelect />
        </div>
      </div>
    </header>
  );
}

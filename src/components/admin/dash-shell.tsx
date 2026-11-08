'use client';

import type { ReactNode } from 'react';

import { StarBackdrop } from '@/components/menu/star-backdrop';
import nightStyles from '@/components/site/site-night.module.css';
import s from './dash-side.module.css';

/**
 * Оболочка контентной панели с сайд-меню (/admin — Elysiae; стиль: ночь
 * #070b18, стеклянные панели, звёзды за контентом). Экран навигации
 * отделён от содержимого вкладок: панель отдаёт МАССИВ ДЕСКРИПТОРОВ,
 * оболочка сама рисует сайдбар и справа — активную вкладку.
 *
 * Как добавить свою вкладку (волны «Броня»/«Спрайты»): одна строка в массиве
 *   { id: 'armor', title: 'Броня', render: () => <ArmorTab /> },
 * Пункт с render:null — зарезервирован и НЕ рендерится, пока компонента нет.
 */

export type DashTab = {
  id: string;
  title: string;
  render: (() => ReactNode) | null;
};

export function DashShell({
  tabs,
  active,
  onPick,
  title,
  headerExtra = null,
  notice = null,
  children,
}: {
  tabs: DashTab[];
  active: string;
  onPick: (id: string) => void;
  title: string;
  headerExtra?: ReactNode;
  notice?: ReactNode;
  children: ReactNode;
}) {
  const visible = tabs.filter((t) => t.render !== null);
  return (
    <main className={`${nightStyles.pageNight} relative min-h-screen`}>
      {/* Звёзды ЗА контентом: слой ничего не ловит (pointer-events:none),
          панели полупрозрачные — фон ночи виден вокруг них. */}
      <div className="star-backdrop" aria-hidden>
        <StarBackdrop />
      </div>
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold text-[var(--sim-text)]">{title}</h1>
          <div className="flex flex-wrap items-center gap-3">{headerExtra}</div>
        </header>
        {notice}
        <div className="flex min-h-0 flex-col gap-4 md:flex-row md:items-start">
          {/* Сайд-меню категорий: слева стеклянная колонка (sticky), на
              мобильном (<768px) — горизонтальная лента с прокруткой. */}
          <aside className={`${s.dashSide} md:sticky md:top-6 md:w-56 md:shrink-0`}>
            <nav className={s.dashSideNav} aria-label="Разделы панели">
              {visible.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={s.dashSideItem}
                  data-active={t.id === active}
                  onClick={() => onPick(t.id)}
                >
                  {t.title}
                </button>
              ))}
            </nav>
          </aside>
          {/* Контент выбранной категории: вся остальная ширина, прокрутка —
              общая у страницы, сайдбар на десктопе залипает сверху. */}
          <section className="min-w-0 flex-1">{children}</section>
        </div>
      </div>
    </main>
  );
}

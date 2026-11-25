'use client';

import { useState, type ReactNode } from 'react';
import { ConsoleNavigationContext } from './console-subtabs';

import { StarBackdrop } from '@/components/menu/star-backdrop';
import nightStyles from '@/components/site/site-night.module.css';
import s from './admin-console.module.css';
import { Icon, type IconName } from '@/components/players/profile-icons';
import { ConsoleHero } from './console-hero';

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
  const [subnavTarget,setSubnavTarget]=useState<HTMLDivElement|null>(null);
  const icons: Record<string,IconName> = {general:'chart',users:'users',characteristics:'paw',world:'pin',locations:'pin',assets:'gear'};
  const visible = tabs.filter((t) => t.render !== null);
  return (
    <main className={`${nightStyles.pageNight} relative min-h-screen`}>
      {/* Звёзды ЗА контентом: слой ничего не ловит (pointer-events:none),
          панели полупрозрачные — фон ночи виден вокруг них. */}
      <div className="star-backdrop" aria-hidden>
        <StarBackdrop />
      </div>
      <div className={`${s.wrap} ${s.shell}`}>
        <ConsoleHero title={title}/>
        {notice}
        <ConsoleNavigationContext.Provider value={{target:subnavTarget,expanded:!!active}}>
          <div className={s.navigation}>
            <nav className={s.nav} aria-label="Разделы админ-панели">{visible.map(tab=><button key={tab.id} type="button" aria-expanded={tab.id===active} aria-controls="admin-subsections" onClick={()=>onPick(tab.id)}><Icon name={icons[tab.id] || 'gear'} size={22}/>{tab.title}<span className={s.chevron} aria-hidden>⌄</span></button>)}</nav>
            <div className={s.submenu} data-open={!!active} id="admin-subsections" inert={!active}>
              <div className={s.submenuClip}><div ref={setSubnavTarget}/></div>
            </div>
          </div>
          <section className="min-w-0" hidden={!active}>{children}</section>
        </ConsoleNavigationContext.Provider>
      </div>
    </main>
  );
}

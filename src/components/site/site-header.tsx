'use client';

/**
 * Общая шапка закрытого сайта (пересводка волны W2, мандат владелицы
 * 2026-11-08): тонкая стеклянная ночная полоса (52px, кант/стекло/цвета
 * существующих сессий-панелей auth-gate) — единая для страниц Элизии
 * (/, /elision/, /players/, /admin/).
 *
 * Слева — навигация: Главная, Игровая комната, Игроки, Настройки (якорь
 * #settings своей карточки — контракт с волной W1), Мой профиль; «Панель» —
 * только при role==='admin'. Справа — сессия: «Вы вошли как …» (гость:
 * бейджа и админ-пункта нет — он видит окно входа гейта), «Выйти» (POST
 * /auth/logout через httpLogout — он же сбрасывает общий me-кэш вкладки
 * и рассылает ME_EVENT) и возврат на главную, плюс селект темы (существующий
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
import { useCallback } from 'react';

import { httpLogout } from '@/lib/net/http-auth';
import { meBadgeName, meHasAccount, myProfileHref, useMeRow } from '@/lib/net/me-cache';
import { ThemeSelect } from '@/components/site/theme-select';

/** Текстовая ссылка полосы: тонкая, без рамок — стеклянная ночь шапки. */
const NAV_LINK =
  'whitespace-nowrap text-[13px] text-[#b9b3d9] underline-offset-2 transition-colors hover:text-[#f4f0ff] hover:underline';

export function SiteHeader() {
  const me = useMeRow();
  const inAccount = meHasAccount(me);
  const isAdmin = inAccount && me?.role === 'admin';

  /** Своя карточка с якорем (гость — каталог без id): настроек и профиля
   *  общий предикат: без аккаунта ведём в каталог, там гейт сам спросит вход. */
  const profileHref = (hash: `#${string}` | '' = ''): string =>
    inAccount && me?.accountId ? `/players/?id=${encodeURIComponent(me.accountId)}${hash}` : '/players/';

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

  return (
    <header className="sticky top-0 z-[45] flex min-h-[52px] flex-wrap items-center gap-x-5 gap-y-2 border-b border-[rgba(226,220,255,0.28)] bg-[rgba(10,14,32,0.62)] px-4 backdrop-blur-[8px]">
      <nav aria-label="Разделы сайта" className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        <a className={NAV_LINK} href="/">
          Главная
        </a>
        <a className={NAV_LINK} href="/elision/">
          Игровая комната
        </a>
        <a className={NAV_LINK} href="/players/">
          Игроки
        </a>
        <a className={NAV_LINK} href={profileHref('#settings')}>
          Настройки
        </a>
        <a className={NAV_LINK} href={myProfileHref(me)}>
          Мой профиль
        </a>
        {isAdmin ? (
          <a className={NAV_LINK} href="/admin/">
            Панель
          </a>
        ) : null}
      </nav>
      <div className="ml-auto flex items-center gap-3">
        {inAccount ? (
          <span className="max-w-[24ch] truncate text-xs text-[#b9b3d9]">Вы вошли как {meBadgeName(me)}</span>
        ) : null}
        {inAccount ? (
          <button type="button" onClick={() => void logout()} className="text-[12.5px] text-[#b9b3d9] underline-offset-2 transition-colors hover:text-[#f4f0ff] hover:underline">
            Выйти
          </button>
        ) : null}
        <ThemeSelect />
      </div>
    </header>
  );
}

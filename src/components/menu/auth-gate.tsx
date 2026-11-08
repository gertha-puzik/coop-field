'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { CoopWhoami } from '@/lib/net/protocol';
import { httpLogin, httpLogout, httpMe, httpRegister } from '@/lib/net/http-auth';
import { AuthModal } from './auth-modal';
import {
  SERVER_UNREACHABLE,
  reasonText,
  roleLabel,
  whoamiHasAccount,
} from '@/components/sim/auth-reasons';

/**
 * Compile-time вариант сайта (P3, спек §2A): гейт входа существует только в
 * elyria-сборке. В grotto вся ветка (модаль, её тексты, HTTP-вызовы) вырезается
 * сворачиванием тернарников вместе с IS_ELYRIA — как карточки Элизии в
 * wander-gate: гроты не получают и намёка на аккаунты.
 */
const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria';

/** Фон оверлея: на живой странице (главная) меню просвечивает сквозь ночное
 *  затемнение, изолированной странице (симулятор/каталог/админка) модаль
 *  сама несёт ночь #070b18 — за ней нечего показывать. */
const overlayBg = (live: boolean): string => (live ? 'rgba(7,11,24,0.55)' : '#070b18');

/**
 * Полноэкранный гейт входа для страниц Элизии: гость сначала видит окно
 * входа/регистрации, и только после — содержимое страницы. Сессия — HttpOnly
 * cookie: повторный визит восстанавливается GET /auth/me (существующий
 * whoami-флоу), «Выйти» доступен прямо из гейта (проп `chrome`).
 *
 * Порядок показа: дети рендерятся сразу (SSR/пререндер страницы остаётся
 * прежним — гейт check:variants сверяет тексты главной), а модаль накрывает
 * их только ПОДТВЕРЖДЁННОГО гостя — как только /auth/me вернёт ответ без
 * аккаунта. Залогиненный модали не видит вовсе: для него ничего не мигает.
 *
 * Гейт — самостоятельный HTTP-клиент: httpLogin/httpRegister/httpLogout из
 * src/lib/net/http-auth.ts зовутся как есть, контракты сервера не меняются.
 * Симулятор и его entry-экран не трогаются: дети монтируются как раньше и
 * читают ту же куку.
 */
export function AuthGate({
  children,
  /** Держать детей смонтированными под модалью (главная: звёздное небо видно сквозь стекло). */
  live = false,
  /** Показать бейдж «Вы вошли · Выйти» поверх содержимого (гейт главного меню). */
  chrome = false,
}: {
  children: ReactNode;
  live?: boolean;
  chrome?: boolean;
}) {
  /** Снимок /auth/me; null — ответа ещё не было (гость приходит как {ok:true, role:'guest'}). */
  const [me, setMe] = useState<CoopWhoami | null>(null);
  /** Кука проверена: только теперь точно известно, гость ли зашёл. */
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Отказ сервера/сети для модали (reason уже переведён в текст). */
  const [fail, setFail] = useState<string | null>(null);
  /** Короткий «добро пожаловать» после успеха: строка приветствия, сама гаснет. */
  const [welcome, setWelcome] = useState<string | null>(null);

  useEffect(() => {
    if (!IS_ELYRIA) return;
    let dead = false;
    void httpMe().then((row) => {
      if (!dead) {
        setMe(row);
        setChecked(true);
      }
    });
    return () => {
      dead = true;
    };
  }, []);

  /** Экран успеха гаснет сам — модаль закрывается, страница оживает. */
  useEffect(() => {
    if (!welcome) return;
    const t = window.setTimeout(() => setWelcome(null), 900);
    return () => window.clearTimeout(t);
  }, [welcome]);

  const submit = useCallback(
    async (action: 'login' | 'register', login: string, pass: string, name?: string) => {
      if (!IS_ELYRIA) return;
      setBusy(true);
      setFail(null);
      let row: Awaited<ReturnType<typeof httpLogin>>;
      try {
        row = action === 'login' ? await httpLogin(login, pass) : await httpRegister(login, pass, name);
      } catch {
        setFail(SERVER_UNREACHABLE);
        setBusy(false);
        return;
      }
      if (row.ok && row.accountId) {
        setMe(row);
        setWelcome(action === 'login' ? `С возвращением, ${row.login ?? login}!` : `Аккаунт создан, ${row.login ?? login}!`);
      } else {
        setFail(reasonText(row.reason));
      }
      setBusy(false);
    },
    [],
  );

  /** Выход из бейджа гейта: куку гасим, страница возвращается к окну входа. */
  const logout = useCallback(async () => {
    if (!IS_ELYRIA) return;
    setBusy(true);
    let row: Awaited<ReturnType<typeof httpLogout>>;
    try {
      row = await httpLogout();
    } catch {
      row = { ok: true, role: 'guest' };
    }
    setMe(row);
    setChecked(true);
    setWelcome(null);
    setFail(null);
    setBusy(false);
  }, []);

  // Grotto: гейта не существует — ветка ниже фолдится вместе с текстами.
  if (!IS_ELYRIA) return <>{children}</>;

  const inAccount = whoamiHasAccount(me);
  /** Гость подтверждён ответом /auth/me — только теперь накрываем страницу. */
  const confirmedGuest = checked && !inAccount;
  const open = confirmedGuest || welcome !== null;

  const sessionBar = chrome && checked && inAccount ? (
    <div className="fixed right-3 top-3 z-40 flex items-center gap-3 rounded-full border border-[rgba(226,220,255,0.28)] bg-[rgba(10,14,32,0.62)] px-4 py-2 text-[13px] text-[#f4f0ff] shadow-[0_10px_26px_rgba(0,0,0,0.28)] backdrop-blur-[8px]">
      <span className="max-w-[38vw] truncate font-semibold sm:max-w-none">{me?.login}</span>
      <span className="hidden text-[12px] text-[#b9b3d9] sm:inline">· {roleLabel(me?.role)}</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void logout()}
        className="rounded-full border border-[rgba(226,220,255,0.28)] bg-[rgba(226,220,255,0.06)] px-3 py-1 text-[12.5px] text-[#f4f0ff] transition-colors hover:bg-[rgba(226,220,255,0.14)] disabled:opacity-50"
      >
        Выйти
      </button>
    </div>
  ) : null;

  const modal = open ? (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4 sm:p-8"
      style={{ background: overlayBg(live) }}
    >
      <AuthModal
        busy={busy}
        fail={fail}
        welcome={inAccount ? welcome : null}
        onLogin={(login, pass) => void submit('login', login, pass)}
        onRegister={(login, pass, name) => void submit('register', login, pass, name)}
      />
    </div>
  ) : null;

  if (!live && open && confirmedGuest) {
    // Изолированная страница гостя: под модалью ничего нет — тяжёлое
    // (симулятор, каталог) не монтируем, рендерим только окно входа.
    return modal;
  }
  return (
    <>
      {sessionBar}
      {modal}
      {children}
    </>
  );
}

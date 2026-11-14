'use client';

import { useEffect, useRef, useState } from 'react';
import { display } from './site-fonts';
import { localGateError } from '@/components/sim/auth-reasons';

/**
 * Compile-time вариант сайта (P3): модаль mounts только в elyria-ветках
 * гейта — в grotto-сборке весь её JSX и тексты отрезаны тернарником вместе
 * с IS_ELYRIA (как карточки Элизии в wander-gate).
 */
const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria';

/**
 * Стеклянная модаль входа/регистрации (референс лучших UX жанра: полноэкранное
 * окно сначала, игра — потом). Токены: ночь #070b18, панель rgba(10,14,32,0.62)
 * + blur(8px), рамка rgba(226,220,255,0.28), скругление 18px, текст #f4f0ff /
 * мягкий #b9b3d9, акценты #f6d7a2 (золото) и #efe7ff (лаванда), ошибка #e07a7a,
 * успех «в игре» #7dcaa0.
 *
 * Поля — реальные контракты server/auth.js: при регистрации логин — латиница/
 * цифры/._- 2–24, «Код приглашения» — XXXX-XXXX от администрации (24 часа,
 * без него регистрация закрыта), «Имя на поле» — опциональное видимое имя
 * 2–24 (без него зовут логином), пароль от 8; вход — прежние мягкие правила
 * (старые логины бывают с пробелами). Отправка через
 * onLogin/onRegister(login, pass, name?, invite?) наружу (гейт сам зовёт
 * httpLogin/httpRegister из http-auth.ts — клиенты не дублируются).
 */

type Mode = 'login' | 'register';

const TABS: readonly { mode: Mode; label: string }[] = IS_ELYRIA
  ? [
      { mode: 'login', label: 'Вход' },
      { mode: 'register', label: 'Создать аккаунт' },
    ]
  : [];

const INPUT_BASE =
  'w-full rounded-xl border bg-[rgba(226,220,255,0.06)] px-3.5 py-2.5 text-[15px] ' +
  'text-[#f4f0ff] outline-none transition-colors placeholder:text-[rgba(185,179,217,0.45)]';
const INPUT_OK = 'border-[rgba(226,220,255,0.16)] focus:border-[rgba(246,215,162,0.55)] focus:bg-[rgba(226,220,255,0.09)]';
const INPUT_BAD = 'border-[rgba(224,122,122,0.75)]';

function Field({
  label,
  hint,
  bad,
  children,
}: {
  label: string;
  hint?: string | null;
  bad?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-left">
      <span className="mb-1.5 block text-[13px] tracking-wide text-[#b9b3d9]">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-[12.5px] leading-snug text-[#e07a7a]">{hint}</span> : null}
    </label>
  );
}

export function AuthModal({
  busy,
  /** строка отказа сервера/сети (reasonText уже применён) — показывается у формы */
  fail,
  /** короткий экран «добро пожаловать» после успеха: логин или null */
  welcome,
  onLogin,
  onRegister,
}: {
  busy?: boolean;
  fail?: string | null;
  welcome?: string | null;
  onLogin: (login: string, pass: string) => void;
  /** register v2: name — опциональное «имя на поле» (отсутствует → звать
   *  логином); invite — код приглашения XXXX-XXXX (регистрация закрытого
   *  сайта только по кодам от админов, живут 24 часа). */
  onRegister: (login: string, pass: string, name?: string, invite?: string) => void;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [login, setLogin] = useState('');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [fieldName, setFieldName] = useState('');
  const [invite, setInvite] = useState('');
  /** локальная ошибка полей: подсветка + hint; гаснет при любом вводе */
  const [localFail, setLocalFail] = useState<string | null>(null);
  const loginRef = useRef<HTMLInputElement | null>(null);

  /** автофокус на логине после монтирования; смена таба — тоже в поле. */
  useEffect(() => {
    if (!IS_ELYRIA) return;
    loginRef.current?.focus({ preventScroll: true });
  }, []);

  const touch = () => setLocalFail(null);
  const switchMode = (next: Mode) => {
    if (busy) return;
    setMode(next);
    setLocalFail(null);
  };

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    if (busy || welcome) return;
    const local = localGateError(
      mode,
      login,
      pass,
      mode === 'register' ? pass2 : undefined,
      mode === 'register' ? fieldName : undefined,
      mode === 'register' ? invite : undefined,
    );
    if (local) {
      setLocalFail(local);
      return;
    }
    const clean = login.trim().slice(0, 24);
    if (mode === 'login') onLogin(clean, pass);
    else onRegister(clean, pass, fieldName.trim() || undefined, invite.trim() || undefined);
  };

  const failText = localFail || fail || null;
  const badLogin = failText ? 'border-[rgba(224,122,122,0.75)]' : INPUT_OK;
  const badPass = failText ? 'border-[rgba(224,122,122,0.75)]' : INPUT_OK;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Вход в игру"
      className="w-full max-w-[470px] rounded-[18px] border border-[rgba(226,220,255,0.28)] bg-[rgba(10,14,32,0.62)] p-8 shadow-[0_18px_40px_rgba(0,0,0,0.28)] backdrop-blur-[8px] sm:p-10"
    >
      {welcome ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center" aria-live="polite">
          <span className="inline-flex items-center gap-2 rounded-full border border-[rgba(125,202,160,0.35)] bg-[rgba(125,202,160,0.10)] px-3 py-1 text-[12px] text-[#7dcaa0]">
            <i className="h-[7px] w-[7px] rounded-full bg-[#7dcaa0] shadow-[0_0_8px_#7dcaa0]" />
            В игре
          </span>
          <h2 className="m-0 font-sans text-[26px] font-semibold tracking-wide text-[#f4f0ff]">
            {welcome}
          </h2>
          <p className="m-0 text-[13.5px] text-[#b9b3d9]">Сейчас откроется продолжение…</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col items-center text-center">
            <span className={`${display.className} mb-3 rounded-full border border-[rgba(246,215,162,0.35)] px-3.5 py-1 text-[11px] uppercase tracking-[3px] text-[#f6d7a2]`}>
              Elysiae Aedes
            </span>
            <h1
              className={`${display.className} m-0 bg-[linear-gradient(93deg,#f6d7a2_20%,#efe7ff)] bg-clip-text text-[clamp(2.5rem,7vw,3.4rem)] leading-[1.05] tracking-normal text-transparent drop-shadow-[0_6px_22px_rgba(246,215,162,0.18)]`}
            >
              Wanderpaws
            </h1>
            <p className="mt-2 text-[15px] text-[#b9b3d9]">Твой путь начинается здесь</p>
          </div>

          <div role="tablist" aria-label="Вход или создание аккаунта" className="mt-6 flex gap-2 rounded-[14px] border border-[rgba(226,220,255,0.12)] bg-[rgba(226,220,255,0.06)] p-1.5">
            {TABS.map((tab) => (
              <button
                key={tab.mode}
                type="button"
                role="tab"
                aria-selected={mode === tab.mode}
                onClick={() => switchMode(tab.mode)}
                className={`flex-1 rounded-[10px] border-0 px-2.5 py-2.5 text-[14.5px] transition-colors ${
                  mode === tab.mode
                    ? 'bg-[rgba(239,231,255,0.14)] text-[#f4f0ff] shadow-[inset_0_0_0_1px_rgba(239,231,255,0.25)]'
                    : 'bg-transparent text-[#b9b3d9] hover:text-[#f4f0ff]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <form className="mt-5" onSubmit={submit} noValidate>
            <div className="flex flex-col gap-4">
              <Field label="Логин" hint={failText}>
                <input
                  ref={loginRef}
                  type="text"
                  value={login}
                  maxLength={24}
                  autoComplete="username"
                  placeholder="например, лунный_странник"
                  aria-invalid={Boolean(failText)}
                  onChange={(e) => {
                    setLogin(e.target.value);
                    touch();
                  }}
                  className={`${INPUT_BASE} ${badLogin}`}
                />
              </Field>
              {mode === 'register' ? (
                <Field label="Код приглашения">
                  <input
                    type="text"
                    value={invite}
                    maxLength={9}
                    autoComplete="off"
                    placeholder="XXXX-XXXX — действует 24 часа"
                    aria-invalid={Boolean(failText)}
                    onChange={(e) => {
                      setInvite(e.target.value);
                      touch();
                    }}
                    className={`${INPUT_BASE} ${badLogin}`}
                  />
                  <span className="mt-1.5 block text-[12.5px] leading-snug text-[rgba(185,179,217,0.6)]">
                    регистрация — только по приглашениям администрации
                  </span>
                </Field>
              ) : null}
              {mode === 'register' ? (
                <Field label="Имя на поле">
                  <input
                    type="text"
                    value={fieldName}
                    maxLength={24}
                    autoComplete="off"
                    placeholder="как вас будут звать на поле (можно кириллицей)"
                    aria-invalid={Boolean(failText)}
                    onChange={(e) => {
                      setFieldName(e.target.value);
                      touch();
                    }}
                    className={`${INPUT_BASE} ${badLogin}`}
                  />
                  <span className="mt-1.5 block text-[12.5px] leading-snug text-[rgba(185,179,217,0.6)]">
                    необязательно — без него вас будут звать логином
                  </span>
                </Field>
              ) : null}
              <Field label="Пароль">
                <input
                  type="password"
                  value={pass}
                  maxLength={64}
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  placeholder="не короче 8 символов"
                  aria-invalid={Boolean(failText)}
                  onChange={(e) => {
                    setPass(e.target.value);
                    touch();
                  }}
                  className={`${INPUT_BASE} ${badPass}`}
                />
              </Field>
              {mode === 'register' ? (
                <Field label="Повтор пароля">
                  <input
                    type="password"
                    value={pass2}
                    maxLength={64}
                    autoComplete="new-password"
                    placeholder="ещё раз пароль"
                    aria-invalid={Boolean(failText)}
                    onChange={(e) => {
                      setPass2(e.target.value);
                      touch();
                    }}
                  className={`${INPUT_BASE} ${badPass}`}
                  />
                </Field>
              ) : null}
            </div>
            {failText ? (
              <p role="status" className="mt-3 rounded-xl bg-[rgba(224,122,122,0.08)] px-3.5 py-2.5 text-[13px] leading-snug text-[#e07a7a]">
                {failText}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={busy}
              className="mt-4 w-full rounded-[13px] border-0 bg-[linear-gradient(93deg,#f6d7a2,#efe7ff)] px-6 py-3 text-[16px] font-semibold text-[#2e2010] shadow-[0_10px_26px_rgba(246,215,162,0.20)] transition-transform hover:-translate-y-px hover:brightness-105 disabled:opacity-60"
            >
              {busy ? 'Подождите…' : mode === 'register' ? 'Зарегистрироваться' : 'Войти'}
            </button>
          </form>
        </>
      )}
    </div>
  );
}

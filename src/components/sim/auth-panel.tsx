'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CoopWhoami } from '@/lib/net/protocol';
import { localAuthError, reasonText, roleLabel } from './auth-reasons';

/**
 * Боковая панель входа на русском. Пароль не показывается. Панель монтируется
 * только в elyria-варианте (гейт — в entry-screen): в гротах входа нет.
 *
 * Подписи отказов сервера и локальные проверки — общие с полноэкранным гейтом
 * входа (menu/auth-gate.tsx): они живут в auth-reasons.ts (контракты
 * server/accounts.js + server/auth.js handleAuthHttp: логин 2–24, пароль от 8,
 * отказы taken/weak/short/full/rate/bad).
 */

export function AuthPanel({
  whoami,
  busy,
  message,
  onLogin,
  onRegister,
  onLogout,
}: {
  whoami: CoopWhoami | null;
  busy?: boolean;
  message?: string | null;
  onLogin: (login: string, pass: string) => void;
  onRegister: (login: string, pass: string) => void;
  onLogout: () => void;
}) {
  const [login, setLogin] = useState(whoami?.login || '');
  const [pass, setPass] = useState('');
  /** Ошибка локальной проверки — показывается до отправки и гаснет при вводе. */
  const [localFail, setLocalFail] = useState<string | null>(null);
  const inAccount = !!(whoami?.ok && whoami.accountId);
  const role = roleLabel(whoami?.role);
  /** Сетевая/серверная ошибка — из message; отказ из ответа — по reason. */
  const fail =
    localFail || message || (!whoami?.ok ? reasonText(whoami?.reason) : null);

  /** После выхода не оставлять прошлый пароль в поле. */
  const wasAccount = useRef(inAccount);
  useEffect(() => {
    if (wasAccount.current && !inAccount) {
      setPass('');
      setLocalFail(null);
    }
    wasAccount.current = inAccount;
  }, [inAccount]);

  const editLogin = (v: string) => {
    setLogin(v);
    setLocalFail(null);
  };
  const editPass = (v: string) => {
    setPass(v);
    setLocalFail(null);
  };
  const submit = (action: 'login' | 'register') => {
    if (busy) return;
    const local = localAuthError(login, pass);
    if (local) {
      setLocalFail(local);
      return;
    }
    setLocalFail(null);
    // Логин режем так же, как сервер (обрезка пробелов); пароль — как набран.
    if (action === 'login') onLogin(login.trim(), pass);
    else onRegister(login.trim(), pass);
  };

  if (inAccount) {
    return (
      <div className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
        <h2 className="text-base font-bold text-[var(--sim-text)]">Вы вошли</h2>
        <p className="mt-1 text-sm text-[var(--sim-text-soft)]">
          {whoami?.login} · {role}. Имя на поле — из персонажа, его не подменить в join.
        </p>
        <p className="mt-1 text-xs text-[var(--sim-text-muted)]">
          Сессия держится в защищённой куке: после перезагрузки страницы вход сохраняется.
        </p>
        <Button type="button" size="sm" variant="outline" className="mt-3 h-8 text-xs" onClick={onLogout} disabled={busy}>
          Выйти
        </Button>
      </div>
    );
  }

  return (
    <form
      className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4"
      onSubmit={(ev) => {
        ev.preventDefault();
        submit('login');
      }}
    >
      <h2 className="text-base font-bold text-[var(--sim-text)]">Аккаунт</h2>
      <p className="mt-1 text-xs text-[var(--sim-text-muted)]">
        Закрытый мир: чтобы играть под своим именем, войдите или создайте аккаунт. Имя — от 2 до 24
        символов, пароль — от 8.
      </p>
      <label className="mt-3 block text-[11px] text-[var(--sim-text-faint)]" htmlFor="auth-login">
        Имя
        <Input
          id="auth-login"
          className="mt-1 h-8 text-sm"
          value={login}
          maxLength={24}
          autoComplete="username"
          placeholder="От 2 до 24 символов"
          autoFocus
          aria-describedby="auth-fail"
          onChange={(e) => editLogin(e.target.value)}
        />
      </label>
      <label className="mt-2 block text-[11px] text-[var(--sim-text-faint)]" htmlFor="auth-pass">
        Пароль
        <Input
          id="auth-pass"
          type="password"
          className="mt-1 h-8 text-sm"
          value={pass}
          autoComplete="current-password"
          placeholder="Не короче 8 символов"
          aria-describedby="auth-fail"
          onChange={(e) => editPass(e.target.value)}
        />
      </label>
      {fail ? (
        <p id="auth-fail" role="status" className="mt-2 text-xs font-semibold text-red-400">
          {fail}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          className="h-8 bg-[var(--sim-accent)] text-xs text-black hover:bg-[var(--sim-accent-hover)]"
          disabled={busy}
        >
          Войти
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          disabled={busy}
          onClick={() => submit('register')}
        >
          Зарегистрироваться
        </Button>
      </div>
      <p className="mt-2 text-[10px] leading-snug text-[var(--sim-text-faint)]">
        «Войти» — по существующему имени, «Зарегистрироваться» — создаст новый аккаунт с этими именем и паролем.
      </p>
    </form>
  );
}

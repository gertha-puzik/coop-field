'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CoopWhoami } from '@/lib/net/protocol';

/**
 * Вход и регистрация на русском. Пароль не показывается. Панель монтируется
 * только в elyria-варианте (гейт — в entry-screen): в гротах входа нет.
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
  const inAccount = !!(whoami?.ok && whoami.accountId);
  const role = whoami?.role === 'admin' ? 'админ' : whoami?.role === 'registered' ? 'свой кот' : 'гость';
  const fail =
    message ||
    (!whoami?.ok && whoami?.reason === 'taken'
      ? 'Это имя уже занято.'
      : !whoami?.ok && whoami?.reason === 'weak'
        ? 'Пароль слишком короткий (минимум 8 символов).'
        : !whoami?.ok && whoami?.reason === 'short'
          ? 'Имя слишком короткое.'
          : !whoami?.ok && whoami?.reason === 'full'
            ? 'Регистрация закрыта: места для новых аккаунтов закончились.'
            : !whoami?.ok && whoami?.reason === 'rate'
              ? 'Слишком часто. Подождите немного.'
              : !whoami?.ok && whoami?.reason === 'bad'
                ? 'Неверный логин или пароль.'
                : !whoami?.ok && whoami?.reason
                  ? 'Не получилось войти.'
                  : null);

  if (inAccount) {
    return (
      <div className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
        <h2 className="text-base font-bold text-[var(--sim-text)]">Вы вошли</h2>
        <p className="mt-1 text-sm text-[var(--sim-text-soft)]">
          {whoami?.login} · {role}. Имя на поле — из персонажа, его не подменить в join.
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
        onLogin(login, pass);
      }}
    >
      <h2 className="text-base font-bold text-[var(--sim-text)]">Аккаунт</h2>
      <p className="mt-1 text-xs text-[var(--sim-text-muted)]">
        Закрытый мир: чтобы войти, нужен аккаунт. Пароль — от 8 символов.
      </p>
      <label className="mt-3 block text-[11px] text-[var(--sim-text-faint)]">
        Имя
        <Input
          className="mt-1 h-8 text-sm"
          value={login}
          maxLength={24}
          autoComplete="username"
          onChange={(e) => setLogin(e.target.value)}
        />
      </label>
      <label className="mt-2 block text-[11px] text-[var(--sim-text-faint)]">
        Пароль (от 8 символов)
        <Input
          type="password"
          className="mt-1 h-8 text-sm"
          value={pass}
          autoComplete="current-password"
          onChange={(e) => setPass(e.target.value)}
        />
      </label>
      {fail ? <p className="mt-2 text-xs font-semibold text-red-400">{fail}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="submit" size="sm" className="h-8 bg-[var(--sim-accent)] text-xs text-black hover:bg-[var(--sim-accent-hover)]" disabled={busy}>
          Войти
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          disabled={busy}
          onClick={() => onRegister(login, pass)}
        >
          Зарегистрироваться
        </Button>
      </div>
    </form>
  );
}

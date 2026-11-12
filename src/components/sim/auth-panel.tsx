'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Field, Input, Panel } from '@/components/ui';
import type { CoopWhoami } from '@/lib/net/protocol';
import { localAuthError, localFieldNameError, localInviteError, localNewLoginError, reasonText, roleLabel } from './auth-reasons';

/**
 * Боковая панель входа на русском. Пароль не показывается. Панель монтируется
 * только в elyria-варианте (гейт — в entry-screen): в гротах входа нет.
 *
 * Подписи отказов сервера и локальные проверки — общие с полноэкранным гейтом
 * входа (menu/auth-gate.tsx): они живут в auth-reasons.ts (контракты
 * server/accounts.js + server/auth.js handleAuthHttp. Register v2: при
 * создании логин — латиница/цифры/._- 2–24, имя на поле — опционально 2–24
 * видимых символов; вход — прежние мягкие правила, старые логины живы).
 *
 * UI-кирпичи — из внутренних наборов (ui-kit, docs/UI-KIT.md): панель — Panel,
 * поля — Field+Input, главная кнопка — Button variant="primary" (пара
 * --uk-accent-*: та же зелёная с тёмными чернилами, что была инлайном).
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
  /** register v2: name — опциональное «имя на поле» (пусто → сервер зовёт
   *  логином); invite — код приглашения XXXX-XXXX (регистрация закрытого
   *  сайта — только по кодам от админов, живут 24 часа). */
  onRegister: (login: string, pass: string, name?: string, invite?: string) => void;
  onLogout: () => void;
}) {
  const [login, setLogin] = useState(whoami?.login || '');
  const [pass, setPass] = useState('');
  const [fieldName, setFieldName] = useState('');
  const [invite, setInvite] = useState('');
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
  const editFieldName = (v: string) => {
    setFieldName(v);
    setLocalFail(null);
  };
  const editInvite = (v: string) => {
    setInvite(v);
    setLocalFail(null);
  };
  const submit = (action: 'login' | 'register') => {
    if (busy) return;
    const local = localAuthError(login, pass);
    if (local) {
      setLocalFail(local);
      return;
    }
    // Register v2: логин при создании — строгий формат; имя на поле — опция.
    if (action === 'register') {
      const newLogin = localNewLoginError(login);
      const inviteErr = localInviteError(invite);
      const fieldErr = localFieldNameError(fieldName);
      if (newLogin || inviteErr || fieldErr) {
        setLocalFail(newLogin || inviteErr || fieldErr || null);
        return;
      }
    }
    setLocalFail(null);
    // Логин режем так же, как сервер (обрезка пробелов); пароль — как набран.
    if (action === 'login') onLogin(login.trim(), pass);
    else onRegister(login.trim(), pass, fieldName.trim() || undefined, invite.trim() || undefined);
  };

  if (inAccount) {
    return (
      <Panel className="p-4">
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
      </Panel>
    );
  }

  return (
    <Panel
      as="form"
      className="p-4"
      onSubmit={(ev) => {
        ev.preventDefault();
        submit('login');
      }}
    >
      <h2 className="text-base font-bold text-[var(--sim-text)]">Аккаунт</h2>
      <p className="mt-1 text-xs text-[var(--sim-text-muted)]">
        Закрытый мир: чтобы играть под своим именем, войдите или создайте аккаунт. Логин при создании — латиница, цифры
        и ._-, 2–24 символа; пароль — от 8. Регистрация — только по кодам приглашений от администрации.
      </p>
      <Field className="mt-2" label="Имя" htmlFor="auth-login" describedBy="auth-fail">
        <Input
          id="auth-login"
          className="mt-1 h-8 text-sm"
          value={login}
          maxLength={24}
          autoComplete="username"
          placeholder="От 2 до 24 символов"
          autoFocus
          onChange={(e) => editLogin(e.target.value)}
        />
      </Field>
      <Field
        className="mt-2"
        label="Код приглашения (для регистрации)"
        htmlFor="auth-invite"
        hint="регистрация — только по приглашениям"
        describedBy="auth-fail"
      >
        <Input
          id="auth-invite"
          className="mt-1 h-8 font-mono text-sm"
          value={invite}
          maxLength={9}
          autoComplete="off"
          placeholder="XXXX-XXXX — действует 24 часа"
          onChange={(e) => editInvite(e.target.value)}
        />
      </Field>
      <Field
        className="mt-2"
        label="Имя на поле (для регистрации)"
        htmlFor="auth-field-name"
        hint="необязательно — без него вас будут звать логином"
        describedBy="auth-fail"
      >
        <Input
          id="auth-field-name"
          className="mt-1 h-8 text-sm"
          value={fieldName}
          maxLength={24}
          autoComplete="off"
          placeholder="как вас будут звать (можно кириллицей)"
          onChange={(e) => editFieldName(e.target.value)}
        />
      </Field>
      <Field className="mt-2" label="Пароль" htmlFor="auth-pass" describedBy="auth-fail">
        <Input
          id="auth-pass"
          type="password"
          className="mt-1 h-8 text-sm"
          value={pass}
          autoComplete="current-password"
          placeholder="Не короче 8 символов"
          onChange={(e) => editPass(e.target.value)}
        />
      </Field>
      {fail ? (
        <p id="auth-fail" role="status" className="mt-2 text-xs font-semibold text-[var(--uk-danger-soft-text)]">
          {fail}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="primary" className="h-8 text-xs" disabled={busy}>
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
        «Войти» — по существующему имени. «Зарегистрироваться» — создаст аккаунт по коду приглашения; имя на поле — как
        вас будут звать (пустое → логином).
      </p>
    </Panel>
  );
}

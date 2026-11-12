/**
 * Общие клиентские тексты и проверки аккаунта Элизии.
 * Один источник для двух точек входа (боковая панель симулятора auth-panel.tsx
 * и полноэкранный гейт входа menu/auth-modal.tsx) — иначе подписи отказов
 * дрейфуют между формами.
 *
 * Контракты сервера (server/accounts.js + server/auth.js handleAuthHttp,
 * сверены живыми пробами): при СОЗДАНИИ логин — латиница/цифры и ._-, 2–24
 * (register v2; отказ → 'badlogin'); имя на поле — 2–24 видимых символа, любой
 * алфавит, опционально (мусор → 'badname'); пароль — от 8; занятое имя →
 * 'taken', короткие поля старых форм → 'short'/'weak', неверные данные
 * входа → 'bad' (вход старых логинов с пробелами/кириллицей жив), флуд →
 * 'rate' (429), реестр полон → 'full'. Инвайты: регистрация закрытого сайта —
 * только по кодам-приглашениям админов (XXXX-XXXX, 24 часа); неверный/
 * просроченный/использованный код → 'invite'. Сервер отвечает кодом в теле —
 * русский текст для пользователя живёт здесь.
 */

/** Серверный reason → человекочитаемая строка. Прочие коды (сбой, CSRF) —
 *  общий фолбэк 'error': в браузерном флоу они не складываются в детали. */
export const REASON_TEXTS: Record<string, string> = {
  taken: 'Это имя уже занято — придумайте другое.',
  weak: 'Пароль слишком короткий: нужно минимум 8 символов.',
  short: 'Имя слишком короткое: нужно минимум 2 символа.',
  badlogin: 'Логин — латиница, цифры, точки, дефисы и подчёркивания; без пробелов. От 2 до 24 символов.',
  badname: 'Имя на поле — от 2 до 24 видимых символов.',
  full: 'Регистрация закрыта: места для новых аккаунтов закончились.',
  rate: 'Слишком часто. Подождите немного и попробуйте снова.',
  bad: 'Неверный логин или пароль.',
  invite: 'Код приглашения неверный или устарел. Попросите новый у администрации.',
  error: 'Не получилось: сервер не принял запрос. Попробуйте ещё раз.',
};

/** Строка отказа по reason сервера; null — показывать нечего. */
export function reasonText(reason?: string | null): string | null {
  if (!reason) return null;
  return REASON_TEXTS[reason] ?? REASON_TEXTS.error;
}

/** Сеть/сервер недоступны — общий текст сетевой ошибки HTTP-флоу. */
export const SERVER_UNREACHABLE = 'Сервер входа недоступен. Попробуйте ещё раз.';

/** Подпись роли аккаунта для бейджа сессии. */
export function roleLabel(role?: string): string {
  if (role === 'admin') return 'администратор';
  if (role === 'registered') return 'игрок Элизии';
  return 'гость';
}

/** Признак «в аккаунте» по кадру whoami (гость тоже приходит с ok:true,
 *  только без accountId — как в протоколе /auth/me). */
export function whoamiHasAccount(row: { ok?: boolean; accountId?: string } | null | undefined): boolean {
  return Boolean(row?.ok && row?.accountId);
}

/** Проверка ДО отправки (повторяет контракты сервера, чтобы пустые и короткие
 * поля не гоняли лишний запрос и ошибку видно сразу, без сети).
 * Пароль не обрезаем: пробелы в нём валидны. null — можно отправлять. */
export function localAuthError(login: string, pass: string): string | null {
  const name = login.trim();
  if (!name) return 'Введите имя — без него не войти.';
  if (name.length < 2) return 'Имя слишком короткое: нужно минимум 2 символа.';
  if (!pass) return 'Введите пароль.';
  if (Array.from(pass).length < 8) return 'Пароль слишком короткий: нужно минимум 8 символов.';
  return null;
}

/** Формат НОВОГО логина при регистрации (register v2; зерно серверного
 *  validateNewLogin): латиница/цифры и ._-, 2–24, края — буква/цифра.
 *  Для входа формат НЕ проверяем — старые логины бывают с пробелами/кириллицей.
 *  null — ок, строка — показать у формы. */
export const NEW_LOGIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,22}[a-zA-Z0-9]$/;

export function localNewLoginError(login: string): string | null {
  return NEW_LOGIN_RE.test(String(login || '').trim()) ? null : REASON_TEXTS.badlogin;
}

/** Имя на поле при регистрации: опционально (пусто — звать логином),
 *  задано — 2–24 видимых символа. null — ок. */
export function localFieldNameError(fieldName: string): string | null {
  const clean = String(fieldName || '').trim();
  if (!clean) return null;
  const cp = Array.from(clean).length;
  return cp >= 2 && cp <= 24 ? null : REASON_TEXTS.badname;
}

/** Код приглашения при регистрации (закрытый сайт): обязателен и непуст после
 * trim (форма канона — XXXX-XXXX, финальный арбитр всё равно сервер).
 *  null — ок; строка — показать у формы. */
export function localInviteError(invite: string): string | null {
  return String(invite || '').trim() ? null : 'Введите код приглашения — регистрация только по приглашениям.';
}

/**
 * Та же проверка для гейтовой формы с повтором пароля (регистрация): подписи
 * полей другие («Логин»), но правила — те же контракты сервера. null — можно
 * отправлять; строка — показать у формы. В register-режиме проверяет формат
 * нового логина, имя на поле и непустой код приглашения (арбитр всё равно
 * сервер — это быстрая отсечка).
 */
export function localGateError(
  mode: 'login' | 'register',
  login: string,
  pass: string,
  pass2?: string,
  fieldName?: string,
  invite?: string,
): string | null {
  const loginClean = login.trim();
  if (!loginClean) return 'Введите логин — без него не войти.';
  if (mode === 'register') {
    const newLogin = localNewLoginError(login);
    if (newLogin) return newLogin;
  } else if (loginClean.length < 2) {
    return 'Логин слишком короткий: нужно минимум 2 символа.';
  }
  if (!pass) return 'Введите пароль.';
  if (Array.from(pass).length < 8) return 'Пароль слишком короткий: нужно минимум 8 символов.';
  if (mode === 'register') {
    const fieldErr = localFieldNameError(fieldName ?? '');
    if (fieldErr) return fieldErr;
    const inviteErr = localInviteError(invite ?? '');
    if (inviteErr) return inviteErr;
    if (pass2 !== pass) return 'Пароли не совпадают.';
  }
  return null;
}

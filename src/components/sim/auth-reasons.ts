/**
 * Общие клиентские тексты и проверки аккаунта Элизии.
 * Один источник для двух точек входа (боковая панель симулятора auth-panel.tsx
 * и полноэкранный гейт входа menu/auth-modal.tsx) — иначе подписи отказов
 * дрейфуют между формами.
 *
 * Контракты сервера (server/accounts.js + server/auth.js handleAuthHttp,
 * сверены живыми пробами): логин 2–24 символа после обрезки пробелов, пароль —
 * от 8; занятое имя → reason 'taken', короткие имя/пароль → 'short'/'weak',
 * неверные данные входа → 'bad', флуд → 'rate' (429), реестр полон → 'full'.
 * Сервер отвечает кодом в теле — русский текст для пользователя живёт здесь.
 */

/** Серверный reason → человекочитаемая строка. Прочие коды (сбой, CSRF) —
 *  общий фолбэк 'error': в браузерном флоу они не складываются в детали. */
export const REASON_TEXTS: Record<string, string> = {
  taken: 'Это имя уже занято — придумайте другое.',
  weak: 'Пароль слишком короткий: нужно минимум 8 символов.',
  short: 'Имя слишком короткое: нужно минимум 2 символа.',
  full: 'Регистрация закрыта: места для новых аккаунтов закончились.',
  rate: 'Слишком часто. Подождите немного и попробуйте снова.',
  bad: 'Неверный логин или пароль.',
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

/**
 * Та же проверка для гейтовой формы с повтором пароля (регистрация): подписи
 * полей другие («Логин»), но правила — те же контракты сервера. null — можно
 * отправлять; строка — показать у формы.
 */
export function localGateError(mode: 'login' | 'register', login: string, pass: string, pass2?: string): string | null {
  const name = login.trim();
  if (!name) return 'Введите логин — без него не войти.';
  if (name.length < 2) return 'Логин слишком короткий: нужно минимум 2 символа.';
  if (!pass) return 'Введите пароль.';
  if (Array.from(pass).length < 8) return 'Пароль слишком короткий: нужно минимум 8 символов.';
  if (mode === 'register' && pass2 !== pass) return 'Пароли не совпадают.';
  return null;
}

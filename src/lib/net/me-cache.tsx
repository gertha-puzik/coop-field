"use client";

/**
 * Клиентский мостик me-сессии для шапок Элизии (W2, мандат владелицы
 * 2026-11-08): ссылка «Мой профиль» + бейдж «Вы вошли как …» на четырёх
 * страницах закрытого сайта (/, /game/, /players/, /admin/).
 *
 * Данные — meCached() из ./http-auth.ts: один GET /auth/me на вкладку
 * («one fetch per tab», прецедент cfg-live.ts). Хук НЕ шлёт второго запроса,
 * если страницу уже спросил AuthGate/каталог/админка; после login/register/
 * logout http-auth сбрасывает общий кэш и рассылает ME_EVENT — бейдж
 * обновляется на лету.
 *
 * Живёт отдельным модулем ('use client' + React-хук): http-auth.ts — общий
 * низкоуровневый ходок графа обеих сборок (изоляция §10.4), клиентскую
 * директиву и JSX в него не тащим. Инлайн-флаг = сворачивание ветки в
 * grotto: хук там не фетчит вовсе (мёртвый хвост вырезается, как в
 * auth-gate; тексты «Мой профиль»/«Вы вошли как» остаются elyria-only).
 */
const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === "elyria";

import { useEffect, useState } from "react";
import { type CoopWhoami, isCoopWhoami } from "./protocol";
import { ME_EVENT, meCached } from "./http-auth";

/**
 * Признак «в аккаунте» — тот же предикат, что у гейта (whoamiHasAccount из
 * auth-reasons: ok + accountId). Гость тоже приходит как {ok:true, role:'guest'}.
 */
export function meHasAccount(me: CoopWhoami | null | undefined): boolean {
  return !!(me && me.ok && me.accountId);
}

/**
 * Снимок сессии для шапки: null — ответа ещё не было. Без собственного
 * фетча: переиспользует закэшированный промис вкладки и слушает ME_EVENT
 * (обновление после входа/выхода в этой же вкладке — без перезагрузки).
 */
export function useMeRow(): CoopWhoami | null {
  const [me, setMe] = useState<CoopWhoami | null>(null);
  useEffect(() => {
    if (!IS_ELYRIA) return;
    let dead = false;
    void meCached().then((row) => {
      if (!dead) setMe(row);
    });
    const onFresh = (ev: Event) => {
      const row = (ev as CustomEvent).detail as unknown;
      if (!dead && isCoopWhoami(row)) setMe(row);
    };
    window.addEventListener(ME_EVENT, onFresh);
    return () => {
      dead = true;
      window.removeEventListener(ME_EVENT, onFresh);
    };
  }, []);
  return me;
}

/** href ссылки «Мой профиль»: вошедший — своя карточка, гость/без id — каталог.
 *  Маршрут — за ИНЛАЙН-тернарником (P3, IS_ELYRIA модуля выше): модуль
 *  остаётся в общем чанке при grotto-сборке, строка «/players/» обязана
 *  умирать в мёртвой ветке. */
export function myProfileHref(me: CoopWhoami | null | undefined): string {
  const id = me?.accountId;
  return me?.ok && id
    ? IS_ELYRIA
      ? `/players/?id=${encodeURIComponent(id)}`
      : '/'
    : IS_ELYRIA
      ? "/players/"
      : '/';
}

/**
 * Имя для бейджа «Вы вошли как …»: сервер несёт profile.displayName
 * (server/auth.js publicAccount, фолбэк на login уже на стороне сервера);
 * тип ответа CoopWhoami описывает только login — displayName читаем узким
 * runtime-гвардом (не выдумывая поле), фолбэк — me.login.
 */
export function meBadgeName(me: CoopWhoami | null | undefined): string {
  if (!me) return '';
  const profile = (me as { profile?: unknown }).profile;
  const displayName =
    profile && typeof profile === 'object'
      ? (profile as { displayName?: unknown }).displayName
      : null;
  if (typeof displayName === 'string' && displayName.trim()) return displayName.trim();
  return typeof me.login === 'string' ? me.login : '';
}

'use client';

/**
 * Вкладка «Игроки на поле» дашборда /admin. Живые комнаты и коты с
 * координатами — список читается (GET /admin/players) прямо из комнатного
 * состояния сервера, обновляется сам раз в 5 секунд и после каждой операции.
 *
 * Операции (инлайн-подтверждение вторым кликом, без window.confirm):
 *   - «Сброс на спавн» → POST /admin/players/reset {room, login};
 *   - «Сделать админом» у кота с аккаунтом → POST /admin/players/promote
 *     {login: accountLogin};
 *   - форма «Логин аккаунта» вверху — та же promote для офлайн-игрока.
 *
 * Отказы человекочитаемы: сервер отвечает message, сорца — humanError;
 * тех-тело ответа показываем в деталях.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  httpAdminPlayers,
  httpAdminPlayerReset,
  httpAdminPlayerPromote,
  type AdminFieldRoom,
} from '@/lib/net/http-admin-ops';

const REFRESH_MS = 5000;

type Status = { kind: 'ok' | 'err'; text: string; details?: string } | null;

/** Человекочитаемое пояснение machine reason (паттерн каталога игроков). */
function humanError(reason: string | undefined, fallback: string): string {
  switch (reason) {
    case 'auth_required':
      return 'Нужен вход в аккаунт администратора.';
    case 'forbidden':
      return 'Раздел открыт только администраторам.';
    case 'csrf_origin_required':
    case 'csrf_origin_mismatch':
      return 'Сервер отклонил запрос из соображений безопасности — обновите страницу и попробуйте снова.';
    case 'unknown_room':
      return 'Такой комнаты сейчас нет на сервере.';
    case 'unknown_cat':
      return 'Кота с таким именем в комнате нет.';
    case 'no_free_cell':
      return 'На поле нет свободной клетки спавна.';
    case 'no_such_login':
      return 'Такого аккаунта нет — нужен логин входа, не имя кота на поле.';
    case 'invalid_login':
      return 'Не указано имя кота.';
    case 'invalid':
    case 'json':
      return 'Сервер не понял запрос — обновите страницу и попробуйте снова.';
    case 'unexpected_fields':
      return 'В запросе лишние поля — обновите страницу и попробуйте снова.';
    case 'offline':
      return 'Сервер недоступен — проверьте соединение.';
    default:
      return fallback;
  }
}

/** Спрайт-иконка строки: тот же путь /sprites/<id>.png, что и в игре. */
function spriteUrl(sprite: string): string {
  return `/sprites/${encodeURIComponent(sprite)}.png`;
}

export function PlayersFieldTab() {
  const [rooms, setRooms] = useState<AdminFieldRoom[] | null>(null);
  const [status, setStatus] = useState<Status>(null);
  /** Инлайн-подтверждение: `reset:room/login` | `promote:accountLogin` | `promote-form`. */
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [promoteLogin, setPromoteLogin] = useState('');
  const aliveRef = useRef(true);

  const reload = useCallback(async () => {
    const res = await httpAdminPlayers();
    if (!aliveRef.current) return;
    if (res.ok === true) {
      setRooms(res.rooms);
      return;
    }
    setStatus({
      kind: 'err',
      text: humanError(res.reason, 'Список игроков на поле не загрузился.'),
      details: res.details || undefined,
    });
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void reload();
    const timer = window.setInterval(() => void reload(), REFRESH_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
    };
  }, [reload]);

  const resetCat = useCallback(
    async (room: string, login: string) => {
      const key = `reset:${room}/${login}`;
      setBusy(key);
      const res = await httpAdminPlayerReset(room, login);
      setBusy(null);
      if (res.ok === true) {
        setArmed(null);
        setStatus({ kind: 'ok', text: `Кот «${login}» сброшен на спавн (${res.x}, ${res.y}).` });
        await reload();
        return;
      }
      setStatus({
        kind: 'err',
        text: humanError(res.reason, `Не удалось сбросить «${login}» на спавн.`),
        details: res.details || res.message || undefined,
      });
      await reload();
    },
    [reload],
  );

  const promoteAccount = useCallback(
    async (login: string, armKey: string) => {
      const trimmed = login.trim();
      if (!trimmed) {
        setStatus({ kind: 'err', text: 'Введите логин аккаунта.' });
        return;
      }
      setBusy(armKey);
      const res = await httpAdminPlayerPromote(trimmed);
      setBusy(null);
      if (res.ok === true) {
        setArmed(null);
        if (armKey === 'promote-form') setPromoteLogin('');
        setStatus({ kind: 'ok', text: res.message });
        await reload();
        return;
      }
      setStatus({
        kind: 'err',
        text: humanError(res.reason, res.message || `Не удалось выдать админку «${trimmed}».`),
        details: res.details || res.message || undefined,
      });
      await reload();
    },
    [reload],
  );

  return (
    <div className="flex flex-col gap-3">
      {status ? (
        <div
          className={`rounded-lg border p-3 ${
            status.kind === 'ok' ? 'border-emerald-900/60 bg-emerald-950/40' : 'border-red-900/60 bg-red-950/40'
          }`}
        >
          <p className={`text-sm font-semibold ${status.kind === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>
            {status.text}
          </p>
          {status.details ? (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2 text-[11px] text-red-200">
              {status.details}
            </pre>
          ) : null}
        </div>
      ) : null}

      <section className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
        <p className="text-sm font-bold text-[var(--sim-text)]">Права администратора</p>
        <p className="mt-1 text-[11px] text-[var(--sim-text-soft)]">
          Логин аккаунта (вход в Элизию), не имя кота на поле. Снять права из панели нельзя.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={promoteLogin}
            onChange={(e) => setPromoteLogin(e.target.value)}
            placeholder="логин аккаунта"
            maxLength={24}
            className="h-8 min-w-[10rem] flex-1 rounded-md border border-[var(--sim-line)] bg-black/30 px-2 text-sm text-[var(--sim-text)] outline-none focus:border-[var(--sim-line-strong)]"
            disabled={busy !== null}
          />
          {armed === 'promote-form' ? (
            <span className="flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                className="h-8 border-amber-900/70 bg-amber-950/60 px-2 text-[11px] text-amber-100 hover:bg-amber-900/60"
                disabled={busy !== null}
                onClick={() => void promoteAccount(promoteLogin, 'promote-form')}
              >
                Подтверждаю — сделать админом
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 text-[11px]"
                disabled={busy !== null}
                onClick={() => setArmed(null)}
              >
                Отмена
              </Button>
            </span>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-[11px]"
              disabled={busy !== null || !promoteLogin.trim()}
              onClick={() => setArmed('promote-form')}
            >
              Сделать админом
            </Button>
          )}
        </div>
      </section>

      {rooms === null ? (
        <p className="text-sm text-[var(--sim-text-soft)]">Загружаем занятость поля…</p>
      ) : rooms.length === 0 ? (
        <p className="text-sm text-[var(--sim-text-soft)]">
          Сейчас на поле никого нет — список обновится сам (раз в 5 секунд).
        </p>
      ) : (
        rooms.map((r) => (
          <section key={r.room} className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
            <p className="text-sm font-bold text-[var(--sim-text)]">
              {r.title}{' '}
              <span className="font-normal text-[11px] text-[var(--sim-text-faint)]">
                · комната {r.room} · котов: {r.count}
              </span>
            </p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {r.cats.map((c) => {
                const resetKey = `reset:${r.room}/${c.login}`;
                const promoteKey = c.accountLogin ? `promote:${c.accountLogin}` : null;
                const isResetArmed = armed === resetKey;
                const isPromoteArmed = promoteKey !== null && armed === promoteKey;
                const isBusy = busy === resetKey || (promoteKey !== null && busy === promoteKey);
                return (
                  <li
                    key={c.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--sim-line)] bg-black/20 px-2 py-1.5"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- статические файлы вариантов, не next/image */}
                    <img
                      src={spriteUrl(c.sprite)}
                      alt=""
                      className="h-6 w-6 shrink-0 rounded object-contain"
                      loading="lazy"
                    />
                    <span className="text-sm font-semibold text-[var(--sim-text)]">{c.login}</span>
                    {c.accountRole === 'admin' ? (
                      <span className="rounded border border-amber-800/60 bg-amber-950/40 px-1.5 py-0.5 text-[10px] text-amber-200">
                        админ
                      </span>
                    ) : null}
                    {c.accountLogin && c.accountLogin !== c.login ? (
                      <span className="text-[11px] text-[var(--sim-text-faint)]">акк. {c.accountLogin}</span>
                    ) : null}
                    <span className="text-[11px] text-[var(--sim-text-soft)]">
                      клетка {c.x}, {c.y}
                      {c.fm === 1 && c.fx !== null && c.fy !== null ? ` · точка ${c.fx.toFixed(1)}, ${c.fy.toFixed(1)}` : ''}
                    </span>
                    <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                      {c.accountLogin && c.accountRole !== 'admin' ? (
                        isPromoteArmed ? (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              className="h-7 border-amber-900/70 bg-amber-950/60 px-2 text-[11px] text-amber-100 hover:bg-amber-900/60"
                              disabled={busy !== null}
                              onClick={() => void promoteAccount(c.accountLogin!, promoteKey!)}
                            >
                              Подтверждаю — админ
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 text-[11px]"
                              disabled={busy !== null}
                              onClick={() => setArmed(null)}
                            >
                              Отмена
                            </Button>
                          </>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px]"
                            disabled={busy !== null || isBusy}
                            onClick={() => setArmed(promoteKey)}
                          >
                            Сделать админом
                          </Button>
                        )
                      ) : null}
                      {isResetArmed ? (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            className="h-7 border-red-900/70 bg-red-950/60 px-2 text-[11px] text-red-200 hover:bg-red-900/60"
                            disabled={busy !== null}
                            onClick={() => void resetCat(r.room, c.login)}
                          >
                            Подтверждаю — сбросить на спавн
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px]"
                            disabled={busy !== null}
                            onClick={() => setArmed(null)}
                          >
                            Отмена
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-[11px]"
                          disabled={busy !== null || isBusy}
                          onClick={() => setArmed(resetKey)}
                        >
                          Сброс на спавн
                        </Button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

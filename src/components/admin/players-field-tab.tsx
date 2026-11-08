'use client';

/**
 * Вкладка «Игроки на поле» дашборда /admin (спека: админ-операция «сброс
 * положения игрока на поле»). Живые комнаты и коты с координатами — список
 * читается(GET /admin/players) прямо из комнатного состояния сервера (без
 * копии), обновляется сам раз в 5 секунд и после каждой операции.
 *
 * Операция: кнопка «Сброс на спавн» → инлайн-подтверждение (второй клик),
 * как у деструктивных кнопок конфиг-панели — никакого window.confirm. POST
 * /admin/players/reset {room, login} переносит кота на свежую клетку спавна,
 * кадр EV.MOVE доезжает всем в комнате, персистная точка кота стирается.
 *
 * Отказы человекочитаемы: сервер отвечает message («комнаты нет», «кота
 * нет», «нет свободной клетки спавна»), сорца — принцип каталога игроков
 * (humanError); тех-тело ответа показываем в деталях, обрезки нет.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  httpAdminPlayers,
  httpAdminPlayerReset,
  type AdminFieldRoom,
} from '@/lib/net/http-admin-ops';

const REFRESH_MS = 5000;

type Status = { kind: 'ok' | 'err'; text: string; details?: string } | null;

/** Человекочитаемое пояснение machine reason (паттерн каталога игроков:
 *  primary — понятная строка, technical reason — вторично). */
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
  /** Инлайн-подтверждение конкретной строки «room/login»; отмена — ничего не отправлено. */
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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
      const key = `${room}/${login}`;
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
                const key = `${r.room}/${c.login}`;
                const isArmed = armed === key;
                const isBusy = busy === key;
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
                    <span className="text-[11px] text-[var(--sim-text-soft)]">
                      клетка {c.x}, {c.y}
                      {c.fm === 1 && c.fx !== null && c.fy !== null ? ` · точка ${c.fx.toFixed(1)}, ${c.fy.toFixed(1)}` : ''}
                    </span>
                    {isArmed ? (
                      <span className="ml-auto flex items-center gap-1.5">
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
                      </span>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="ml-auto h-7 text-[11px]"
                        disabled={busy !== null || isBusy}
                        onClick={() => setArmed(key)}
                      >
                        Сброс на спавн
                      </Button>
                    )}
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

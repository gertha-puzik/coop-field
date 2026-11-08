'use client';

/**
 * F2 §3 «Per-room configuration» — панель комнатных настроек (Элизия /admin).
 * Серверная часть — server/room-config.js (роуты /cfg/rooms*, файл
 * DATA_DIR/room-configs.json); фетчеры/типы — src/lib/net/http-cfg.ts.
 *
 * Модель (спека §3): движковые дефолты ← глобальный runtime ← ЯВНЫЙ per-room
 * override. Комната без overrides наследует глобальные; effective считается
 * НА СЕРВЕРЕ (клиент только показывает). Правила честности:
 *   - explicit overrides only — никаких «снимков всего конфига на комнату»;
 *   - new-rooms-only: override вступает при (пере)создании объекта комнаты,
 *     живая атмосфера НЕ ломается (это видно в applyHint каждой строки);
 *   - гейт atmoset («игроки могут крутить сутки») — per-room boolean,
 *     ОТСУТСТВИЕ override = true (default preserves current gameplay);
 *   - бейдж per-key: «переопределено» (amber) / «наследует» (нейтральный).
 *
 * Клиент НЕ источник истины: каждый write валидирует сервер (строгие
 * диапазоны, bool-only гейт, unknown key/room/path traversal → 400), панель
 * только отправляет и показывает ответ. Существующий формат ответа на
 * невалидный atmoset-кадр (молчаливый drop) — не менялся, гейт в atmo.js.
 */

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  fmtNum,
  httpRoomConfig,
  httpRoomHistory,
  httpRoomList,
  httpRoomResetAll,
  httpRoomResetKey,
  httpRoomRestore,
  httpRoomUpdate,
  type CfgFieldMeta,
  type RoomConfigKey,
  type RoomConfigValue,
  type RoomConfigView,
  type RoomListItem,
} from '@/lib/net/http-cfg';

type Status = { kind: 'ok' | 'err'; text: string; details?: string } | null;

/** Селект-шаг диапазона числового ключа комнаты (зеркало rangeOptions дашборда). */
function stepOptions(meta: CfgFieldMeta, base: number): number[] {
  const bounds = meta.values as { min: number; max: number; step: number } | null;
  if (!bounds || !Number.isFinite(bounds.min) || !Number.isFinite(bounds.max)) return [base];
  const out: number[] = [];
  const step = Number.isFinite(bounds.step) && bounds.step > 0 ? bounds.step : 1;
  for (let v = bounds.min; v <= bounds.max + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out.length ? out : [base];
}

const GATE_KEY: RoomConfigKey = 'atmo.allowPlayerAtmosphereControl';

function badge(view: RoomConfigView, key: string): 'overridden' | 'inherited' {
  return view.keys[key]?.state === 'overridden' ? 'overridden' : 'inherited';
}

export function RoomConfigPanel({ registry }: { registry: Record<string, CfgFieldMeta> }) {
  const [rooms, setRooms] = useState<RoomListItem[] | null>(null);
  const [picked, setPicked] = useState('');
  const [view, setView] = useState<RoomConfigView | null>(null);
  const [edits, setEdits] = useState<Partial<Record<RoomConfigKey, RoomConfigValue>>>({});
  const [history, setHistory] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await httpRoomList();
      if (!alive) return;
      if (res.ok && res.rooms) setRooms(res.rooms);
      else setStatus({ kind: 'err', text: 'Не удалось получить список комнат.', details: res.details });
    })();
    return () => {
      alive = false;
    };
  }, []);

  const loadRoom = useCallback(async (id: string, keepEdits = false) => {
    const res = await httpRoomConfig(id);
    if (res.ok && res.room) {
      setView(res.room);
      if (!keepEdits) setEdits({});
    } else {
      setStatus({ kind: 'err', text: `Не удалось прочитать слои комнаты «${id}».`, details: res.details });
    }
  }, []);

  const pickRoom = useCallback(
    async (id: string) => {
      setPicked(id);
      setBusy(true);
      setStatus(null);
      await loadRoom(id);
      const hist = await httpRoomHistory(id);
      setHistory(hist.ok && hist.history ? hist.history : []);
      setBusy(false);
    },
    [loadRoom],
  );

  /** Сохранить override одного ключа (PUT merge): сервер валидирует диапазон/тип. */
  const saveKey = useCallback(
    async (key: RoomConfigKey, value: RoomConfigValue) => {
      if (!picked) return;
      setBusy(true);
      const res = await httpRoomUpdate(picked, { [key]: value } as Record<RoomConfigKey, RoomConfigValue>);
      if (res.ok && res.room) {
        setView(res.room);
        setEdits((prev) => ({ ...prev, [key]: undefined }));
        const meta = registry[key];
        setStatus({
          kind: 'ok',
          text: `${meta ? meta.label : key}: override комнаты применён (${typeof value === 'boolean' ? (value ? 'вкл' : 'выкл') : `${fmtNum(value)}`}). Действует для НОВЫХ комнат этой локации.`,
        });
      } else {
        setStatus({ kind: 'err', text: 'Сервер отклонил override.', details: res.details });
      }
      setBusy(false);
    },
    [picked, registry],
  );

  /** Сброс одного override: комната снова наследует глобальное значение. */
  const resetKey = useCallback(
    async (key: RoomConfigKey) => {
      if (!picked) return;
      setBusy(true);
      const res = await httpRoomResetKey(picked, key);
      if (res.ok && res.room) {
        setView(res.room);
        setEdits((prev) => ({ ...prev, [key]: undefined }));
        setStatus({ kind: 'ok', text: 'Override снят — комната наследует глобальное значение.' });
      } else {
        setStatus({ kind: 'err', text: 'Не удалось снять override.', details: res.details });
      }
      setBusy(false);
    },
    [picked],
  );

  /** Сброс ВСЕХ overrides комнаты — только с модальным подтверждением. */
  const resetAll = useCallback(async () => {
    if (!picked) return;
    const room = view;
    if (!room || !room.hasOverrides) return;
    if (!window.confirm(`Сбросить ВСЕ overrides комнаты «${room.title}» (${room.overrideCount} шт.)? Комната вернётся к глобальным значениям.`)) return;
    setBusy(true);
    const res = await httpRoomResetAll(picked);
    if (res.ok && res.room) {
      setView(res.room);
      setEdits({});
      setStatus({ kind: 'ok', text: 'Все overrides комнаты сняты.' });
    } else {
      setStatus({ kind: 'err', text: 'Не удалось сбросить overrides.', details: res.details });
    }
    setBusy(false);
  }, [picked, view]);

  /** Restore overrides комнаты из бэкапа (сервер валидирует и мигрирует снапшот §4). */
  const restore = useCallback(
    async (name: string) => {
      if (!picked) return;
      if (!window.confirm(`Восстановить overrides комнаты из бэкапа «${name}»? Текущие overrides этой комнаты будут заменены.`)) return;
      setBusy(true);
      const res = await httpRoomRestore(picked, name);
      if (res.ok && res.room) {
        setView(res.room);
        setEdits({});
        setStatus({ kind: 'ok', text: `Overrides восстановлены из «${name}» (снапшот мигрирован на текущую схему).` });
      } else {
        setStatus({ kind: 'err', text: `Восстановление «${name}» не удалось.`, details: res.details });
      }
      setBusy(false);
    },
    [picked],
  );

  if (rooms && !rooms.length) {
    return <p className="mt-3 text-sm text-[var(--sim-text-soft)]">Зарегистрированных комнат нет.</p>;
  }

  return (
    <div className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--sim-text-soft)]">
        <span>Комната:</span>
        {rooms === null ? (
          <span>загружаем каталог…</span>
        ) : (
          <select
            className="h-8 rounded border border-[var(--sim-line)] bg-black/30 px-2 text-xs text-[var(--sim-text)]"
            value={picked}
            disabled={busy}
            onChange={(e) => void pickRoom(e.target.value)}
          >
            <option value="">— выберите комнату —</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title} [{r.mode}]{r.hasOverrides ? ` — overrides: ${r.overrideCount}` : ''}
              </option>
            ))}
          </select>
        )}
        {view && view.hasOverrides ? (
          <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy} onClick={() => void resetAll()}>
            Сбросить всё…
          </Button>
        ) : null}
      </div>

      {status ? (
        <p className={`text-xs ${status.kind === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>
          {status.text}
          {status.details ? <span className="block text-[11px] text-[var(--sim-text-faint)]">Сервер: {status.details}</span> : null}
        </p>
      ) : null}

      {view ? (
        <ul className="space-y-2">
          {view.supportedKeys.map((key) => {
            const meta = registry[key];
            const row = view.keys[key];
            if (!meta || !row) return null;
            const isGate = key === GATE_KEY;
            const isBool = meta.kind === 'bool' || isGate;
            const raw = edits[key];
            const numEdit = typeof raw === 'number' ? raw : null;
            const boolEdit = typeof raw === 'boolean' ? raw : null;
            const candidate: RoomConfigValue | null = isBool ? (boolEdit ?? (typeof row.effective === 'boolean' ? row.effective : null)) : numEdit;
            const changed = candidate !== null && candidate !== row.effective;
            return (
              <li key={key} className="rounded-lg border border-[var(--sim-line)] bg-black/20 p-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-[var(--sim-text)]">{meta.label}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      badge(view, key) === 'overridden' ? 'bg-amber-500/20 text-amber-300' : 'bg-black/30 text-[var(--sim-text-faint)]'
                    }`}
                  >
                    {badge(view, key) === 'overridden' ? `переопределено (${view.overrideCount})` : 'наследует'}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-[var(--sim-text-soft)]">
                  Глобально: {typeof row.global === 'boolean' ? (row.global ? 'вкл' : 'выкл') : `${fmtNum(row.global)} ${meta.unit}`}
                  {row.override === null ? '' : ` · override: ${typeof row.override === 'boolean' ? (row.override ? 'вкл' : 'выкл') : fmtNum(row.override)}`}
                  {' · '}действует: <b>{typeof row.effective === 'boolean' ? (row.effective ? 'вкл' : 'выкл') : `${fmtNum(row.effective)} ${meta.unit}`}</b>
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {isBool ? (
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={typeof candidate === 'boolean' ? candidate : false}
                        disabled={busy}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [key]: e.target.checked }))}
                      />
                      игроки в этой комнате могут крутить atmoset
                    </label>
                  ) : (
                    <select
                      className="h-7 rounded border border-[var(--sim-line)] bg-black/30 px-1.5 text-xs text-[var(--sim-text)]"
                      value={numEdit === null ? '' : String(numEdit)}
                      disabled={busy}
                      onChange={(e) => setEdits((prev) => ({ ...prev, [key]: Number(e.target.value) }))}
                    >
                      <option value="">— как глобально —</option>
                      {stepOptions(meta, row.effective as number).map((v) => (
                        <option key={v} value={v}>
                          {fmtNum(v)} {meta.unit}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 bg-[var(--sim-accent)] px-2 text-[11px] text-black hover:bg-[var(--sim-accent-hover)]"
                    disabled={busy || !changed || candidate === null}
                    onClick={() => candidate !== null && void saveKey(key, candidate)}
                  >
                    Применить override
                  </Button>
                  {badge(view, key) === 'overridden' ? (
                    <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy} onClick={() => void resetKey(key)}>
                      Наследовать
                    </Button>
                  ) : null}
                </div>
                <p className="mt-1 text-[11px] text-[var(--sim-text-faint)]">{row.applyHint || meta.applyHint}</p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-[var(--sim-text-soft)]">Выберите комнату — панель покажет слои значений и её overrides.</p>
      )}

      {picked && history.length ? (
        <div className="rounded-lg border border-[var(--sim-line)] p-2">
          <p className="text-[11px] font-semibold text-[var(--sim-text-soft)]">История бэкапов room-configs ({history.length}):</p>
          <ul className="mt-1 space-y-1">
            {history.map((name, i) => (
              <li key={name} className="flex flex-wrap items-center justify-between gap-2">
                <code className="text-[10px] text-[var(--sim-text-faint)]">{`${i + 1}. ${name}`}</code>
                <Button type="button" size="sm" variant="outline" className="h-6 text-[10px]" disabled={busy} onClick={() => void restore(name)}>
                  Восстановить
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

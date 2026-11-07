'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { readAuthToken } from '@/lib/net/auth';
import { wsUrl } from '@/lib/net/coop';

type Cfg = {
  ok?: boolean;
  atmo?: { phaseMin: number; weatherMin: number };
  apply?: { atmo?: string; hint?: string };
  history?: string[];
  reason?: string;
};

function cfgUrl() {
  try {
    const u = new URL(wsUrl().replace(/^ws/, 'http'));
    u.pathname = '/cfg';
    u.search = '';
    const t = readAuthToken();
    if (t) u.searchParams.set('t', t);
    return u.toString();
  } catch {
    return '';
  }
}

/**
 * Серверный каталог безопасных длин суток/погоды. Не протокол шага и не кривая брони.
 * GET виден всем; POST — только роль admin на сессии.
 */
export function AdminRoomConfig() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [phase, setPhase] = useState('7');
  const [weather, setWeather] = useState('12');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const url = cfgUrl();
    if (!url) return;
    try {
      const res = await fetch(url, { credentials: 'include' });
      const body = (await res.json()) as Cfg;
      setCfg(body);
      if (body.atmo) {
        setPhase(String(body.atmo.phaseMin));
        setWeather(String(body.atmo.weatherMin));
      }
    } catch {
      setMsg('Сервер конфига недоступен.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (body: Record<string, unknown>, confirmText: string) => {
    if (!window.confirm(confirmText)) return;
    const url = cfgUrl();
    if (!url) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as Cfg;
      if (!json.ok) {
        setMsg(
          json.reason === 'auth_required'
            ? 'Сохраняет только админ (роль на сервере, не пароль вкладок).'
            : 'Сервер не принял конфиг.',
        );
        return;
      }
      setCfg(json);
      if (json.atmo) {
        setPhase(String(json.atmo.phaseMin));
        setWeather(String(json.atmo.weatherMin));
      }
      setMsg('Сохранено. Уже открытые комнаты не меняются — только новые. Сейчас играющая комната: ползунок «Сутки».');
    } catch {
      setMsg('Не удалось сохранить.');
    } finally {
      setBusy(false);
    }
  };

  const exportText = JSON.stringify({ atmo: { phaseMin: Number(phase), weatherMin: Number(weather) } }, null, 2);

  return (
    <div className="mb-3 rounded-lg border border-[var(--sim-line-strong)] bg-[var(--sim-inset-soft)] p-2">
      <h4 className="text-xs font-bold text-[var(--sim-text)]">Сервер комнаты</h4>
      <p className="mt-1 text-[11px] leading-snug text-[var(--sim-text-muted)]">
        {cfg?.apply?.hint ||
          'Длительности суток и погоды для новых комнат. Шаг, броня и очередь — устройство игры, их здесь нет.'}
      </p>
      <label className="mt-2 block text-[11px] text-[var(--sim-text-faint)]">
        Часть суток, минуты (1–120)
        <Input
          className="mt-1 h-7 text-xs"
          value={phase}
          onChange={(e) => setPhase(e.target.value)}
        />
      </label>
      <label className="mt-2 block text-[11px] text-[var(--sim-text-faint)]">
        Смена погоды, минуты (2–240)
        <Input
          className="mt-1 h-7 text-xs"
          value={weather}
          onChange={(e) => setWeather(e.target.value)}
        />
      </label>
      <p className="mt-2 text-[10px] text-[var(--sim-text-faint)]">
        После сохранения: <b>новая комната</b>. Текущая — сразу, если крутить сутки в «Общий».
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={busy}
          onClick={() =>
            void post(
              { atmo: { phaseMin: Number(phase), weatherMin: Number(weather) } },
              'Записать длины суток на сервер? Уже открытые комнаты не изменятся.',
            )
          }
        >
          Сохранить на сервер
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={busy}
          onClick={() => {
            try {
              void navigator.clipboard?.writeText(exportText);
              setMsg('JSON скопирован. Вставить можно в поле ниже и сохранить.');
            } catch {
              setMsg(exportText);
            }
          }}
        >
          Экспорт серверного
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="h-7 text-xs"
          disabled={busy}
          onClick={() => void post({ reset: true }, 'Вернуть серверные длины суток к 7 и 12 минутам?')}
        >
          Сброс серверного
        </Button>
      </div>
      {cfg?.history && cfg.history.length > 0 ? (
        <p className="mt-2 text-[10px] text-[var(--sim-text-faint)]">
          История на сервере ({cfg.history.length}): {cfg.history.slice(0, 4).join(', ')}
          {cfg.history.length > 4 ? '…' : ''}
        </p>
      ) : null}
      {msg ? <p className="mt-1 text-[10px] text-[var(--sim-text-soft)]">{msg}</p> : null}
    </div>
  );
}

'use client';

/**
 * Админ-дашборд реестра конфига (/admin) — P4, только elyria-вариант (маршрут
 * вырезается prune-export-ом, инлайн-флаг на случай случайной сборки, спек §2A).
 *
 * Всё через готовый серверный контракт /cfg (замороженные модули не трогаем):
 *   GET  /cfg/admin   — значения + мета 5 ключей + apply-политики + история;
 *   POST /cfg         — применение черновика {atmo, universes} | {reset:true};
 *   POST /cfg/restore {name} — только имя из свежей истории;
 *   GET  /cfg/export  — скачивание значений JSON-файлом;
 *   POST /cfg/import  — загрузка файла, всё-или-ничего; 400 показываем целиком.
 *
 * Доступ: панель рендерится только при role==='admin' (GET /auth/me); не-админ
 * получает вежливую заглушку без раскрытия данных (сервер тоже отдаёт 403).
 * Комнатные конфиги (per-room atmoset и т.п.) сюда НЕ входят — для них нет
 * готового HTTP API, расширяли бы замороженные server-модули.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  httpCfgAdmin,
  httpCfgApply,
  httpCfgExportText,
  httpCfgImportText,
  httpCfgReset,
  httpCfgRestore,
  type CfgAdminSnapshot,
  type CfgFieldMeta,
  type CfgUniversesValues,
} from '@/lib/net/http-cfg';
import { httpMe } from '@/lib/net/http-auth';

const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria';

type UniversesDraft = Record<string, number>;

/** Черновик: значения atmo (по ключу) и дефолты юниверсов (по полю). */
type Draft = { atmo: Record<string, number>; defaults: UniversesDraft };

type Status = { kind: 'ok' | 'err'; text: string; details?: string } | null;

function rangeOptions(def: { min: number; max: number; step: number }): number[] {
  const out: number[] = [];
  const step = def.step > 0 ? def.step : 1;
  for (let v = def.min; v <= def.max + 1e-9; v += step) out.push(Number(v.toFixed(4)));
  if (def.max > def.min && out[out.length - 1] !== def.max) out.push(def.max);
  return out;
}

function draftFromSnapshot(snap: CfgAdminSnapshot): Draft {
  const atmo: Record<string, number> = { ...snap.values.atmo };
  const defaults: UniversesDraft = {};
  for (const [field, val] of Object.entries(snap.values.universes)) defaults[field] = val.default;
  return { atmo, defaults };
}

/** Патч для POST /cfg из черновика: atmo-числа + полные юниверсы-объекты. */
function collectPatch(draft: Draft, snap: CfgAdminSnapshot) {
  const atmo: Record<string, number> = {};
  const universes: Record<string, CfgUniversesValues> = {};
  for (const def of Object.values(snap.registry)) {
    const [section, field] = def.key.split('.');
    if (section === 'atmo') {
      const v = draft.atmo[field];
      if (Number.isFinite(v)) atmo[field] = v;
    } else {
      const kind = def.kind;
      const list = snap.values.universes[field];
      const arr = (list && (list.levels || list.tenths || list.periods)) || [];
      universes[field] = {
        [kind]: arr,
        default: Number.isFinite(draft.defaults[field]) ? draft.defaults[field] : list?.default,
      } as CfgUniversesValues;
    }
  }
  return { atmo, universes };
}

/** Один ключ реестра: подпись, описание, контрол по kind. */
function FieldRow({
  def,
  value,
  listValues,
  onChange,
}: {
  def: CfgFieldMeta;
  value: number;
  listValues: number[];
  onChange: (v: number) => void;
}) {
  const isRange = !Array.isArray(def.values);
  return (
    <div className="rounded-lg border border-[var(--sim-line)] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-[var(--sim-text)]">{def.label}</p>
        <code className="rounded bg-black/30 px-1.5 py-0.5 text-[10px] text-[var(--sim-text-soft)]">{def.key}</code>
      </div>
      <p className="mt-1 text-xs text-[var(--sim-text-soft)]">{def.description}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {isRange ? (
          <select
            className="h-8 rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] px-2 text-sm text-[var(--sim-text)]"
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
          >
            {rangeOptions(def.values as { min: number; max: number; step: number }).map((v) => (
              <option key={v} value={v}>
                {v} {def.unit}
              </option>
            ))}
          </select>
        ) : (
          <select
            className="h-8 rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] px-2 text-sm text-[var(--sim-text)]"
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
          >
            {listValues.map((v) => (
              <option key={v} value={v}>
                {v} {def.unit}
              </option>
            ))}
          </select>
        )}
        <span className="text-[11px] text-[var(--sim-text-faint)]">
          {def.applyHint}
        </span>
      </div>
      {!isRange && listValues.length ? (
        <p className="mt-1 text-[11px] text-[var(--sim-text-faint)]">
          Разрешённый список: {listValues.join(' / ')}
        </p>
      ) : null}
    </div>
  );
}

/* ================================ дашборд ================================ */

export default function CfgDashboard() {
  const [phase, setPhase] = useState<'loading' | 'denied' | 'ready'>('loading');
  const [snap, setSnap] = useState<CfgAdminSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    const res = await httpCfgAdmin();
    if (res.ok && res.snapshot) {
      setSnap(res.snapshot);
      setDraft(draftFromSnapshot(res.snapshot));
      setPhase('ready');
    } else {
      setStatus({ kind: 'err', text: 'Не удалось загрузить панель конфига.', details: res.details || undefined });
      setPhase(res.reason === 'auth_required' ? 'denied' : 'ready');
    }
  }, []);

  useEffect(() => {
    if (!IS_ELYRIA) return;
    let dead = false;
    (async () => {
      const me = await httpMe();
      if (dead) return;
      if (me.ok !== true || me.role !== 'admin') {
        setPhase('denied');
        return;
      }
      const res = await httpCfgAdmin();
      if (dead) return;
      if (res.ok && res.snapshot) {
        setSnap(res.snapshot);
        setDraft(draftFromSnapshot(res.snapshot));
        setPhase('ready');
      } else {
        setStatus({ kind: 'err', text: 'Панель конфига не загрузилась.', details: res.details || undefined });
        setPhase('ready');
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

  const runAction = useCallback(
    async (name: string, go: () => Promise<{ ok: boolean; reason?: string; details?: string }>, okText: string) => {
      setBusy(name);
      const res = await go();
      setBusy(null);
      if (!res.ok) {
        setStatus({ kind: 'err', text: okFailText(name), details: res.details || undefined });
        return;
      }
      setStatus({ kind: 'ok', text: okText });
      await refresh();
    },
    [refresh],
  );

  if (!IS_ELYRIA) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-6 text-[var(--sim-text-soft)]">
        <p>Страница недоступна в этом варианте сайта.</p>
      </main>
    );
  }

  if (phase === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <p className="text-sm text-[var(--sim-text-soft)]">Загружаем панель…</p>
      </main>
    );
  }

  if (phase === 'denied') {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-3 p-6">
        <section className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-6">
          <h1 className="text-lg font-bold text-[var(--sim-text)]">Раздел для администраторов</h1>
          <p className="mt-2 text-sm text-[var(--sim-text-soft)]">
            Панель настроек открыта только администраторам площадки. Если вы админ — войдите
            в свой аккаунт и вернитесь сюда.
          </p>
          <a className="mt-3 inline-block text-sm text-[var(--sim-text-soft)] underline-offset-2 hover:underline" href="/">
            ← Главное меню
          </a>
        </section>
      </main>
    );
  }

  const apply = () => {
    if (!snap || !draft) return;
    void runAction('apply', () => httpCfgApply(collectPatch(draft, snap)), 'Черновик применён.');
  };
  const reset = () => {
    if (!window.confirm('Сбросить ВСЕ параметры реестра на дефолты?')) return;
    void runAction('reset', httpCfgReset, 'Значения сброшены на дефолты.');
  };
  const restore = (name: string) => {
    void runAction(name, () => httpCfgRestore(name), `Бэкап «${name}» восстановлен.`);
  };
  const doExport = async () => {
    setBusy('export');
    const res = await httpCfgExportText();
    setBusy(null);
    if (!res.ok) {
      setStatus({ kind: 'err', text: 'Экспорт не удался.', details: res.text || undefined });
      return;
    }
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const blob = new Blob([res.text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wanderpaws-cfg-${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus({ kind: 'ok', text: 'Экспорт скачан файлом.' });
    } catch {
      setStatus({ kind: 'err', text: 'Браузер не дал скачать файл.' });
    }
  };
  const onImportFile = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    if (!text.trim()) {
      setStatus({ kind: 'err', text: 'Файл пустой — импорт ничего не сделает.' });
      return;
    }
    await runAction('import', () => httpCfgImportText(text), 'Импорт применён.');
    ev.target.value = '';
  };

  const registryKeys = snap ? Object.keys(snap.registry) : [];

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex items-baseline justify-between gap-3">
        <h1 className="text-xl font-bold text-[var(--sim-text)]">Панель конфига</h1>
        <a className="text-sm text-[var(--sim-text-soft)] underline-offset-2 hover:underline" href="/">
          ← Главное меню
        </a>
      </header>

      {status ? (
        <div
          className={`rounded-lg border p-3 ${
            status.kind === 'ok'
              ? 'border-emerald-900/60 bg-emerald-950/40'
              : 'border-red-900/60 bg-red-950/40'
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

      {snap && draft ? (
        <>
          <section className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
            <p className="text-xs text-[var(--sim-text-faint)]">
              Схема v{snap.v} · {registryKeys.length} ключей реестра · хранится {snap.historyKeep} последних бэкапов.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-3">
              {registryKeys.map((key) => {
                const def = snap.registry[key];
                const [section, field] = def.key.split('.');
                const value =
                  section === 'atmo' ? draft.atmo[field] : draft.defaults[field];
                const listValues =
                  section === 'universes'
                    ? snap.values.universes[field]?.levels ||
                      snap.values.universes[field]?.tenths ||
                      snap.values.universes[field]?.periods ||
                      []
                    : [];
                return (
                  <FieldRow
                    key={key}
                    def={def}
                    value={value}
                    listValues={listValues}
                    onChange={(v) =>
                      setDraft((prev) => {
                        if (!prev) return prev;
                        if (section === 'atmo') return { ...prev, atmo: { ...prev.atmo, [field]: v } };
                        return { ...prev, defaults: { ...prev.defaults, [field]: v } };
                      })
                    }
                  />
                );
              })}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                className="h-8 bg-[var(--sim-accent)] text-xs text-black hover:bg-[var(--sim-accent-hover)]"
                disabled={busy !== null}
                onClick={apply}
              >
                {busy === 'apply' ? 'Применяем…' : 'Применить'}
              </Button>
              <Button type="button" size="sm" variant="outline" className="h-8 text-xs" disabled={busy !== null} onClick={reset}>
                Сбросить на дефолты
              </Button>
            </div>
          </section>

          <section className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
            <h2 className="text-base font-bold text-[var(--sim-text)]">Перенос значений</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" className="h-8 text-xs" disabled={busy !== null} onClick={() => void doExport()}>
                Экспорт (JSON-файл)
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                disabled={busy !== null}
                onClick={() => fileRef.current?.click()}
              >
                Импорт из файла…
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(ev) => void onImportFile(ev)}
              />
            </div>
            <p className="mt-2 text-[11px] text-[var(--sim-text-faint)]">
              Импорт применяется целиком или не применяется вовсе; ответ сервера при ошибке
              показывается полностью.
            </p>
          </section>

          <section className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
            <h2 className="text-base font-bold text-[var(--sim-text)]">История бэкапов</h2>
            {snap.history.length ? (
              <ul className="mt-2 space-y-2">
                {snap.history.map((name, i) => (
                  <li key={name} className="flex flex-wrap items-center justify-between gap-2">
                    <code className="rounded bg-black/30 px-1.5 py-0.5 text-[11px] text-[var(--sim-text-soft)]">
                      {i + 1}. {name}
                    </code>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px]"
                      disabled={busy !== null}
                      onClick={() => restore(name)}
                    >
                      Восстановить
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-[var(--sim-text-soft)]">
                Бэкапов ещё нет — они появляются при первом изменении конфига.
              </p>
            )}
          </section>
        </>
      ) : (
        <p className="text-sm text-[var(--sim-text-soft)]">
          Панель не загрузилась. Обновите страницу или проверьте права администратора.
        </p>
      )}
    </main>
  );
}

/** Короткая надпись об ошибке действия: 400 unknown_keys/invalid видны в details. */
function okFailText(name: string): string {
  switch (name) {
    case 'apply':
      return 'Применить не удалось — сервер отклонил черновик.';
    case 'reset':
      return 'Сброс не удался.';
    case 'import':
      return 'Импорт отклонён (всё-или-ничего).';
    default:
      return `Восстановление «${name}» не удалось.`;
  }
}

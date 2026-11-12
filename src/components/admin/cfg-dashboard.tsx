'use client';

/**
 * Админ-дашборд реестра конфига (/admin) — P4 + волна B2 (спек §4), только
 * elyria-вариант (маршрут вырезается prune-export-ом, инлайн-флаг на случай
 * случайной сборки, спек §2A).
 *
 * Всё через готовый серверный контракт /cfg (замороженные модули не трогаем):
 *   GET  /cfg/admin   — значения + мета 5 ключей (подписи/юниверсы/политики) + история;
 *   POST /cfg         — применение черновика {atmo, universes} | {reset:true};
 *   POST /cfg/restore {name} — только имя из свежей истории;
 *   GET  /cfg/export  — скачивание значений JSON-файлом;
 *   POST /cfg/import  — загрузка файла, всё-или-ничего; 400 показываем целиком.
 *
 * B2 — полноценное управление СПИСКАМИ разрешённых значений (не только дефолты):
 *   - редактор списков — чекбоксы по движковому юнису из меты (registry.values,
 *     KIND-юниверсы levels/tenths/periods сервер знает; формат WS-протокола и
 *     правила авторизации — НЕ конфиг, тут их нет);
 *   - «выбор игроками вкл/выкл» (F2 §4) — ЯВНЫЙ флаг playerSelectable в том же
 *     POST /cfg: выключение НЕ режет allowedValues (не «в никуда»), повторное
 *     включение возвращает кураторский список, а не весь движковый юниверс;
 *     миграция старых файлов — вывод флага из длины списка (read-time);
 *   - дефолт обязан входить в список: сервер валидирует (400), UI не даёт
 *     сохранить иначе (кнопка заблокирована + подсказка у поля);
 *   - предпросмотр диффов «было → станет» (+N/−M) до отправки; сужение списка
 *     (у игроков значение сснапится) — дополнительное предупреждение и вторая
 *     кнопка подтверждения; отмена = ничего не отправлено;
 *   - честные статусы применения по applyPolicy: «применено немедленно» — только
 *     on-next-event; new-room/new-session НЕ показываются как «применено»
 *     (спек §4.6);
 *   - «Комнатные настройки» (F2 §3) — per-room контрак ЕСТЬ (server/room-config.js,
 *     /cfg/rooms*): панель вынесена в room-config-panel.tsx (этот файл держим
 *     под лимитом 800 строк); слои движок ← глобал ← комната, override только
 *     явный, applyHint new-rooms-only честно, гейт atmoset per-room.
 *
 * Доступ: панель рендерится только при role==='admin' (GET /auth/me); не-админ
 * получает вежливую заглушку без раскрытия данных (сервер тоже отдаёт 403).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  buildCfgDiff as buildDiff,
  canonByKind,
  cfgPatchFromDraft,
  curveIssue,
  draftFromSnapshot,
  httpCfgAdmin,
  httpCfgApply,
  httpCfgExportText,
  httpCfgImportText,
  httpCfgReset,
  httpCfgRestore,
  listIssue,
  successText,
  type CfgAdminSnapshot,
  type CfgDraft,
  type CfgFieldMeta,
} from '@/lib/net/http-cfg';
import { httpMe } from '@/lib/net/http-auth';
// Пересводка W2 (2026-11-08): навигацию и сессию панели несёт общая шапка
// сайта (SiteHeader над оболочкой: ссылки, бейдж входа, тема — в ней).
import { SiteHeader } from '@/components/site/site-header';

// Строки-редакторы полей (Range/Bool/List + каркас) — вынесены в
// cfg-fields.tsx: дашборд держим под лимитом 800 строк (как players-field-tab).
import { RoomConfigPanel } from './room-config-panel';
import { BoolFieldRow, ListFieldRow, RangeFieldRow } from './cfg-fields';
// Вкладка «Игроки на поле»: список живых комнат/котов и сброс положения —
// вынесена в отдельный файл, дашборд держим под лимитом 800 строк (W4).
import { PlayersFieldTab } from './players-field-tab';
// Вкладка «Броня» (мандат владелицы 2026-11-08): редактор кривой защиты
// combat.armorCurve + предпросмотр «было → станет» — общие сателлиты.
import { ArmorTab } from './armor-tab';
import { ApplyPreview } from './cfg-apply-preview';
// Вкладка «Спрайты» (мандат владелицы 2026-11-08): менеджер скинов —
// загрузка/удаление/категории, динамический каталог сервера.
import { SpritesTab } from './sprites-tab';
import { TexturesTab } from './textures-tab';
// Пересводка W2 (2026-11-08): ThemeSelect из шапки панели убран — селект темы
// несёт общая шапка сайта (SiteHeader), дублей быть не должно.
// Оболочка панели (ночь + звёзды + стеклянный сайд-меню из дескрипторов вкладок)
// вынесена в dash-shell.tsx; компакт-селект темы — site-компонент.
import { DashShell, type DashTab } from './dash-shell';

const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria';

/* Логика черновика (типы, канонизация, диффы, статусы) — в http-cfg.ts (B2);
 * здесь только локальные алиасы и React-обёртки. */
type Draft = CfgDraft;
type FieldDiff = ReturnType<typeof buildDiff>[number];

type Status = { kind: 'ok' | 'err'; text: string; details?: string } | null;

/* ========================= Персист активной вкладки ======================== */

/** Ключ активной вкладки панели в localStorage — тот же API, что тема
 *  оформления (THEME_KEY/loadTheme из lib/sim/theme.ts: window-guard,
 *  валидация по списку id, тихий фолбэк). Третья дельта 2026-11-08:
 *  «пункт, который мы смотрели», сохраняется между визитами. */
const TAB_KEY = 'elyria-admin-tab';
const TAB_IDS = ['cfg', 'field', 'armor', 'sprites', 'textures'] as const;
const TAB_DEFAULT: (typeof TAB_IDS)[number] = 'cfg';

/** Сохранённая вкладка: мусор/чужой id/недоступное хранилище → дефолт 'cfg'. */
function readSavedTab(): (typeof TAB_IDS)[number] {
  if (typeof window === 'undefined') return TAB_DEFAULT;
  try {
    const raw = localStorage.getItem(TAB_KEY) as (typeof TAB_IDS)[number] | null;
    return raw && TAB_IDS.includes(raw) ? raw : TAB_DEFAULT;
  } catch {
    return TAB_DEFAULT;
  }
}

/* ================================ дашборд ================================ */

export default function CfgDashboard() {
  const [phase, setPhase] = useState<'loading' | 'denied' | 'ready'>('loading');
  /** Активная вкладка (id из массива дескрипторов tabs ниже: конфиг, «Игроки
   *  на поле», «Броня», «Спрайты» — все волны кладут вкладку в массив).
   *  Стартует с дефолта 'cfg' (SSR/export и первый рендер совпадают — без
   *  hydration-варнингов), эффектом подхватывает сохранённую вкладку, если
   *  она есть (мусор/чужой id в хранилище → дефолт); переход на сохранённую
   *  'field' поведением не отличается от ручного клика — вкладка просто
   *  рендерится. */
  const [tab, setTabState] = useState<(typeof TAB_IDS)[number]>(TAB_DEFAULT);
  useEffect(() => {
    setTabState(readSavedTab());
  }, []);

  /** Единственный переключатель вкладок: сначала localStorage, затем state —
   *  старт на сохранённой и ручной клик идут одним путём. ОБЯЗАТЕЛЬНО выше
   *  условных return ниже: ранний выход loading/denied между рендерами менял
   *  число вызванных хуков и валил панель React #310 (owner report: пустой
   *  /admin/ вместо интерфейса, 2026-11-08). */
  const pickTab = useCallback((id: string) => {
    if (!TAB_IDS.includes(id as (typeof TAB_IDS)[number])) return;
    try {
      localStorage.setItem(TAB_KEY, id);
    } catch {
      /* приватный режим/квота — переключаем и без персиста */
    }
    setTabState(id as (typeof TAB_IDS)[number]);
  }, []);
  const [snap, setSnap] = useState<CfgAdminSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Предпросмотр «было → станет», ждёт второго подтверждения (Отмена = ничего не отправлено). */
  const [pending, setPending] = useState<FieldDiff[] | null>(null);
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

  /** Любая правка черновика протухивает открытый предпросмотр: подтверждение
   * всегда сверяется со свежим диффом, панель закрывается при изменениях. */
  useEffect(() => {
    setPending(null);
  }, [draft]);

  const runAction = useCallback(
    async (name: string, go: () => Promise<{ ok: boolean; reason?: string; details?: string }>, okText: string) => {
      setPending(null); // любая завершённая операция устаряет висящий предпросмотр
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

  /* ---------- черновик списков (§4.2) ---------- */

  /** Поставить/снять значение: список черновика канонизируется как на сервере. */
  const toggleValue = useCallback((field: string, kind: string, v: number, on: boolean) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const c = canonByKind(kind, v);
      const cur = prev.lists[field] || [];
      const next = (on ? [...cur, c] : cur.filter((x) => x !== c)).sort((a, b) => a - b);
      return { ...prev, lists: { ...prev.lists, [field]: next } };
    });
  }, []);

  /** Вкл/выкл выбора игроками (F2 §4): флипает ТОЛЬКО явный флаг
   * playerSelectable черновика. Список allowedValues не мутируется
   * «в никуда»: он живёт и в черновике, и на сервере; повторное
   * включение показывает прежний кураторский список, а не юниверс. */
  const toggleChoice = useCallback((field: string, _def: CfgFieldMeta, on: boolean) => {
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, selectable: { ...prev.selectable, [field]: on } };
    });
  }, []);

  /** Валидность черновика: все списки непустые, дефолты внутри списков,
   *  кривые points — без ошибок (curveIssue: счёт, границы, сортировка). */
  const hasListIssues = useMemo(() => {
    if (!snap || !draft) return false;
    for (const def of Object.values(snap.registry)) {
      const [sec, field] = def.key.split('.');
      if (sec === 'universes' && listIssue(draft.lists[field] || [], draft.defaults[field])) return true;
      if (def.kind === 'points' && curveIssue(draft.points[field], def)) return true;
    }
    return false;
  }, [snap, draft]);

  /** Черновик кривой брони (вкладка «Броня»): строки уже канонизированы
   *  редактором (сортировка/2 знака), финальную валидацию делает сервер. */
  const setPoints = useCallback((field: string, pts: number[][]) => {
    setDraft((prev) => (prev ? { ...prev, points: { ...prev.points, [field]: pts } } : prev));
  }, []);

  /** Шаг 1 применения: собрать диф «было → станет» и показать предпросмотр —
   * НИЧЕГО не отправлять до второго подтверждения (§4.5). */
  const requestApply = useCallback(() => {
    if (!snap || !draft) return;
    if (hasListIssues) {
      setStatus({ kind: 'err', text: 'Черновик содержит ошибки полей (пустой список / дефолт вне списка / кривая брони) — исправьте подсвеченное.' });
      return;
    }
    const diff = buildDiff(snap, draft);
    if (!diff.length) {
      setStatus({ kind: 'ok', text: 'Отличий от сервера нет — применять нечего.' });
      return;
    }
    setStatus(null);
    setPending(diff);
  }, [snap, draft, hasListIssues]);

  /** Шаг 2: подтверждение отправляет POST /cfg. Дифф пересобирается на момент
   * клика (черновик могли менять при открытом предпросмотре), статус — честный
   * по applyPolicy актуальных изменений. */
  const confirmApply = useCallback(() => {
    if (!snap || !draft) return;
    if (hasListIssues) {
      setStatus({ kind: 'err', text: 'Черновик содержит ошибки полей (пустой список / дефолт вне списка / кривая брони) — исправьте подсвеченное.' });
      return;
    }
    const diff = buildDiff(snap, draft);
    if (!diff.length) {
      setStatus({ kind: 'ok', text: 'Отличий от сервера нет — применять нечего.' });
      return;
    }
    const okText = successText(diff);
    void runAction('apply', () => httpCfgApply(cfgPatchFromDraft(draft, snap)), okText);
  }, [snap, draft, hasListIssues, runAction]);

  if (!IS_ELYRIA) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-6 text-[var(--sim-text-soft)]">
        <p>Страница недоступна в этом варианте сайта.</p>
      </main>
    );
  }

  if (phase === 'loading') {
    return (
      <>
        <SiteHeader />
        <main className="flex min-h-screen items-center justify-center p-6">
          <p className="text-sm text-[var(--sim-text-soft)]">Загружаем панель…</p>
        </main>
      </>
    );
  }

  if (phase === 'denied') {
    return (
      <>
        <SiteHeader />
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
      </>
    );
  }

  const reset = () => {
    if (!window.confirm('Сбросить ВСЕ настройки к исходным значениям?')) return;
    void runAction('reset', httpCfgReset, 'Значения сброшены к исходным.');
  };
  const restore = (name: string) => {
    void runAction(name, () => httpCfgRestore(name), `Резервная копия «${name}» восстановлена.`);
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
    await runAction('import', () => httpCfgImportText(text), 'Импорт принят — значения заменены.');
    ev.target.value = '';
  };

  const registryKeys = snap ? Object.keys(snap.registry) : [];

  /* Вкладка «Конфиг»: главный редактор реестра (секция «Комнатные настройки»
   * остаётся внутри, как раньше) + перенос значений + история бэкапов.
   * Содержимое вкладки НЕ менялось — менялась только оболочка навигации. */
  const renderCfg = () =>
    snap && draft ? (
      <>
          <section className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
            <div className="grid grid-cols-1 gap-3">
              {registryKeys.map((key) => {
                const def = snap.registry[key];
                const [section, field] = def.key.split('.');
                if (section === 'combat') {
                  // Кривая брони живёт на своей вкладке «Броня» (мандат 2026-11-08).
                  return null;
                }
                if (section === 'atmo' && def.kind === 'bool' && def.scope === 'room') {
                  // Per-room гейт настраивается в «Комнатных настройках» ниже;
                  // здесь общего контроля у него нет (scope room).
                  return null;
                }
                if (section === 'atmo' && def.kind === 'bool') {
                  // Глобальный bool (master-гейт atmoset, мандат владелицы
                  // 2026-11-08): селект «Разрешено/Запрещено», черновик 1/0.
                  return (
                    <BoolFieldRow
                      key={key}
                      def={def}
                      value={Number.isFinite(draft.atmo[field]) ? draft.atmo[field] : def.default ? 1 : 0}
                      saved={Number.isFinite(snap.values.atmo[field]) ? snap.values.atmo[field] : def.default ? 1 : 0}
                      onChange={(v) =>
                        setDraft((prev) => (prev ? { ...prev, atmo: { ...prev.atmo, [field]: v } } : prev))
                      }
                    />
                  );
                }
                if (section === 'atmo') {
                  return (
                    <RangeFieldRow
                      key={key}
                      def={def}
                      value={draft.atmo[field]}
                      saved={snap.values.atmo[field]}
                      onChange={(v) =>
                        setDraft((prev) => (prev ? { ...prev, atmo: { ...prev.atmo, [field]: v } } : prev))
                      }
                    />
                  );
                }
                const stored = snap.values.universes[field];
                const storedList = stored?.levels || stored?.tenths || stored?.periods || [];
                const savedChoice =
                  typeof stored?.playerSelectable === 'boolean' ? stored.playerSelectable : storedList.length > 1;
                return (
                  <ListFieldRow
                    key={key}
                    def={def}
                    list={draft.lists[field] || []}
                    saved={{ list: storedList, def: stored?.default ?? 0 }}
                    savedChoice={savedChoice}
                    draftDefault={draft.defaults[field]}
                    universe={Array.isArray(def.values) ? def.values : []}
                    choiceOn={draft.selectable[field] ?? savedChoice}
                    onToggleValue={(v, on) => toggleValue(field, def.kind, v, on)}
                    onToggleChoice={(on) => toggleChoice(field, def, on)}
                    onDefault={(v) =>
                      setDraft((prev) => (prev ? { ...prev, defaults: { ...prev.defaults, [field]: v } } : prev))
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
                disabled={busy !== null || hasListIssues}
                onClick={requestApply}
              >
                Проверить и применить…
              </Button>
              <Button type="button" size="sm" variant="outline" className="h-8 text-xs" disabled={busy !== null} onClick={reset}>
                Сбросить на дефолты
              </Button>
            </div>
            {hasListIssues ? (
              <p className="mt-1 text-[11px] text-red-300">
                Применение заблокировано: заполните ошибки в полях выше (пустой список / дефолт вне списка).
              </p>
            ) : null}
          </section>

          <section className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
            <h2 className="text-base font-bold text-[var(--sim-text)]">Комнатные настройки</h2>
            <p className="mt-2 text-xs text-[var(--sim-text-faint)]">
              Настройка комнаты переопределяет общие значения; вступает в силу для новых комнат.
            </p>
            <RoomConfigPanel registry={snap.registry} />
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
          </section>

          <section className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
            <h2 className="text-base font-bold text-[var(--sim-text)]">История резервных копий</h2>
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
                Резервных копий ещё нет — они появляются при первом изменении настроек.
              </p>
            )}
          </section>
        </>
      ) : (
        <p className="text-sm text-[var(--sim-text-soft)]">
          Панель не загрузилась. Обновите страницу или проверьте права администратора.
        </p>
      );

  /* Дескрипторы вкладок панели — источник сайд-меню и контента. Все волны
   * сведены (2026-11-08): «Броня» (кривая защиты) и «Спрайты» (менеджер
   * скинов) — live-рендеры, рендер Брони гаснет без снапшота реестра. */
  const tabs: DashTab[] = [
    { id: 'field', title: 'Игроки на поле', render: () => <PlayersFieldTab /> },
    { id: 'cfg', title: 'Конфиг', render: renderCfg },
    {
      id: 'armor',
      title: 'Броня',
      render: () =>
        snap && draft && snap.registry['combat.armorCurve'] ? (
          <ArmorTab
            snap={snap}
            meta={snap.registry['combat.armorCurve']}
            points={draft.points.armorCurve || []}
            issue={curveIssue(draft.points.armorCurve, snap.registry['combat.armorCurve'])}
            busy={busy}
            onPoints={(pts) => setPoints('armorCurve', pts)}
            onApply={requestApply}
          />
        ) : null,
    },
    { id: 'sprites', title: 'Спрайты', render: () => <SpritesTab /> },
    { id: 'textures', title: 'Текстуры', render: () => <TexturesTab /> },
  ];

  const activeTab = tabs.find((t) => t.id === tab) ?? null;

  return (
    <>
      {/* Пересводка W2 (2026-11-08): общая шапка сайта над оболочкой панели;
          сайд-меню и вкладки — как были (дельта 3: вкладка персистится). */}
      <SiteHeader />
      <DashShell
        tabs={tabs}
        active={tab}
        onPick={pickTab}
        title="Панель управления"
        headerExtra={
        <>
          <span className="rounded-full border border-[rgba(226,220,255,0.28)] bg-[rgba(10,14,32,0.62)] px-2.5 py-0.5 text-[11px] text-[#efe7ff]">
            роль: админ
          </span>
          <a className="text-sm text-[var(--sim-text-soft)] underline-offset-2 hover:underline" href="/">
            ← Главное меню
          </a>
        </>
      }
      notice={
        status ? (
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
        ) : null
      }
    >
      {/* Предпросмотр «было → станет» — общий над контентом вкладки: apply-кнопки
       *  «Конфига» и «Брони» открывают его, отправка — только вторым шагом. */}
      {pending && snap && draft ? (
        <ApplyPreview pending={pending} busy={busy} onConfirm={confirmApply} onCancel={() => setPending(null)} />
      ) : null}
      {activeTab?.render ? activeTab.render() : null}
      </DashShell>
    </>
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

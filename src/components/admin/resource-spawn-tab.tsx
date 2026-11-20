'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { consoleError, consoleRequest } from '@/lib/net/http-console';
import s from './admin-console.module.css';
import layout from './resource-spawn.module.css';

type Schedule = { mode: 'interval'; minutes: number } | { mode: 'random'; min: number; max: number } |
  { mode: 'daily'; times: string[] };
type Rule = {
  id: string; name: string; enabled: boolean; schedule: Schedule; min: number; max: number;
  locations: number[]; items: { itemId: string; weight: number }[]; next: number | null;
};
type SpawnLog = {
  id: string; at: number; locationId: number; source: 'manual' | 'scheduled';
  ruleName: string; requested: number; reason: string; items: { itemId: string; name: string; count: number }[];
};
type Overview = {
  rules: Rule[]; limits: Record<number, number>; log: SpawnLog[]; defaultLimit: number; maxLimit: number;
  locations: { id: number; name: string; zoneName: string }[]; items: { id: string; name: string }[];
};
const createDraft = (): Rule => ({
  id: '', name: '', enabled: false, schedule: { mode: 'interval', minutes: 15 }, min: 3, max: 10,
  locations: [], items: [], next: null,
});
const moscow = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow',
});
const reasons: Record<string, string> = {
  limit: 'Достигнут лимит локации', no_items: 'Нет доступных предметов',
  no_space: 'Нет свободных точек', map_unavailable: 'Карта недоступна',
};

export function ResourceSpawnTab() {
  const [data, setData] = useState<Overview | null>(null);
  const [draft, setDraft] = useState<Rule>(createDraft);
  const [hours, setHours] = useState('09:00, 18:00');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);

  async function refresh() {
    const result = await consoleRequest<Overview>('/resource-spawn');
    if (result.ok) { setData(result); setError(''); }
    else setError(consoleError(result.reason));
  }
  useEffect(() => { void refresh(); }, []);

  function edit(rule: Rule) {
    setDraft(structuredClone(rule));
    setHours(rule.schedule.mode === 'daily' ? rule.schedule.times.join(', ') : '09:00, 18:00');
    setArmed(false);
  }
  async function mutate(body: unknown, success: string) {
    if (busy) return false;
    setBusy(true);
    setError('');
    setNote('');
    const result = await consoleRequest<Overview>('/resource-spawn', 'POST', body);
    setBusy(false);
    if (!result.ok) {
      setError(result.reason === 'invalid_spawn'
        ? 'Проверьте диапазоны, часы, предметы и локации. Нужен хотя бы один предмет с ненулевым весом.'
        : consoleError(result.reason));
      return false;
    }
    setData(result);
    setNote(success);
    return true;
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const schedule = draft.schedule.mode === 'daily'
      ? { mode: 'daily', times: hours.split(/[\s,;]+/).filter(Boolean) }
      : draft.schedule;
    if (await mutate({ action: 'save', id: draft.id || undefined, rule: { ...draft, schedule } }, 'Правило сохранено.')) {
      edit(createDraft());
    }
  }

  if (!data) return (
    <section className={s.panel}>
      <h2>Спавн предметов</h2>
      {error ? <><p role="alert">{error}</p><button type="button" onClick={() => void refresh()}>Повторить</button></> : 'Загрузка…'}
    </section>
  );
  const locationName = (id: number) => data.locations.find(place => place.id === id)?.name ?? `Локация ${id}`;
  const known = new Set(data.items.map(item => item.id));
  const chosen = new Map(draft.items.map(row => [row.itemId, row.weight]));
  const totalWeight = draft.items.reduce((sum, row) => sum + (known.has(row.itemId) ? row.weight : 0), 0);
  const schedule = draft.schedule;
  return (
    <div className={s.stack}>
      {error && <p className={s.error} role="alert">{error}</p>}
      {note && <p role="status">{note}</p>}
      <section className={s.panel}>
        <h2>Правила спавна</h2>
        <p className={s.muted}>Все часы и записи журнала указаны по Москве.</p>
        <ul className={layout.rules}>
          {data.rules.map(rule => (
            <li key={rule.id}>
              <div>
                <strong>{rule.name}</strong>
                <div className={s.muted}>{rule.locations.map(locationName).join(', ')} · {rule.min}–{rule.max} шт.</div>
                <div className={s.muted}>{rule.next ? `Следующий спавн ${moscow.format(rule.next)}` : 'Расписание выключено'}</div>
              </div>
              <div className={s.actions}>
                <button type="button" disabled={busy} onClick={() => edit(rule)}>Редактировать</button>
                <button type="button" disabled={busy} onClick={() => void mutate({ action:'force', id: rule.id }, 'Ручной спавн выполнен. Результат в журнале.')}>Принудительный спавн</button>
              </div>
            </li>
          ))}
        </ul>
        <form className={s.stack} onSubmit={event => void save(event)}>
          <h3>{draft.id ? 'Редактирование правила' : 'Новое правило'}</h3>
          <div className={layout.fields}>
            <label>Название<input required maxLength={80} value={draft.name} onChange={e => setDraft({ ...draft, name:e.target.value })}/></label>
            <label>Минимум за запуск<input type="number" required min={1} max={data.maxLimit} value={draft.min} onChange={e => setDraft({ ...draft, min:Number(e.target.value) })}/></label>
            <label>Максимум за запуск<input type="number" required min={draft.min} max={data.maxLimit} value={draft.max} onChange={e => setDraft({ ...draft, max:Number(e.target.value) })}/></label>
            <label>Расписание<select value={schedule.mode} onChange={e => setDraft({ ...draft, schedule:
              e.target.value === 'daily' ? { mode:'daily', times:[] } : e.target.value === 'random'
                ? { mode:'random', min:10, max:20 } : { mode:'interval', minutes:15 },
            })}>
              <option value="interval">Через фиксированный интервал</option>
              <option value="random">Через случайный интервал</option>
              <option value="daily">Ежедневно в назначенные часы</option>
            </select></label>
            {schedule.mode === 'interval' && <label>Интервал, мин<input required type="number" min={1} max={10080} value={schedule.minutes} onChange={e => setDraft({ ...draft, schedule:{ ...schedule, minutes:Number(e.target.value) } })}/></label>}
            {schedule.mode === 'random' && <>
              <label>От, мин<input required type="number" min={1} max={10080} value={schedule.min} onChange={e => setDraft({ ...draft, schedule:{ ...schedule, min:Number(e.target.value) } })}/></label>
              <label>До, мин<input required type="number" min={schedule.min} max={10080} value={schedule.max} onChange={e => setDraft({ ...draft, schedule:{ ...schedule, max:Number(e.target.value) } })}/></label>
            </>}
            {schedule.mode === 'daily' && <label>Часы по Москве через запятую<input required value={hours} placeholder="09:00, 18:00" onChange={e => setHours(e.target.value)}/></label>}
          </div>
          <label className={layout.check}><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled:e.target.checked })}/>Включить расписание</label>
          <fieldset className={layout.choices}>
            <legend>Локации</legend>
            {data.locations.map(place => <label className={layout.check} key={place.id}>
              <input type="checkbox" checked={draft.locations.includes(place.id)} onChange={e => setDraft({
                ...draft, locations:e.target.checked ? [...draft.locations, place.id] : draft.locations.filter(id => id !== place.id),
              })}/>{place.zoneName} · {place.name}
            </label>)}
          </fieldset>
          <fieldset className={layout.choices}>
            <legend>Предметы и вес шанса</legend>
            <p className={s.muted}>Шанс определяется долей веса. Например, веса 1 и 3 дают 25% и 75% на один предмет в партии.</p>
            <input type="search" aria-label="Найти предмет" placeholder="Найти предмет" value={query} onChange={e => setQuery(e.target.value)}/>
            <div className={layout.itemList}>
              {data.items.filter(item => chosen.has(item.id) || item.name.toLowerCase().includes(query.toLowerCase())).map(item => {
                const weight = chosen.get(item.id);
                return <div className={layout.item} key={item.id}>
                  <label className={layout.check}><input type="checkbox" checked={weight !== undefined}
                    onChange={e => setDraft({ ...draft, items:e.target.checked
                      ? [...draft.items, { itemId:item.id, weight:100 }] : draft.items.filter(row => row.itemId !== item.id) })}/>{item.name}</label>
                  {weight !== undefined && <>
                    <input type="number" min={0} max={1000} required aria-label={`Вес шанса: ${item.name}`} value={weight}
                      onChange={e => setDraft({ ...draft, items:draft.items.map(row => row.itemId === item.id
                        ? { ...row, weight:Number(e.target.value) } : row) })}/>
                    <span>{totalWeight ? Math.round(weight / totalWeight * 1000) / 10 : 0}%</span>
                  </>}
                </div>;
              })}
              {draft.items.filter(item => !known.has(item.itemId)).map(item => (
                <button key={item.itemId} type="button" onClick={() => setDraft({ ...draft, items:draft.items.filter(row => row !== item) })}>
                  Убрать удалённый предмет «{item.itemId}»
                </button>
              ))}
            </div>
          </fieldset>
          <div className={s.actions}>
            <button type="submit" disabled={busy || !draft.locations.length || !totalWeight}>Сохранить правило</button>
            {draft.id && <>
              <button type="button" disabled={busy} onClick={() => edit(createDraft())}>Закрыть</button>
              <button type="button" disabled={busy} onClick={async () => {
                if (!armed) { setArmed(true); return; }
                if (await mutate({ action:'remove', id:draft.id }, 'Правило удалено.')) edit(createDraft());
              }}>{armed ? 'Подтвердить удаление' : 'Удалить правило'}</button>
            </>}
          </div>
        </form>
      </section>
      <section className={s.panel}>
        <h2>Лимиты локаций</h2>
        <p className={s.muted}>По умолчанию {data.defaultLimit} предметов от спавна на земле. Ноль отключает появление на локации.</p>
        <div className={layout.fields}>
          {data.locations.map(place => (
            <form className={s.actions} key={`${place.id}:${data.limits[place.id]}`} onSubmit={e => {
              e.preventDefault();
              const limit = Number(new FormData(e.currentTarget).get('limit'));
              void mutate({ action:'limit', locationId:place.id, limit }, 'Лимит сохранён.');
            }}>
              <label>{place.name} <input name="limit" type="number" required min={0} max={data.maxLimit} defaultValue={data.limits[place.id] ?? data.defaultLimit}/></label>
              <button type="submit" disabled={busy}>Сохранить лимит</button>
            </form>
          ))}
        </div>
      </section>
      <section className={s.panel}>
        <div className={s.actions}><h2>Журнал спавна</h2><button type="button" disabled={busy} onClick={() => void refresh()}>Обновить</button></div>
        {data.log.length ? <ol className={layout.log}>{data.log.map(row => (
          <li key={row.id}>
            <strong>{locationName(row.locationId)} · {row.ruleName}</strong>
            <div className={s.muted}>{moscow.format(row.at)} МСК · {row.source === 'manual' ? 'Вручную' : 'По расписанию'}</div>
            <div>{row.items.length ? row.items.map(item => `${item.name} ×${item.count}`).join(', ') : 'Появилось 0 предметов'}</div>
            {row.reason && <small>План партии: {row.requested} · {reasons[row.reason] || row.reason}</small>}
          </li>
        ))}</ol> : <p className={s.muted}>Запусков пока нет.</p>}
      </section>
    </div>
  );
}

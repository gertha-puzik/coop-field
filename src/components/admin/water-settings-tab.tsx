'use client';

import { useEffect, useState } from 'react';
import { consoleError, consoleRequest } from '@/lib/net/http-console';
import { WATER_FIELDS, type WaterRules } from '@/lib/sim/water-rules';
import s from './admin-console.module.css';

export function WaterSettingsTab() {
  const [rules, setRules] = useState<WaterRules | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void consoleRequest<{ rules: WaterRules }>('/water').then(result => {
      if (!active) return;
      if (result.ok) setRules(result.rules);
      else setError(consoleError(result.reason));
    });
    return () => { active = false; };
  }, []);

  async function save() {
    if (!rules) return;
    setBusy(true);
    setSaved(false);
    setError('');
    const result = await consoleRequest<{ rules: WaterRules }>('/water', 'POST', rules);
    setBusy(false);
    if (result.ok) {
      setRules(result.rules);
      setSaved(true);
    } else setError(consoleError(result.reason));
  }

  return <section className={s.panel}>
    <h2>Вода</h2>
    {rules ? <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset className={s.stack} disabled={busy}>
        {WATER_FIELDS.map(([key, label, min, max]) => <label key={key} className={s.actions}>
          <span>{label}</span>
          <input type="number" required min={min} max={max} step={1} value={Number.isNaN(rules[key]) ? '' : rules[key]}
            onChange={event => { setSaved(false); setRules({ ...rules, [key]: event.target.valueAsNumber }); }} />
        </label>)}
        <div><button type="submit">{busy ? 'Сохраняем…' : 'Сохранить'}</button></div>
      </fieldset>
    </form> : !error ? <p role="status">Загрузка настроек…</p> : null}
    {error && <p role="alert" className={s.error}>{error}</p>}
    {saved && <p role="status">Настройки воды сохранены.</p>}
  </section>;
}

"use client";

import { useEffect, useState } from "react";
import { consoleError, consoleRequest } from "@/lib/net/http-console";
import type { StatsRules } from "@/lib/net/player-stats";
import s from "./admin-console.module.css";

const groups = [
  ["Энергия", [
    ["startEnergy", "Начальная энергия (%)", 0, 100],
    ["travelCost", "Стоимость перехода (п. п.)", 0, 100],
    ["sprintCost", "Стоимость интервала бега (п. п.)", 0, 100],
    ["sprintSeconds", "Интервал бега (сек.)", 0.5, 300],
    ["regenSeconds", "Время восстановления 1 п. п. (сек.)", 0.5, 86400],
  ]],
  ["Комфорт", [
    ["startComfort", "Начальный комфорт (%)", 0, 100],
    ["comfortFloor", "Порог снижения и начала бонуса (%)", 0, 100],
    ["comfortLoss", "Снижение за интервал (п. п.)", 0, 100],
    ["comfortMinutes", "Интервал снижения (мин.)", 0.1, 1440],
    ["bonusStep", "Шаг комфорта для бонуса (п. п.)", 1, 100],
    ["bonusPercent", "Ускорение восстановления за шаг (%)", 0, 100],
  ]],
] as const;

export function PlayerStatsTab() {
  const [rules, setRules] = useState<StatsRules | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function load() {
    setError("");
    const result = await consoleRequest<{ rules: StatsRules }>("/characteristics");
    if (result.ok) setRules(result.rules);
    else setError(consoleError(result.reason));
  }

  useEffect(() => { void load(); }, []);

  async function save() {
    if (!rules || busy) return;
    setBusy(true);
    setSaved(false);
    setError("");
    const result = await consoleRequest<{ rules: StatsRules }>("/characteristics", "POST", rules);
    setBusy(false);
    if (result.ok) {
      setRules(result.rules);
      setSaved(true);
    } else setError(consoleError(result.reason));
  }

  return (
    <section className={s.panel}>
      <h2>Характеристики</h2>
      {error && <p className={s.error} role="alert">{error}</p>}
      {saved && <p role="status">Настройки сохранены.</p>}
      {rules ? (
        <form className={s.stack} onSubmit={event => { event.preventDefault(); void save(); }}>
          {groups.map(([title, fields]) => (
            <fieldset className={s.stack} key={title} disabled={busy}>
              <legend>{title}</legend>
              {fields.map(([key, label, min, max]) => (
                <label className={s.actions} key={key}>
                  <span>{label}</span>
                  <input type="number" required step="any" min={min} max={max}
                    value={Number.isNaN(rules[key]) ? "" : rules[key]}
                    onChange={event => {
                      setSaved(false);
                      setRules({ ...rules, [key]: event.target.valueAsNumber });
                    }}
                  />
                </label>
              ))}
            </fieldset>
          ))}
          <div className={s.actions}><button type="submit" disabled={busy}>Сохранить</button></div>
        </form>
      ) : error ? <button type="button" onClick={() => void load()}>Повторить</button> : <p>Загрузка…</p>}
    </section>
  );
}

"use client";

import { useEffect, useState } from "react";
import { consoleError, consoleRequest } from "@/lib/net/http-console";
import type { StatsRules } from "@/lib/net/player-stats";
import { Icon } from "@/components/players/profile-icons";
import s from "./player-stats-tab.module.css";

const groups = [
  ["Энергия", [
    ["startEnergy", "Начальная энергия (%)", 0, 100, "ϟ", "Запас энергии нового персонажа."],
    ["travelCost", "Стоимость перехода (п. п.)", 0, 100, "➜", "Сколько энергии тратится при переходе между локациями."],
    ["sprintCost", "Стоимость интервала бега (п. п.)", 0, 100, "»", "Сколько энергии списывается в начале интервала бега с Shift."],
    ["sprintSeconds", "Интервал бега (сек.)", 0.5, 300, "◷", "Сколько секунд движения оплачивает один интервал бега."],
    ["regenSeconds", "Время восстановления 1 п. п. (сек.)", 0.5, 86400, "✚", "За сколько секунд восстанавливается один пункт энергии в AFK или офлайне без бонуса."],
  ]],
  ["Комфорт", [
    ["startComfort", "Начальный комфорт (%)", 0, 100, "♥", "Значение комфорта нового персонажа."],
    ["comfortFloor", "Порог снижения и начала бонуса (%)", 0, 100, "↕", "Выше этого значения комфорт постепенно снижается и даёт бонус к восстановлению энергии."],
    ["comfortLoss", "Снижение за интервал (п. п.)", 0, 100, "↓", "На сколько пунктов снижается комфорт за один интервал."],
    ["comfortMinutes", "Интервал снижения (мин.)", 0.1, 1440, "◷", "Сколько минут проходит между снижениями комфорта."],
    ["bonusStep", "Шаг комфорта для бонуса (п. п.)", 1, 100, "✦", "Сколько полных пунктов комфорта выше порога нужно для одного бонуса."],
    ["bonusPercent", "Ускорение восстановления за шаг (%)", 0, 100, "⟳", "На сколько процентов каждый шаг комфорта ускоряет восстановление энергии."],
  ]],
] as const;

export function PlayerStatsTab({ onClose }: { onClose: () => void }) {
  const [rules, setRules] = useState<StatsRules | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [help, setHelp] = useState<keyof StatsRules | null>(null);

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

  function change(key: keyof StatsRules, value: number) {
    setSaved(false);
    setRules(current => current && { ...current, [key]: value });
  }

  return (
    <section className={s.page} aria-labelledby="characteristics-title">
      <header className={s.heading}>
        <Icon name="paw" className={s.headingPaw} />
        <Icon name="gear" size={32} />
        <h2 id="characteristics-title">Характеристики</h2>
        <Icon name="paw" className={s.headingPaw} />
      </header>
      <button className={s.close} type="button" onClick={onClose} aria-label="Закрыть характеристики">×</button>
      <span className={s.leaves} aria-hidden="true"><i /><i /><i /></span>
      <span className={`${s.leaves} ${s.bottomLeaves}`} aria-hidden="true"><i /><i /><i /></span>
      {error && <p className={s.error} role="alert">{error}</p>}
      {rules ? (
        <form className={s.form} onSubmit={event => { event.preventDefault(); void save(); }}>
          {groups.map(([title, fields], index) => (
            <fieldset className={s.group} key={title} disabled={busy}>
              <legend className={s.legend}>
                <span className={s.medallion} aria-hidden="true">{index ? <Icon name="paw" size={29} /> : 'ϟ'}</span>
                {title}
              </legend>
              <div className={s.pattern} aria-hidden="true">{Array.from({ length: 5 }, (_, i) => <Icon key={i} name="paw" size={24} />)}</div>
              <div className={s.rows}>
                {fields.map(([key, label, min, max, icon, hint]) => {
                  const id = `stat-rule-${key}`;
                  const value = rules[key];
                  const step = key === "comfortLoss" ? 0.5 : 1;
                  const adjust = (direction: number) => {
                    const next = Number.isFinite(value) ? value + direction * step : min;
                    change(key, Math.min(max, Math.max(min, Math.round(next * 1e8) / 1e8)));
                  };
                  return (
                    <div className={s.row} key={key}>
                      <span className={s.rowIcon} aria-hidden="true">{icon}</span>
                      <div className={s.caption}>
                        <label htmlFor={id}>{label}</label>
                        <button type="button" className={s.help}
                          aria-label={`Подсказка: ${label}`} aria-expanded={help === key}
                          aria-controls={`${id}-hint`}
                          onClick={() => setHelp(open => open === key ? null : key)}>?</button>
                        <p id={`${id}-hint`} className={s.hint} hidden={help !== key}>{hint}</p>
                      </div>
                      <div className={s.number}>
                        <input id={id} type="number" required step="any" min={min} max={max}
                          aria-describedby={help === key ? `${id}-hint` : undefined}
                          value={Number.isNaN(value) ? "" : value}
                          onChange={event => change(key, event.target.valueAsNumber)}
                        />
                        <div className={s.stepper}>
                          <button type="button" aria-label={`Увеличить: ${label}`} disabled={value >= max} onClick={() => adjust(1)}>▴</button>
                          <button type="button" aria-label={`Уменьшить: ${label}`} disabled={value <= min} onClick={() => adjust(-1)}>▾</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className={s.flourish} aria-hidden="true"><span>✦</span><Icon name="paw" size={84} /><span>✧</span></div>
            </fieldset>
          ))}
          <footer className={s.footer}>
            <button className={s.save} type="submit" disabled={busy}><span aria-hidden="true">✓</span>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
            {saved && <p role="status">Настройки сохранены.</p>}
          </footer>
        </form>
      ) : error ? <button type="button" onClick={() => void load()}>Повторить</button> : <p role="status">Загрузка…</p>}
    </section>
  );
}

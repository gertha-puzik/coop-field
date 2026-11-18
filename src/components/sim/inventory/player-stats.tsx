"use client";

import { useEffect, useState } from "react";
import { inventoryRequest } from "@/lib/net/http-inventory";
import type { PlayerStats, ItemUsePage, ItemUseEntry } from "@/lib/net/player-stats";
import { Icon } from "@/components/players/profile-icons";
import s from "./player-stats.module.css";

const number = new Intl.NumberFormat("ru", { maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat("ru", { dateStyle: "short", timeStyle: "short" });
const format = (value: number) => number.format(value);

function EnergyLevel({ value }: { value: number }) {
  return (
    <div className={s.energyLevel}>
      <meter aria-label="Энергия" min={0} max={100} value={value} />
      <strong>{format(Math.floor(value))} / 100</strong>
    </div>
  );
}

function ComfortLevel({ value }: { value: number }) {
  return (
    <div className={s.comfort} aria-label={`Комфорт ${format(value)}%`}>
      <Icon name="paw" size={17} />
      <span>Комфорт</span>
      <div className={s.scale} role="meter" aria-label="Комфорт"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
        <span className={s.needle} style={{ bottom: `${value}%` }}><Icon name="paw" size={13} /></span>
      </div>
      <strong>{format(value)}%</strong>
    </div>
  );
}

export function PlayerStatsHud({ stats, onOpen }: { stats: PlayerStats | null; onOpen: () => void }) {
  if (!stats) return null;
  return (
    <section aria-label="Характеристики игрока" className={s.plate}>
      <div className={s.energy}>
        <button type="button" onClick={onOpen} aria-haspopup="dialog"><Icon name="chart" size={12} /> Подробнее <span aria-hidden>⌃</span></button>
        <div className={s.energyTitle}><span className={s.bolt} aria-hidden /> Энергия</div>
        <EnergyLevel value={stats.energy} />
      </div>
      <ComfortLevel value={stats.comfort} />
    </section>
  );
}

export function PlayerStatsDetails({ stats, characterId }: { stats: PlayerStats | null; characterId?: string }) {
  if (!stats) return <p>Загрузка характеристик…</p>;
  const { rules } = stats;
  const showingRegen = rules.regenSeconds / (1 + stats.bonus / 100);
  return (
    <>
      <div className={s.tiles}>
        <section>
          <h3><span className={s.bolt} aria-hidden /> Энергия</h3>
          <EnergyLevel value={stats.energy} />
          <p>Восстанавливается в AFK и офлайн. Сейчас 1 пункт за {format(showingRegen)} сек.</p>
          <p>Переход между локациями −{format(rules.travelCost)} п. п.</p>
          <p>Бег с Shift −{format(rules.sprintCost)} п. п. за {format(rules.sprintSeconds)} сек.</p>
          {stats.recovering && stats.energy < 100 && <p>Энергия восстанавливается.</p>}
        </section>
        <section>
          <h3><Icon name="paw" size={22} /> Комфорт</h3>
          <strong>{format(stats.comfort)}%</strong>
          <p>Предметы повышают комфорт. Выше {format(rules.comfortFloor)}% он снижается на {format(rules.comfortLoss)} п. п. за {format(rules.comfortMinutes)} мин.</p>
          <p>Текущий бонус к восстановлению энергии <strong>+{format(stats.bonus)}%</strong>.</p>
        </section>
      </div>
      {characterId && <ItemUseHistory key={characterId} characterId={characterId} />}
    </>
  );
}

function ItemUseHistory({ characterId }: { characterId: string }) {
  const [entries, setEntries] = useState<ItemUseEntry[]>([]);
  const [offset, setOffset] = useState<number | null>(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const request = (offset: number) => inventoryRequest<ItemUsePage>(
    `/cfg/inventory/history?characterId=${encodeURIComponent(characterId)}&offset=${offset}`,
  );

  useEffect(() => {
    let mounted = true;
    void request(0).then(page => {
      if (!mounted) return;
      setEntries(page.entries);
      setOffset(page.nextOffset);
    }).catch(() => { if (mounted) setError(true); })
      .finally(() => { if (mounted) setBusy(false); });
    return () => { mounted = false; };
  }, [characterId]);

  async function more() {
    if (offset === null || busy) return;
    setBusy(true);
    setError(false);
    try {
      const page = await request(offset);
      setEntries(old => [...old, ...page.entries.filter(entry => !old.some(row => row.id === entry.id))]);
      setOffset(page.nextOffset);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={s.history} aria-busy={busy}>
      <h3>Использованные предметы</h3>
      {entries.length > 0 && (
        <ul>
          {entries.map(entry => (
            <li key={entry.id}>
              <div><strong>{entry.name}</strong><time dateTime={new Date(entry.at).toISOString()}>{date.format(entry.at)}</time></div>
              <span>{[
                entry.energy > 0 ? `Энергия +${format(entry.energy)} п. п.` : "",
                entry.comfort > 0 ? `Комфорт +${format(entry.comfort)} п. п.` : "",
              ].filter(Boolean).join(" · ")}</span>
            </li>
          ))}
        </ul>
      )}
      {error ? <p role="alert">Не удалось загрузить историю.</p> :
        !busy && !entries.length ? <p>Предметы ещё не использованы.</p> : null}
      {busy ? <p role="status">Загрузка…</p> : offset !== null &&
        <button type="button" className={s.more} onClick={() => void more()}>{error ? "Повторить" : "Показать ещё"}</button>}
    </section>
  );
}

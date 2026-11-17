"use client";
import { useEffect, useState } from "react";
import { Button, Input } from "@/components/ui";
import {
  inventoryRequest,
  inventoryError,
  uploadItemSprite,
  itemSprite,
  type ItemDefinition,
  type ItemRecipient,
} from "@/lib/net/http-inventory";
import s from "./admin-console.module.css";
export function ItemsTab() {
  const [items, setItems] = useState<ItemDefinition[]>([]),
    [draft, setDraft] = useState({
      id: "",
      name: "",
      weight: 3,
      sprite: "",
      glows: false,
      glowIntensity: 1,
      glowPeriod: 0,
      sparkle: false,
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState("");
  const load = async () => {
    try {
      setItems(
        (await inventoryRequest<{ items: ItemDefinition[] }>("/cfg/items"))
          .items,
      );
    } catch (e) {
      setError(inventoryError(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const file = async (value?: File) => {
    if (!value) return;
    if (value.size > 2 * 1024 * 1024) {
      setError("Максимум 2 МБ.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const sprite = await uploadItemSprite(value);
      setDraft((old) => ({ ...old, sprite }));
    } catch (e) {
      setError(inventoryError(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await inventoryRequest("/cfg/items", "POST", draft);
      setNote(`Предмет «${draft.name}» сохранён.`);
      await load();
    } catch (e) {
      setError(inventoryError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={s.panel}>
      <h2>Создание предмета</h2>
      <p className={s.muted}>
        Спрайты сохраняются без изменения пикселей и прозрачности. Для
        светящихся предметов эффект включается вечером и ночью.
      </p>
      <div className={s.actions}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={draft.id === item.id}
            onClick={() => {
              setDraft({
                ...item,
                sprite: item.sprite || "",
                glows: !!item.glows,
                glowIntensity: item.glowIntensity ?? 1,
                glowPeriod: item.glowPeriod ?? 0,
                sparkle: !!item.sparkle,
              });
              setNote("");
            }}
          >
            {item.sprite ? (
              <img
                src={itemSprite(item.sprite)}
                width="32"
                height="32"
                alt=""
                style={{ objectFit: "contain", imageRendering: "pixelated" }}
              />
            ) : null}
            {item.name} · {item.weight}
          </button>
        ))}
        <Button
          variant="outline"
          onClick={() =>
            setDraft({
              id: "",
              name: "",
              weight: 3,
              sprite: "",
              glows: false,
              glowIntensity: 1,
              glowPeriod: 0,
              sparkle: false,
            })
          }
        >
          + Новый предмет
        </Button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className={s.form}>
          <label>
            ID предмета
            <Input
              value={draft.id}
              disabled={busy}
              required
              pattern="[a-z0-9][a-z0-9_-]{0,47}"
              maxLength={48}
              placeholder="nugget"
              onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            />
          </label>
          <label>
            Название
            <Input
              value={draft.name}
              disabled={busy}
              required
              maxLength={64}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            Вес одной штуки
            <Input
              type="number"
              value={draft.weight}
              disabled={busy}
              required
              min="0.01"
              max="30"
              step="0.01"
              onChange={(e) =>
                setDraft({ ...draft, weight: Number(e.target.value) })
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.glows}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, glows: e.target.checked })}
            />{" "}
            Светится вечером и ночью
          </label>
          {draft.glows ? (
            <>
              <label>
                Яркость свечения (0–3)
                <Input
                  type="number"
                  min="0"
                  max="3"
                  step="0.1"
                  value={draft.glowIntensity}
                  disabled={busy}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      glowIntensity: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                Период пульсации, секунды (0 — постоянный свет)
                <Input
                  type="number"
                  min="0"
                  max="60"
                  step="0.5"
                  value={draft.glowPeriod}
                  disabled={busy}
                  onChange={(e) =>
                    setDraft({ ...draft, glowPeriod: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={draft.sparkle}
                  disabled={busy}
                  onChange={(e) =>
                    setDraft({ ...draft, sparkle: e.target.checked })
                  }
                />{" "}
                Мерцание драгоценного камня
              </label>
            </>
          ) : null}
          <label>
            PNG-спрайт
            <Input
              type="file"
              accept="image/png"
              disabled={busy}
              onChange={(e) => {
                void file(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {draft.sprite ? (
          <img
            src={itemSprite(draft.sprite)}
            alt="Предпросмотр предмета"
            width="100"
            height="100"
            style={{
              objectFit: "contain",
              imageRendering: "pixelated",
              margin: "12px 0",
            }}
          />
        ) : (
          <p className={s.muted}>Спрайт ещё не загружен.</p>
        )}
        <Button type="submit" disabled={busy || !draft.sprite}>
          {busy ? "Подождите…" : "Сохранить предмет"}
        </Button>
      </form>
      {error ? (
        <p role="alert" className={s.error}>
          {error}
        </p>
      ) : null}
      <p role="status">{note}</p>
    </section>
  );
}
export function ItemGrantTab() {
  const [players, setPlayers] = useState<ItemRecipient[]>([]),
    [items, setItems] = useState<ItemDefinition[]>([]),
    [accountId, setAccountId] = useState(""),
    [characterId, setCharacterId] = useState(""),
    [itemId, setItemId] = useState("nugget"),
    [quantity, setQuantity] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState("");
  const operation = useState(() => ({
    id: crypto.randomUUID(),
    fingerprint: "",
  }))[0];
  const load = async () => {
    try {
      const [p, i] = await Promise.all([
        inventoryRequest<{ players: ItemRecipient[] }>("/cfg/items/players"),
        inventoryRequest<{ items: ItemDefinition[] }>("/cfg/items"),
      ]);
      setPlayers(p.players);
      setItems(i.items);
    } catch (e) {
      setError(inventoryError(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const player = players.find((row) => row.accountId === accountId),
    character = player?.characters.find((row) => row.id === characterId),
    item = items.find((row) => row.id === itemId);
  const added = (item?.weight || 0) * quantity,
    over = !!character && character.weight + added > 30 + 1e-7;
  const grant = async () => {
    const fingerprint = JSON.stringify([
      accountId,
      characterId,
      itemId,
      quantity,
    ]);
    if (operation.fingerprint !== fingerprint) {
      operation.id = crypto.randomUUID();
      operation.fingerprint = fingerprint;
    }
    setBusy(true);
    setError("");
    setNote("");
    try {
      await inventoryRequest("/cfg/items/grant", "POST", {
        accountId,
        characterId,
        itemId,
        quantity,
        operationId: operation.id,
      });
      operation.fingerprint = "";
      setNote(
        `Выдано ${item?.name} ×${quantity} персонажу «${character?.name}». Действие записано в журнал.`,
      );
      await load();
    } catch (e) {
      setError(inventoryError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={s.panel}>
      <h2>Выдача предметов</h2>
      <p className={s.muted}>
        Выдача идёт выбранному персонажу. Общий вес инвентаря и хотбара не может
        превышать 30.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void grant();
        }}
      >
        <div className={s.form}>
          <label>
            Игрок
            <select
              value={accountId}
              disabled={busy}
              required
              onChange={(e) => {
                setAccountId(e.target.value);
                setCharacterId("");
              }}
            >
              <option value="">Выберите игрока</option>
              {players.map((p) => (
                <option key={p.accountId} value={p.accountId}>
                  {p.name} · {p.login}
                </option>
              ))}
            </select>
          </label>
          <label>
            Персонаж
            <select
              value={characterId}
              disabled={busy || !player}
              required
              onChange={(e) => setCharacterId(e.target.value)}
            >
              <option value="">Выберите персонажа</option>
              {player?.characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · вес {c.weight}/30
                </option>
              ))}
            </select>
          </label>
          <label>
            Предмет
            <select
              value={itemId}
              disabled={busy}
              required
              onChange={(e) => setItemId(e.target.value)}
            >
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} · {i.weight}
                </option>
              ))}
            </select>
          </label>
          <label>
            Количество
            <Input
              type="number"
              value={quantity}
              disabled={busy}
              min="1"
              max="10000"
              step="1"
              required
              onChange={(e) => setQuantity(Number(e.target.value))}
            />
          </label>
        </div>
        <p>
          Вес выдачи: {Number(added.toFixed(2))}. После выдачи:{" "}
          {Number(((character?.weight || 0) + added).toFixed(2))}/30.
        </p>
        {over ? (
          <p className={s.error}>Выдача превысит допустимый вес.</p>
        ) : null}
        <Button
          type="submit"
          disabled={
            busy ||
            !character ||
            !item ||
            over ||
            !Number.isInteger(quantity) ||
            quantity < 1
          }
        >
          {busy ? "Выдаём…" : "Выдать предметы"}
        </Button>
      </form>
      {error ? (
        <p role="alert" className={s.error}>
          {error}
        </p>
      ) : null}
      <p role="status">{note}</p>
    </section>
  );
}

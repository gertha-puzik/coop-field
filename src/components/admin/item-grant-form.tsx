"use client";
import { useRef, useState } from "react";
import { Button, Input, Select } from "@/components/ui";
import {
  inventoryRequest,
  inventoryError,
  itemSprite,
  type ItemDefinition,
  type ItemRecipient,
} from "@/lib/net/http-inventory";
import { ItemGlyph, ItemPanel, ItemStepper } from "./item-editor";
import s from "./items.module.css";
type Recipient = { accountId: string; characterId: string };
type Row = { key: string; itemId: string; quantity: number };
export function ItemGrantForm({
  items,
  players,
  onGranted,
}: {
  items: ItemDefinition[];
  players: ItemRecipient[];
  onGranted: () => Promise<void>;
}) {
  const [group, setGroup] = useState(false),
    [search, setSearch] = useState(""),
    [recipients, setRecipients] = useState<Recipient[]>([]),
    [rows, setRows] = useState<Row[]>([]),
    [comment, setComment] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState("");
  const operation = useRef({ id: "", fingerprint: "" });
  const choices = players.flatMap((p) =>
      p.characters.map((c) => ({
        accountId: p.accountId,
        characterId: c.id,
        name: c.name,
        playerName: p.name,
        login: p.login,
        weight: c.weight,
      })),
    ),
    selection = choices.filter((c) =>
      recipients.some(
        (r) => r.accountId === c.accountId && r.characterId === c.characterId,
      ),
    ),
    filtered = choices.filter((c) =>
      `${c.name} ${c.playerName} ${c.login}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ),
    added = rows.reduce(
      (sum, r) =>
        sum + (items.find((i) => i.id === r.itemId)?.weight || 0) * r.quantity,
      0,
    ),
    overweight = selection.filter((c) => c.weight + added > 30 + 1e-7),
    invalid = rows.some(
      (r) =>
        !items.some((i) => i.id === r.itemId) ||
        !Number.isInteger(r.quantity) ||
        r.quantity < 1 ||
        r.quantity > 10000,
    );
  const toggle = (r: Recipient) =>
    setRecipients((old) =>
      old.some(
        (x) => x.accountId === r.accountId && x.characterId === r.characterId,
      )
        ? old.filter(
            (x) =>
              x.accountId !== r.accountId || x.characterId !== r.characterId,
          )
        : old.length < 20
          ? [...old, r]
          : old,
    );
  const grant = async () => {
    if (
      busy ||
      invalid ||
      !rows.length ||
      !selection.length ||
      overweight.length
    )
      return;
    const body = {
      recipients: selection.map(({ accountId, characterId }) => ({
        accountId,
        characterId,
      })),
      items: rows.map(({ itemId, quantity }) => ({ itemId, quantity })),
      comment,
    };
    const fingerprint = JSON.stringify(body);
    if (operation.current.fingerprint !== fingerprint)
      operation.current = { id: crypto.randomUUID(), fingerprint };
    setBusy(true);
    setError("");
    setNote("");
    try {
      await inventoryRequest("/cfg/items/grant-batch", "POST", {
        ...body,
        operationId: operation.current.id,
      });
      operation.current.fingerprint = "";
      setNote(
        `Предметы выданы. Получателей: ${selection.length}. Действие записано в журнал.`,
      );
      await onGranted();
    } catch (e) {
      setError(inventoryError(e));
    } finally {
      setBusy(false);
    }
  };
  const clear = () => {
    setRecipients([]);
    setRows([]);
    setComment("");
    setSearch("");
    setError("");
    setNote("");
  };
  return (
    <form
      className={s.grantForm}
      onSubmit={(e) => {
        e.preventDefault();
        void grant();
      }}
    >
      <fieldset disabled={busy} className={s.grantFieldset}>
        <div className={s.grantTop}>
          <ItemPanel title="Получатель" icon="user">
            <div className={s.segment}>
              <button
                type="button"
                aria-pressed={!group}
                onClick={() => {
                  setGroup(false);
                  setRecipients((r) => r.slice(0, 1));
                }}
              >
                <ItemGlyph name="user" />
                Игрок
              </button>
              <button
                type="button"
                aria-pressed={group}
                onClick={() => setGroup(true)}
              >
                <ItemGlyph name="user" />
                Группа игроков
              </button>
            </div>
            <label className={s.search}>
              <ItemGlyph name="search" />
              <Input
                aria-label="Поиск игрока"
                placeholder="Ник игрока…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            {!group ? (
              <>
                <Select
                  aria-label="Игрок"
                  value={selection[0]?.accountId || ""}
                  onChange={(e) => {
                    const p = players.find(
                      (p) => p.accountId === e.target.value,
                    );
                    setRecipients(
                      p?.characters[0]
                        ? [
                            {
                              accountId: p.accountId,
                              characterId: p.characters[0].id,
                            },
                          ]
                        : [],
                    );
                  }}
                >
                  <option value="">Выберите игрока</option>
                  {players
                    .filter((p) =>
                      p.accountId === selection[0]?.accountId || `${p.name} ${p.login}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .map((p) => (
                      <option key={p.accountId} value={p.accountId}>
                        {p.name} · {p.login}
                      </option>
                    ))}
                </Select>
                <Select
                  aria-label="Персонаж получателя"
                  disabled={!selection[0]}
                  value={selection[0]?.characterId || ""}
                  onChange={(e) =>
                    setRecipients([
                      {
                        accountId: selection[0].accountId,
                        characterId: e.target.value,
                      },
                    ])
                  }
                >
                  <option value="">Выберите персонажа</option>
                  {players
                    .find((p) => p.accountId === selection[0]?.accountId)
                    ?.characters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · вес {c.weight}/30
                      </option>
                    ))}
                </Select>
              </>
            ) : (
              <div
                className={s.recipientList}
                aria-label="Персонажи для выдачи"
              >
                {filtered.map((c) => {
                  const checked = recipients.some(
                    (r) =>
                      r.accountId === c.accountId &&
                      r.characterId === c.characterId,
                  );
                  return (
                    <label key={`${c.accountId}:${c.characterId}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!checked && recipients.length >= 20}
                        onChange={() =>
                          toggle({
                            accountId: c.accountId,
                            characterId: c.characterId,
                          })
                        }
                      />
                      <span>
                        {c.playerName}
                        <small>
                          {c.name} · {c.weight}/30
                        </small>
                      </span>
                    </label>
                  );
                })}
                {!filtered.length ? <p>Игроки не найдены.</p> : null}
              </div>
            )}
            <small className={s.muted}>
              {group
                ? `Выбрано ${selection.length}/20. Одинаковый набор каждому персонажу.`
                : "Выдача в инвентарь выбранного персонажа."}
            </small>
          </ItemPanel>
          <ItemPanel title="Предметы" icon="box">
            <div className={s.grantRows}>
              {rows.map((row) => {
                const item = items.find((i) => i.id === row.itemId);
                return (
                  <div className={s.grantRow} key={row.key}>
                    {item?.sprite ? (
                      <img src={itemSprite(item.sprite)} alt="" />
                    ) : (
                      <ItemGlyph name="box" />
                    )}
                    <Select
                      aria-label="Предмет для выдачи"
                      value={row.itemId}
                      onChange={(e) =>
                        setRows((r) =>
                          r.map((x) =>
                            x.key === row.key
                              ? { ...x, itemId: e.target.value }
                              : x,
                          ),
                        )
                      }
                    >
                      {!item ? <option value={row.itemId} disabled>Предмет удалён — выберите другой</option> : null}
                      {items.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}
                        </option>
                      ))}
                    </Select>
                    <ItemStepper
                      label={`Количество: ${item?.name || "предмет"}`}
                      value={row.quantity}
                      min={1}
                      max={10000}
                      onChange={(quantity) =>
                        setRows((r) =>
                          r.map((x) =>
                            x.key === row.key ? { ...x, quantity } : x,
                          ),
                        )
                      }
                    />
                    <button
                      type="button"
                      className={s.removeRow}
                      aria-label={`Убрать ${item?.name || "предмет"} из выдачи`}
                      onClick={() =>
                        setRows((r) => r.filter((x) => x.key !== row.key))
                      }
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
            {!rows.length ? (
              <p className={s.muted}>Добавьте предметы для выдачи.</p>
            ) : null}
            <Button
              type="button"
              className={s.quiet}
              disabled={!items.length || rows.length >= 20}
              onClick={() =>
                setRows((r) => [
                  ...r,
                  {
                    key: crypto.randomUUID(),
                    itemId:
                      items.find((i) => !r.some((x) => x.itemId === i.id))
                        ?.id || items[0].id,
                    quantity: 1,
                  },
                ])
              }
            >
              <ItemGlyph name="plus" />
              Добавить предмет
            </Button>
            {rows.length ? (
              <p className={s.muted}>
                Вес набора: {Number(added.toFixed(2))}. Вместимость каждого
                персонажа — 30.
              </p>
            ) : null}
          </ItemPanel>
        </div>
        <div className={s.commentBox}>
          <label>
            <span>
              <ItemGlyph name="edit" />
              Комментарий <span className={s.muted}>(необязательно)</span>
            </span>
            <Input
              maxLength={200}
              placeholder="Например: награда за событие"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <small>{comment.length} / 200</small>
          </label>
          <div className={s.formActions}>
            <Button type="button" className={s.quiet} onClick={clear}>
              ↶ Очистить
            </Button>
            <Button
              type="submit"
              className={s.primary}
              disabled={
                !selection.length ||
                !rows.length ||
                !!overweight.length ||
                invalid
              }
            >
              <ItemGlyph name="gift" />
              {busy ? "Выдаём…" : "Выдать предметы"}
            </Button>
          </div>
        </div>
      </fieldset>
      {overweight.length ? (
        <p role="status" className={s.error}>
          Недостаточно места по весу: {overweight.map((c) => c.name).join(", ")}
          . Уменьшите набор.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={s.error}>
          {error}
        </p>
      ) : null}
      {note ? (
        <p role="status" className={s.success}>
          {note}
        </p>
      ) : null}
    </form>
  );
}

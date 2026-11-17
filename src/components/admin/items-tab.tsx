"use client";
import { useEffect, useRef, useState } from "react";
import { Button, Input, Select, ConfirmDialog } from "@/components/ui";
import {
  ITEM_CATEGORIES,
  inventoryRequest,
  inventoryError,
  itemSprite,
  type ItemDefinition,
  type ItemRecipient,
} from "@/lib/net/http-inventory";
import { ItemEditor, ItemGlyph } from "./item-editor";
import { ItemGrantForm } from "./item-grant-form";
import s from "./items.module.css";
export function ItemsTab() {
  const [revision, setRevision] = useState(0),
    [note, setNote] = useState("");
  return (
    <div className={s.workbench} data-item-workbench>
      <div className={s.breadcrumb}>
        Предметы <span>›</span> Создание предмета
      </div>
      <ItemEditor
        key={revision}
        onSaved={(i) => {
          setNote(`Предмет «${i.name}» создан.`);
          setRevision((n) => n + 1);
        }}
      />
      {note ? (
        <p className={s.success} role="status">
          {note}
        </p>
      ) : null}
    </div>
  );
}
export function ItemGrantTab() {
  const [items, setItems] = useState<ItemDefinition[]>([]),
    [players, setPlayers] = useState<ItemRecipient[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [selected, setSelected] = useState(""),
    [query, setQuery] = useState(""),
    [category, setCategory] = useState(""),
    [sort, setSort] = useState("name"),
    [page, setPage] = useState(0),
    [creating, setCreating] = useState(false),
    [duplicate, setDuplicate] = useState<ItemDefinition | undefined>(),
    [deleting, setDeleting] = useState(false),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState("");
  const grantRef = useRef<HTMLElement>(null),
    dbRef = useRef<HTMLElement>(null);
  const load = async () => {
    setError("");
    try {
      const [i, p] = await Promise.all([
        inventoryRequest<{ items: ItemDefinition[] }>("/cfg/items"),
        inventoryRequest<{ players: ItemRecipient[] }>("/cfg/items/players"),
      ]);
      setItems(i.items);
      setPlayers(p.players);
      setSelected((old) =>
        i.items.some((x) => x.id === old) ? old : i.items[0]?.id || "",
      );
    } catch (e) {
      setError(inventoryError(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const [i, p] = await Promise.all([
          inventoryRequest<{ items: ItemDefinition[] }>("/cfg/items"),
          inventoryRequest<{ players: ItemRecipient[] }>("/cfg/items/players"),
        ]);
        if (disposed) return;
        setItems(i.items);
        setPlayers(p.players);
        setSelected(i.items[0]?.id || "");
      } catch (e) {
        if (!disposed) setError(inventoryError(e));
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);
  const filtered = items
      .filter(
        (i) =>
          (!category || (i.category || "other") === category) &&
          `${i.name} ${i.id}`.toLowerCase().includes(query.toLowerCase()),
      )
      .sort((a, b) =>
        sort === "weight"
          ? a.weight - b.weight
          : a.name.localeCompare(b.name, "ru"),
      ),
    pages = Math.max(1, Math.ceil(filtered.length / 8)),
    currentPage = Math.min(page, pages - 1),
    chosen = filtered.find((i) => i.id === selected) || filtered[0];
  const saved = async (item: ItemDefinition) => {
    await load();
    setSelected(item.id);
    setQuery("");
    setCategory("");
    setPage(0);
    setCreating(false);
    setDuplicate(undefined);
  };
  const remove = async () => {
    if (!chosen) return;
    setBusy(true);
    setError("");
    try {
      await inventoryRequest("/cfg/items/delete", "POST", { id: chosen.id });
      setNote(`Предмет «${chosen.name}» удалён из базы.`);
      setDeleting(false);
      await load();
    } catch (e) {
      setError(inventoryError(e));
    } finally {
      setBusy(false);
    }
  };
  if (creating || duplicate)
    return (
      <div className={s.workbench} data-item-workbench>
        <div className={s.breadcrumb}>
          Предметы <span>›</span> Создание предмета
        </div>
        <ItemEditor
          key={duplicate?.id || "new"}
          initial={duplicate}
          onSaved={saved}
          onCancel={() => {
            setCreating(false);
            setDuplicate(undefined);
          }}
        />
      </div>
    );
  return (
    <div className={s.workbench} data-item-workbench>
      <header className={s.pageHeader}>
        <ItemGlyph name="gift" />
        <div>
          <h2>Выдача предметов</h2>
          <p>Выдайте предметы одному игроку или группе персонажей.</p>
        </div>
        <nav className={s.segment} aria-label="Разделы предметов">
          <Button
            className={s.quiet}
            type="button"
            onClick={() =>
              grantRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              })
            }
          >
            <ItemGlyph name="gift" />
            Выдача
          </Button>
          <Button
            className={s.quiet}
            type="button"
            onClick={() =>
              dbRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              })
            }
          >
            <ItemGlyph name="layers" />
            База предметов
          </Button>
        </nav>
      </header>
      {loading ? (
        <p role="status" className={s.muted}>
          Загружаем предметы и игроков…
        </p>
      ) : null}
      {error ? (
        <div className={s.error} role="alert">
          {error}{" "}
          <Button type="button" variant="ghost" onClick={() => void load()}>
            Обновить
          </Button>
        </div>
      ) : null}
      <section ref={grantRef} className={s.anchor}>
        <ItemGrantForm items={items} players={players} onGranted={load} />
      </section>
      <section ref={dbRef} className={`${s.database} ${s.anchor}`}>
        <header className={s.pageHeader}>
          <ItemGlyph name="layers" />
          <div>
            <h2>База предметов</h2>
            <p>Все предметы игры с описаниями, параметрами и настройками.</p>
          </div>
          <Button className={s.primary} onClick={() => setCreating(true)}>
            <ItemGlyph name="plus" />
            Создать предмет
          </Button>
        </header>
        <div className={s.databaseGrid}>
          <aside className={s.catalogue}>
            <label className={s.search}>
              <ItemGlyph name="search" />
              <Input
                aria-label="Поиск предмета по названию или ID"
                placeholder="Поиск по названию или ID…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
              />
            </label>
            <div className={s.catalogueFilters}>
              <Select
                aria-label="Категория предметов"
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setPage(0);
                }}
              >
                <option value="">Все категории</option>
                {ITEM_CATEGORIES.map((c) => (
                  <option key={c[0]} value={c[0]}>
                    {c[1]}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Сортировка предметов"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                <option value="name">По названию ↑</option>
                <option value="weight">По весу ↑</option>
              </Select>
            </div>
            <ul className={s.itemList}>
              {filtered.slice(currentPage * 8, currentPage * 8 + 8).map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    aria-pressed={chosen?.id === i.id}
                    onClick={() => {
                      setSelected(i.id);
                      setNote("");
                    }}
                  >
                    {i.sprite ? (
                      <img src={itemSprite(i.sprite)} alt="" />
                    ) : (
                      <ItemGlyph name="box" />
                    )}
                    <span>
                      <strong>{i.name}</strong>
                      <small>ID: {i.id}</small>
                    </span>
                    <span className={s.listWeight}>
                      <ItemGlyph name="layers" />
                      {i.weight}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {!filtered.length ? (
              <p className={s.muted}>
                {loading ? "Загрузка…" : "Предметы не найдены."}
              </p>
            ) : null}
            <nav className={s.pagination} aria-label="Страницы базы предметов">
              <button
                type="button"
                disabled={currentPage === 0}
                onClick={() => setPage((p) => p - 1)}
                aria-label="Предыдущая страница"
              >
                ‹
              </button>
              {Array.from({ length: pages }, (_, i) => i)
                .filter(
                  (i) =>
                    i === 0 ||
                    i === pages - 1 ||
                    Math.abs(i - currentPage) <= 1,
                )
                .map((i, index, array) => (
                  <span key={i}>
                    {index > 0 && i - array[index - 1] > 1 ? (
                      <span>…</span>
                    ) : null}
                    <button
                      type="button"
                      aria-current={currentPage === i ? "page" : undefined}
                      onClick={() => setPage(i)}
                    >
                      {i + 1}
                    </button>
                  </span>
                ))}
              <button
                type="button"
                disabled={currentPage === pages - 1}
                onClick={() => setPage((p) => p + 1)}
                aria-label="Следующая страница"
              >
                ›
              </button>
            </nav>
          </aside>
          <div className={s.editorCard}>
            {chosen ? (
              <ItemEditor
                key={chosen.id}
                item={chosen}
                onSaved={saved}
                footer={
                  <>
                    <Button
                      type="button"
                      className={s.quiet}
                      onClick={() =>
                        setDuplicate({
                          ...chosen,
                          id: `${chosen.id.slice(0, 32)}_copy_${crypto.randomUUID().slice(0, 4)}`,
                          name: `${chosen.name} — копия`.slice(0, 64),
                        })
                      }
                    >
                      Дублировать
                    </Button>
                    <Button
                      type="button"
                      className={s.danger}
                      onClick={() => setDeleting(true)}
                    >
                      <ItemGlyph name="trash" />
                      Удалить
                    </Button>
                  </>
                }
              />
            ) : (
              <div className={s.emptyDatabase}>
                <ItemGlyph name="box" />
                <p>Выберите предмет в базе или создайте новый.</p>
              </div>
            )}
          </div>
        </div>
      </section>
      {note ? (
        <p className={s.success} role="status">
          {note}
        </p>
      ) : null}
      <ConfirmDialog
        open={deleting}
        title={`Удалить «${chosen?.name || "предмет"}»?`}
        description="Предмет исчезнет из базы и выдачи. Уже выданные экземпляры останутся у игроков и на локациях."
        danger
        busy={busy}
        confirmLabel="Удалить предмет"
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(false)}
      />
    </div>
  );
}

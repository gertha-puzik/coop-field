"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Icon } from "@/components/players/profile-icons";
import type { CoopChatMessage } from "@/lib/net/coop";
import s from "./game-hud.module.css";
type Size = { width: number; height: number };
type Drag = Size & { x: number; y: number; pointer: number };

export function GameChat({
  lines,
  characterId,
  meId,
  canSend,
  onSend,
}: {
  lines: CoopChatMessage[];
  characterId?: string;
  meId: number | null;
  canSend: boolean;
  onSend: (text: string, channel: "global" | "near") => boolean;
}) {
  const [channel, setChannel] = useState<"global" | "near">("global"),
    [draft, setDraft] = useState(""),
    [collapsed, setCollapsed] = useState(false),
    [stuck, setStuck] = useState(true);
  const [size, setSize] = useState<Size | null>(null);
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<Drag | null>(null);
  const log = useRef<HTMLDivElement>(null),
    drafts = useRef({ global: "", near: "" });
  useEffect(() => {
    if (matchMedia("(max-width:700px)").matches) setCollapsed(true);
    const focus = () => {
      setCollapsed(false);
      requestAnimationFrame(() =>
        document.getElementById("roomChatInput")?.focus(),
      );
    };
    window.addEventListener("game-chat:focus", focus);
    return () => window.removeEventListener("game-chat:focus", focus);
  }, []);
  const ordered = lines
    .filter((line) => (line.channel || "near") === channel)
    .slice()
    .reverse();
  useEffect(() => {
    if (stuck && log.current) log.current.scrollTop = 0;
  }, [lines, channel, stuck, collapsed]);
  function pick(next: "global" | "near") {
    drafts.current[channel] = draft;
    setChannel(next);
    setDraft(drafts.current[next]);
    setStuck(true);
    setCollapsed(false);
  }
  return (
    <section
      ref={panel}
      style={size ? ({
        "--chat-width": `${size.width}px`,
        "--chat-height": `${size.height}px`,
      } as CSSProperties) : undefined}
      data-world-drop-block
      className={s.chat}
      aria-label="Игровой чат"
      data-collapsed={collapsed}
    >
      <header>
        <div role="tablist" aria-label="Каналы чата">
          <button
            type="button"
            role="tab"
            aria-selected={channel === "global"}
            aria-controls="game-chat-log"
            onClick={() => pick("global")}
          >
            <svg
              viewBox="0 0 24 24"
              width="15"
              height="15"
              fill="currentColor"
              aria-hidden
            >
              <path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-6 4v-4H2V5a2 2 0 0 1 2-2Z" />
            </svg>
            Глобал
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={channel === "near"}
            aria-controls="game-chat-log"
            onClick={() => pick("near")}
          >
            <Icon name="paw" size={15} />
            Рядом
          </button>
        </div>
        <div className={s.chatActions}>
          <button
            type="button"
            aria-label={collapsed ? "Развернуть чат" : "Свернуть чат"}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden
            >
              <path
                d={collapsed ? "M5 19 19 5M8 5h11v11" : "M19 5 5 19M5 8v11h11"}
              />
            </svg>
          </button>
          {!collapsed && (
            <button
              type="button"
              className={s.chatResize}
              aria-label="Изменить размер чата"
              title="Потяните за угол или используйте клавиши со стрелками"
              onPointerDown={event => {
                const bounds = panel.current?.getBoundingClientRect();
                if (!bounds || !event.isPrimary || event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = {
                  pointer: event.pointerId,
                  x: event.clientX,
                  y: event.clientY,
                  width: bounds.width,
                  height: bounds.height,
                };
              }}
              onPointerMove={event => {
                const start = drag.current;
                if (!start || start.pointer !== event.pointerId) return;
                setSize({
                  width: start.width + event.clientX - start.x,
                  height: start.height + start.y - event.clientY,
                });
              }}
              onLostPointerCapture={() => { drag.current = null; }}
              onKeyDown={event => {
                const bounds = panel.current?.getBoundingClientRect();
                if (!bounds) return;
                const horizontal = event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : 0;
                const vertical = event.key === "ArrowUp" ? 16 : event.key === "ArrowDown" ? -16 : 0;
                if (!horizontal && !vertical) return;
                event.preventDefault();
                event.stopPropagation();
                setSize({ width: bounds.width + horizontal, height: bounds.height + vertical });
              }}
              onKeyUp={event => {
                if (event.key.startsWith("Arrow")) event.stopPropagation();
              }}
            >
              <svg viewBox="0 0 20 20" width="17" height="17" fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                <path d="M4 14 14 4m-7 0h7v7M9 15l6-6" />
              </svg>
            </button>
          )}
        </div>
      </header>
      <div
        id="game-chat-log"
        ref={log}
        className={s.chatLog}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        onScroll={() => setStuck((log.current?.scrollTop || 0) < 28)}
      >
        {!ordered.length ? (
          <div className={s.chatEmpty}>
            <span aria-hidden>
              <Icon name="paw" size={32} />
            </span>
            <p>Пока нет сообщений…</p>
          </div>
        ) : (
          ordered.map((line) => (
            <p key={`${line.channel}:${line.room}:${line.seq}`}>
              <time>
                {new Date(line.ts).toLocaleTimeString("ru-RU", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
              <strong
                style={{
                  color:
                    line.color && /^#[a-f0-9]{6}$/i.test(line.color)
                      ? line.color
                      : "#e2c59c",
                }}
              >
                {line.login}
              </strong>
              {(
                line.characterId
                  ? line.characterId === characterId
                  : line.id === meId
              ) ? (
                <small> · вы</small>
              ) : null}
              <span>: {line.text}</span>
            </p>
          ))
        )}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (text && onSend(text, channel)) {
            setDraft("");
            drafts.current[channel] = "";
            setStuck(true);
          }
        }}
      >
        <label className="sr-only" htmlFor="roomChatInput">
          Сообщение
        </label>
        <input
          id="roomChatInput"
          autoComplete="off"
          maxLength={200}
          value={draft}
          disabled={!canSend}
          placeholder={canSend ? "Введите сообщение…" : "Нет связи с сервером"}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={() => setCollapsed(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
        <button
          type="submit"
          aria-label="Отправить сообщение"
          disabled={!canSend || !draft.trim()}
        >
          ➤
        </button>
      </form>
    </section>
  );
}

"use client";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { CoopChatMessage } from "@/lib/net/coop";
import { Icon } from "@/components/players/profile-icons";
import { CONTROL_ROWS } from "../simulator/components/key-hint";
import { GameChat } from "./game-chat";
import { WorldItems } from "./world-items";
import { usePlayerStats } from "./use-player-stats";
import { PlayerStatsHud, PlayerStatsDetails } from "./player-stats";
import statsStyle from "./player-stats.module.css";
import { InventoryPanel } from "./inventory-panel";
import { useInventory } from "./use-inventory";
import s from "./game-hud.module.css";
export type GameHudProps = {
  characterId?: string;
  canSprintRef: RefObject<boolean>;
  characterName: string;
  editorOpen: boolean;
  lines: CoopChatMessage[];
  meId: number | null;
  canSend: boolean;
  onSend: (text: string, channel?: "global" | "near") => boolean;
  weather: boolean;
  day: boolean;
  battle: boolean;
  onWeather: (value: boolean) => void;
  onDay: (value: boolean) => void;
  onBattle: () => void;
  onEditor: () => void;
  canEdit: boolean;
  advanced: ReactNode;
  status: string;
  peers: number;
  credits: string;
  battleLog?: ReactNode;
};

function BackpackIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="27"
      height="27"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden
    >
      <path d="M8 7V5a4 4 0 0 1 8 0v2M6 7h12l2 4v10H4V11zM4 12h16M8 12v3m8-3v3M8 18h8" />
    </svg>
  );
}
function BookIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="27"
      height="27"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden
    >
      <path d="M12 5C8 2 4 3 2 4v16c4-2 7-2 10 0 3-2 6-2 10 0V4c-2-1-6-2-10 1zM12 5v15" />
    </svg>
  );
}
export function GameHud(props: GameHudProps) {
  const [panel, setPanel] = useState<
      "inventory" | "settings" | "controls" | "stats" | null
    >(null),
    [settingsTab, setSettingsTab] = useState<"basic" | "advanced" | "log">(
      "basic",
    ),
    [selected, setSelected] = useState(0);
  const stats = usePlayerStats(props.canSprintRef, props.characterId, props.meId);
  const inventory = useInventory(props.characterId, props.meId),
    close = () => setPanel(null),
    panelRef = useRef(panel),
    editor = useRef(props.editorOpen),
    previousFocus = useRef<HTMLElement | null>(null),
    dialog = useRef<HTMLDivElement>(null);
  panelRef.current = panel;
  editor.current = props.editorOpen;
  useEffect(() => {
    setPanel(null);
    setSelected(0);
  }, [props.characterId]);
  useEffect(() => {
    if (props.editorOpen) setPanel(null);
  }, [props.editorOpen]);
  useEffect(() => {
    if (!panel) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    window.dispatchEvent(new Event("game-ui:pause-controls"));
    const id = requestAnimationFrame(() => {
      const node = document.querySelector<HTMLElement>("[data-game-dialog]");
      node
        ?.querySelector<HTMLElement>("button")
        ?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(id);
      previousFocus.current?.focus({ preventScroll: true });
    };
  }, [panel]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (editor.current || event.ctrlKey || event.metaKey || event.altKey)
        return;
      const target = event.target as HTMLElement | null,
        isInput =
          !!target &&
          (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
            target.isContentEditable);
      if (event.code === "Escape" && panelRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPanel(null);
        return;
      }
      if (isInput) return;
      if (event.code === "KeyB") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat)
          setPanel((old) => (old === "inventory" ? null : "inventory"));
        return;
      }
      const digit = /^(?:Digit|Numpad)([1-5])$/.exec(event.code);
      if (digit && (!panelRef.current || panelRef.current === "inventory")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setSelected(Number(digit[1]) - 1);
        return;
      }
      if (
        event.code === "Enter" &&
        !panelRef.current &&
        target?.tagName !== "BUTTON"
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.dispatchEvent(new Event("game-chat:focus"));
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  function trap(event: React.KeyboardEvent) {
    if (event.key !== "Tab") return;
    const root = (event.target as HTMLElement).closest("[data-game-dialog]");
    const nodes = root?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
    );
    if (!nodes?.length) return;
    const first = nodes[0],
      last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  if (props.editorOpen) return null;
  return (
    <div className={s.hud} onKeyDown={trap}>
      <WorldItems
        meId={props.meId}
        controller={inventory}
        characterId={props.characterId}
        blocked={!!panel}
      />
      <GameChat
        lines={props.lines}
        characterId={props.characterId}
        meId={props.meId}
        canSend={props.canSend}
        onSend={props.onSend}
      />
      <nav className={s.rail} aria-label="Меню игрового поля">
        <button
          type="button"
          title="Настройки"
          aria-label="Настройки игры"
          aria-expanded={panel === "settings"}
          onClick={() => {
            setPanel((old) => (old === "settings" ? null : "settings"));
            setSettingsTab("basic");
          }}
        >
          <Icon name="gear" size={27} />
        </button>
        <button
          type="button"
          title="Инвентарь [B]"
          aria-label="Инвентарь [B]"
          aria-expanded={panel === "inventory"}
          onClick={() =>
            setPanel((old) => (old === "inventory" ? null : "inventory"))
          }
        >
          <BackpackIcon />
        </button>
        <button
          type="button"
          title="Краткое управление"
          aria-label="Краткое управление"
          aria-expanded={panel === "controls"}
          onClick={() =>
            setPanel((old) => (old === "controls" ? null : "controls"))
          }
        >
          <BookIcon />
        </button>
        <button
          type="button"
          title="Игроки — скоро"
          aria-label="Игроки — скоро"
          aria-disabled="true"
        >
          <Icon name="users" size={27} />
        </button>
      </nav>
      <InventoryPanel
        controller={inventory}
        open={panel === "inventory"}
        onClose={close}
        selected={selected}
        onSelect={setSelected}
        characterName={props.characterName}
        blocked={!!panel && panel !== "inventory"}
      />
      <PlayerStatsHud stats={stats} onOpen={() => setPanel("stats")} />
      {panel === "settings" || panel === "controls" || panel === "stats" ? (
        <div
          className={s.modalBackdrop}
          onPointerDown={(event) => {
            if (event.currentTarget === event.target) close();
          }}
        >
          <div
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="game-dialog-title"
            data-game-dialog
            className={panel === "stats" ? `${s.dialog} ${statsStyle.details}` : s.dialog}
          >
            <header>
              <h2 id="game-dialog-title">
                {panel === "settings" ? "Настройки" : panel === "stats" ? "Подробнее" : "Управление"}
              </h2>
              <button type="button" onClick={close} aria-label="Закрыть окно">
                ×
              </button>
            </header>
            {panel === "stats" ? <PlayerStatsDetails stats={stats} characterId={props.characterId} /> : panel === "controls" ? (
              <>
                <p className={s.lead}>Всё необходимое для путешествия</p>
                <dl className={s.keys}>
                  {CONTROL_ROWS.map((row) => (
                    <div key={row.label}>
                      <dt>
                        <kbd>{row.keys.join(" ")}</kbd>
                      </dt>
                      <dd>{row.label}</dd>
                    </div>
                  ))}
                </dl>
                <p className={s.muted}>
                  На сенсорном экране используйте джойстик и кнопку прыжка.
                </p>
              </>
            ) : (
              <>
                <div
                  className={s.settingsTabs}
                  role="tablist"
                  aria-label="Настройки игры"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={settingsTab === "basic"}
                    onClick={() => setSettingsTab("basic")}
                  >
                    Настройки
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={settingsTab === "advanced"}
                    onClick={() => setSettingsTab("advanced")}
                  >
                    Расширенные
                  </button>
                  {props.battleLog ? (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={settingsTab === "log"}
                      onClick={() => setSettingsTab("log")}
                    >
                      Лог боя
                    </button>
                  ) : null}
                </div>
                <div role="tabpanel" className={s.settingsBody}>
                  {settingsTab === "advanced" ? (
                    props.advanced
                  ) : settingsTab === "log" ? (
                    props.battleLog
                  ) : (
                    <>
                      <div className={s.settingRow}>
                        <div>
                          <strong>Погода</strong>
                          <small>Облака и осадки на вашем экране</small>
                        </div>
                        <button
                          type="button"
                          aria-pressed={props.weather}
                          onClick={() => props.onWeather(!props.weather)}
                        >
                          {props.weather ? "Включена" : "Выключена"}
                        </button>
                      </div>
                      <div className={s.settingRow}>
                        <div>
                          <strong>Сутки</strong>
                          <small>Подкраска поля по времени суток</small>
                        </div>
                        <button
                          type="button"
                          aria-pressed={props.day}
                          onClick={() => props.onDay(!props.day)}
                        >
                          {props.day ? "Включены" : "Выключены"}
                        </button>
                      </div>
                      <div className={s.settingRow}>
                        <div>
                          <strong>Боевой режим</strong>
                          <small>
                            Включается с клетки захода в боевую зону
                          </small>
                        </div>
                        <button
                          type="button"
                          aria-pressed={props.battle}
                          onClick={props.onBattle}
                        >
                          {props.battle ? "Включён" : "Выключен"}
                        </button>
                      </div>
                      {props.canEdit ? (
                        <button
                          className={s.editorLink}
                          type="button"
                          onClick={() => {
                            setPanel(null);
                            props.onEditor();
                          }}
                        >
                          ✎ Редактор локации
                        </button>
                      ) : null}
                      <p className={s.muted}>
                        {props.peers} на поле · {props.status}
                      </p>
                      <p className={s.credits}>{props.credits}</p>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

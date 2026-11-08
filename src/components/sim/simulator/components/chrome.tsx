/**
 * UI chrome around the canvas, carved out of simulator.tsx verbatim (W5b
 * stage 2, behavior-preserving): the top SimHeader bar (title, live hidden
 * params, theme select, editor / perspective / battle / settings buttons),
 * the draggable ColResize separator, the slide-in SettingsPanelOverlay and
 * the RoomSwitchOverlay modal. Contract: each component receives the exact
 * identifiers it used inline (props keep the original closure names, JSX
 * bodies are byte-identical); parents keep rendering the same DOM tree —
 * the component wrapper adds no DOM nodes.
 */
import { useRef, type ComponentProps, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { Button } from '@/components/ui/button';
import { RoomPicker, type RoomRow } from '../../room-picker';
import { SettingsPanel } from '../../settings-panel';
import { fmtSec } from '../sim-model';
import { damageLevelLabel, type SimSettings } from '@/lib/sim/settings';
import { THEMES, type ThemeId } from '@/lib/sim/theme';
import { roomTitle, type CoopRoomInfo } from '@/lib/net/coop';

/**
 * Вертикальный разделитель между колонками: тянется мышью, меняя ширину
 * соседней панели. Сам ничего не хранит — отдаёт дельту dx родителю.
 */
export function ColResize({ onDrag, onEnd }: { onDrag: (dx: number) => void; onEnd: () => void }) {
  const last = useRef(0);
  const dragging = useRef(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Потяните, чтобы изменить ширину панели"
      title="Потяните, чтобы изменить ширину"
      onPointerDown={(ev) => {
        ev.preventDefault();
        ev.currentTarget.setPointerCapture(ev.pointerId);
        last.current = ev.clientX;
        dragging.current = true;
      }}
      onPointerMove={(ev) => {
        if (!dragging.current || !(ev.buttons & 1)) return;
        onDrag(ev.clientX - last.current);
        last.current = ev.clientX;
      }}
      onPointerUp={(ev) => {
        if (!dragging.current) return;
        dragging.current = false;
        try {
          ev.currentTarget.releasePointerCapture(ev.pointerId);
        } catch {}
        onEnd();
      }}
      onPointerCancel={() => {
        dragging.current = false;
        onEnd();
      }}
      className="hidden w-1.5 shrink-0 cursor-col-resize touch-none rounded bg-[var(--sim-divider)] transition-colors hover:bg-[var(--sim-accent-soft)] active:bg-[var(--sim-accent-soft)] lg:block"
    />
  );
}

export interface SimulatorHeaderProps {
  settings: SimSettings;
  roomCode: string;
  peerCount: number;
  netStatus: string;
  theme: ThemeId;
  changeTheme: (t: ThemeId) => void;
  fieldFormat: 'grid' | 'test';
  editorOpen: boolean;
  closeEditor: () => void;
  openEditor: () => void;
  testField: boolean;
  patchCharacter: (p: Partial<SimSettings['character']>) => void;
  toggleBattleMode: () => void;
  patchArrow: (p: Partial<SimSettings['arrow']>) => void;
  /** Локальные тумблеры атмосферы (только поле «теста»): погода — частицы,
   *  сутки — цветовая вуаль. По сети не едут, у каждого игрока свои. */
  weatherFxOn: boolean;
  toggleWeatherFx: (on: boolean) => void;
  dayTintOn: boolean;
  toggleDayTint: (on: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setRoomsStale: Dispatch<SetStateAction<boolean>>;
  setSwitchOpen: Dispatch<SetStateAction<boolean>>;
  /** Несколько комнат на этой странице — иначе кнопка перехода не нужна. */
  canSwitch?: boolean;
}

export function SimulatorHeader(props: SimulatorHeaderProps) {
  const {
    settings,
    roomCode,
    peerCount,
    netStatus,
    theme,
    changeTheme,
    fieldFormat,
    editorOpen,
    closeEditor,
    openEditor,
    testField,
    patchCharacter,
    toggleBattleMode,
    patchArrow,
    weatherFxOn,
    toggleWeatherFx,
    dayTintOn,
    toggleDayTint,
    settingsOpen,
    setSettingsOpen,
    setRoomsStale,
    setSwitchOpen,
    canSwitch = true,
  } = props;
  return (
  <header className="relative z-10 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--sim-line)] bg-[var(--sim-panel)] px-4 py-2.5">
    {testField ? <span aria-label="Игроков на поле" className="text-xs text-[var(--sim-text-muted)]">{peerCount} на поле</span> : <>
    <div>
      <h1 className="text-base font-bold leading-tight">abnocw</h1>
      <p className="text-[11px] text-[var(--sim-text-faint)]">
        {settings.field.cols}×{settings.field.rows} · {roomCode ? roomTitle(roomCode) : 'комната не выбрана'} · {peerCount} на поле
      </p>
    </div>
    {/* Панелька выбранных скрытых параметров (СП): живая, повторяет блок «Выбор СП» с экрана входа */}
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-[var(--sim-line-strong)] bg-[var(--sim-inset-soft)] px-2.5 py-1 text-[11px]"
      aria-label="Выбранные скрытые параметры"
    >
      <span className="font-bold text-[var(--sim-text)]">СП:</span>
      <span className="text-[var(--sim-text-muted)]">
        стрела <b className="font-semibold text-[var(--sim-text)]">{fmtSec(settings.arrow.periodSec)}</b>
      </span>
      <span className="text-[var(--sim-text-faint)]">·</span>
      <span className="text-[var(--sim-text-muted)]">
        дамаг <b className="font-semibold text-[var(--sim-text)]">{damageLevelLabel(settings.combat.damageLevel)}</b>
      </span>
      <span className="text-[var(--sim-text-faint)]">·</span>
      <span className="text-[var(--sim-text-muted)]">
        броня <b className="font-semibold text-[var(--sim-text)]">{damageLevelLabel(settings.combat.armorLevel)}</b>
      </span>
    </div>
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <Button asChild size="sm" variant="outline" className="btn-neutral h-8 text-xs">
        <a href="/">Главное меню</a>
      </Button>
      {canSwitch ? (
        <Button
          size="sm"
          variant="outline"
          className="btn-neutral h-8 text-xs"
          onClick={() => {
            setRoomsStale(false);
            setSwitchOpen(true);
          }}
        >
          Перейти в другую комнату
        </Button>
      ) : null}
      <span className="max-w-[280px] truncate text-[var(--sim-text-muted)]">{netStatus}</span>
    </div>
    </>}
    <div className="relative z-10 ml-auto flex flex-wrap items-center gap-2">
      {!testField ? <label className="flex items-center gap-1 text-xs text-[var(--sim-text-muted)]">
        тема
        <select
          value={theme}
          onChange={(ev) => changeTheme(ev.target.value as ThemeId)}
          className="h-8 rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-input-bg)] px-1.5 text-xs text-[var(--sim-text)] outline-none"
        >
          {THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label> : null}
      {fieldFormat === 'test' ? (
        <Button
          size="sm"
          variant={editorOpen ? 'default' : 'outline'}
          className={
            editorOpen
              ? 'h-8 bg-[var(--sim-accent)] text-xs text-white hover:bg-[var(--sim-accent-hover)]'
              : 'btn-neutral h-8 text-xs'
          }
          onClick={() => (editorOpen ? closeEditor() : openEditor())}
        >
          Редактор локации
        </Button>
      ) : null}
      {testField ? (
        <>
          <Button
            size="sm"
            variant={weatherFxOn ? 'default' : 'outline'}
            className={
              weatherFxOn
                ? 'h-8 bg-[var(--sim-accent)] text-xs text-white hover:bg-[var(--sim-accent-hover)]'
                : 'btn-neutral h-8 text-xs'
            }
            title="Облака и дождь на поле. Выключение — только у вас: комнатную погоду это не меняет, у остальных остаётся своя картинка."
            onClick={() => toggleWeatherFx(!weatherFxOn)}
          >
            Погода: {weatherFxOn ? 'ВКЛ' : 'ВЫКЛ'}
          </Button>
          <Button
            size="sm"
            variant={dayTintOn ? 'default' : 'outline'}
            className={
              dayTintOn
                ? 'h-8 bg-[var(--sim-accent)] text-xs text-white hover:bg-[var(--sim-accent-hover)]'
                : 'btn-neutral h-8 text-xs'
            }
            title="Подкраска времени суток (утро/день/вечер/ночь). Выключение — только у вас: цикл суток продолжается, часы на HUD остаются."
            onClick={() => toggleDayTint(!dayTintOn)}
          >
            Сутки: {dayTintOn ? 'ВКЛ' : 'ВЫКЛ'}
          </Button>
          <Button
            size="sm"
            variant={settings.arrow.battleMode ? 'default' : 'outline'}
            className={
              settings.arrow.battleMode
                ? 'h-8 bg-[var(--sim-accent)] text-xs text-white hover:bg-[var(--sim-accent-hover)]'
                : 'btn-neutral h-8 text-xs'
            }
            title="Вход в бой — с клетки захода (две галочки у боевой зоны): встаньте на неё и нажмите. Выключение на боевой клетке возвращает на заход. Клавиша B."
            onClick={toggleBattleMode}
          >
            Боевой режим: {settings.arrow.battleMode ? 'ВКЛ' : 'ВЫКЛ'} (B)
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant={settings.arrow.battleMode ? 'default' : 'outline'}
          className={
            settings.arrow.battleMode
              ? 'h-8 bg-[var(--sim-accent)] text-xs text-white hover:bg-[var(--sim-accent-hover)]'
              : 'btn-neutral h-8 text-xs'
          }
          onClick={() => patchArrow({ battleMode: !settings.arrow.battleMode })}
        >
          Боевой режим: {settings.arrow.battleMode ? 'ВКЛ' : 'ВЫКЛ'} (B)
        </Button>
      )}
      <Button
        size="sm"
        variant={settingsOpen ? 'default' : 'outline'}
        className={settingsOpen ? 'h-8 bg-[var(--sim-accent)] text-xs text-white hover:bg-[var(--sim-accent-hover)]' : 'btn-neutral h-8 text-xs'}
        onClick={() => setSettingsOpen((v) => !v)}
      >
        Настройки
      </Button>
    </div>
  </header>
  );
}

type PanelProps = ComponentProps<typeof SettingsPanel>;

export interface SettingsPanelOverlayProps {
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  settings: PanelProps['settings'];
  testField: PanelProps['testField'];
  atmoState: PanelProps['atmo'];
  changeAtmo: PanelProps['onAtmo'];
  changeAtmoCfg: PanelProps['onAtmoCfg'];
  atmoLayerOn: PanelProps['atmoLayerOn'];
  toggleAtmoLayer: PanelProps['onAtmoLayer'];
  dummyOn: PanelProps['dummyOn'];
  toggleDummy: PanelProps['onToggleDummy'];
  dummySprite: PanelProps['dummySprite'];
  changeDummySprite: PanelProps['onDummySprite'];
  rabOn: PanelProps['rabOn'];
  toggleRab: PanelProps['onToggleRab'];
  patchField: PanelProps['patchField'];
  patchCharacter: PanelProps['patchCharacter'];
  patchArrow: PanelProps['patchArrow'];
  patchSlowdown: PanelProps['patchSlowdown'];
  patchWindow: PanelProps['patchWindow'];
  patchTier: PanelProps['patchTier'];
  patchHud: PanelProps['patchHud'];
  patchCombat: PanelProps['patchCombat'];
  patchZone: PanelProps['patchZone'];
  onResetCombat: PanelProps['onResetCombat'];
  onResetAll: PanelProps['onResetAll'];
  onExport: PanelProps['onExport'];
  onImport: PanelProps['onImport'];
  getEngineAngle: PanelProps['getAngle'];
  setEngineAngle: PanelProps['onManualAngle'];
  /** Роль сессии (whoami): админ-вкладки настроек рендерит только админу. */
  role?: PanelProps['role'];
}

export function SettingsPanelOverlay(props: SettingsPanelOverlayProps) {
  const {
    setSettingsOpen,
    settings,
    testField,
    atmoState,
    changeAtmo,
    changeAtmoCfg,
    atmoLayerOn,
    toggleAtmoLayer,
    dummyOn,
    toggleDummy,
    dummySprite,
    changeDummySprite,
    rabOn,
    toggleRab,
    patchField,
    patchCharacter,
    patchArrow,
    patchSlowdown,
    patchWindow,
    patchTier,
    patchHud,
    patchCombat,
    patchZone,
    onResetCombat,
    onResetAll,
    onExport,
    onImport,
    getEngineAngle,
    setEngineAngle,
    role,
  } = props;
  return (
        <>
          <div className="fixed inset-0 z-30 bg-black/50" onClick={() => setSettingsOpen(false)} />
          <aside
            className="fixed inset-y-0 right-0 z-40 flex w-[min(400px,92vw)] flex-col border-l border-[var(--sim-line)] bg-[var(--sim-panel)] shadow-2xl"
            onKeyDown={(ev) => {
              if (ev.key === 'Escape') setSettingsOpen(false);
            }}
          >
            <div className="flex items-center justify-between border-b border-[var(--sim-line)] px-3 py-2">
              <h2 className="text-sm font-bold text-[var(--sim-text)]">Настройки</h2>
              <Button size="sm" variant="outline" className="btn-neutral h-7 text-xs" onClick={() => setSettingsOpen(false)}>
                Закрыть
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <SettingsPanel
                settings={settings}
                testField={testField}
                atmo={atmoState}
                onAtmo={changeAtmo}
                atmoCfg={settings.atmo}
                onAtmoCfg={changeAtmoCfg}
                atmoLayerOn={atmoLayerOn}
                onAtmoLayer={toggleAtmoLayer}
                dummyOn={dummyOn}
                onToggleDummy={toggleDummy}
                dummySprite={dummySprite}
                onDummySprite={changeDummySprite}
                rabOn={rabOn}
                onToggleRab={toggleRab}
                patchField={patchField}
                patchCharacter={patchCharacter}
                patchArrow={patchArrow}
                patchSlowdown={patchSlowdown}
                patchWindow={patchWindow}
                patchTier={patchTier}
                patchHud={patchHud}
                patchCombat={patchCombat}
                patchZone={patchZone}
                onResetCombat={onResetCombat}
                onResetAll={onResetAll}
                onExport={onExport}
                onImport={onImport}
                getAngle={getEngineAngle}
                onManualAngle={setEngineAngle}
                role={role}
              />
            </div>
          </aside>
        </>
  );
}

export interface RoomSwitchOverlayProps {
  setSwitchOpen: Dispatch<SetStateAction<boolean>>;
  roomRows: RoomRow[];
  roomsRows: CoopRoomInfo[] | null;
  roomsStale: boolean;
  pickRoom: (room: string) => void;
}

export function RoomSwitchOverlay(props: RoomSwitchOverlayProps) {
  const { setSwitchOpen, roomRows, roomsRows, roomsStale, pickRoom } = props;
  return (
        <>
          <div className="fixed inset-0 z-30 bg-black/50" onClick={() => setSwitchOpen(false)} />
          <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto p-4">
            <div className="w-full max-w-3xl rounded-2xl border border-[var(--sim-line)] bg-[var(--sim-panel)] shadow-2xl">
              <RoomPicker
                rows={roomRows}
                ready={roomsRows !== null}
                stale={roomsStale}
                onPick={pickRoom}
                onCancel={() => setSwitchOpen(false)}
              />
            </div>
          </div>
        </>
  );
}

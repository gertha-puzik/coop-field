/**
 * Keyboard & focus wiring of the Simulator, carved out verbatim from
 * simulator.tsx (W5b stage 2, behavior-preserving). Contract:
 * `useSimKeyboard(deps)` attaches exactly one window keydown/keyup/blur
 * listener set (deps array stays `[]`) and owns the semantics of every
 * gameplay key: WASD/QEZX steps, J/L arrow rotation, K block, I strike,
 * Space jelly/leap charge, B battle toggle, Enter chat focus, Escape editor,
 * [ ] editor tool size (same as Alt+wheel).
 * All mutable state stays in the caller's refs (SimKeyboardDeps); the effect
 * closes over the first-render `closeEditor`, one-to-one with the inline form.
 */
import { useEffect, type RefObject } from 'react';
import type { SimSettings } from '@/lib/sim/settings';
import type { Engine } from '../sim-model';
import type { createCoopClient } from '@/lib/net/coop';
import { keyAction } from '@/lib/sim/keys';
import { strikeResponseMs } from '@/lib/sim/targeting';

export interface SimKeyboardDeps {
  sprintRef: RefObject<boolean>;
  enteredRef: RefObject<boolean>;
  editorOpenRef: RefObject<boolean>;
  settingsRef: RefObject<SimSettings>;
  engineRef: RefObject<Engine>;
  spaceHoldRef: RefObject<{ holding: boolean; since: number; releaseAt: number; charge: number }>;
  netRef: RefObject<ReturnType<typeof createCoopClient> | null>;
  fieldFormatRef: RefObject<'grid' | 'test'>;
  battleToggleRef: RefObject<() => void>;
  doStrikeRef: RefObject<(() => void) | null>;
  startStepRef: RefObject<((dir: number) => void) | null>;
  leapRequestRef: RefObject<number | null>;
  editorSizeStepRef: RefObject<((dir: 1 | -1) => void) | null>;
  closeEditor: () => void;
}

export function useSimKeyboard(deps: SimKeyboardDeps) {
  const {
    sprintRef,
    enteredRef,
    editorOpenRef,
    settingsRef,
    engineRef,
    spaceHoldRef,
    netRef,
    fieldFormatRef,
    battleToggleRef,
    doStrikeRef,
    startStepRef,
    leapRequestRef,
    editorSizeStepRef,
    closeEditor,
  } = deps;
  useEffect(() => {
    const isForm = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    };
    const down = (ev: KeyboardEvent) => {
      // Shift — спринт мирного режима (×2 к скорости + комочки из-под лап):
      // ловим раньше всех ранних выходов, зажатие не зависит от контекста
      if (ev.key === 'Shift') sprintRef.current = true;
      if (!enteredRef.current) return;
      if (isForm(ev.target)) return;
      // Редактор локации: Esc — закрыть (черновик без записи), игровые клавиши молчат.
      // [ ] — размер инструмента (кисть/объект), как Alt+колесо; ловим по code,
      // чтобы скобки работали на любой раскладке.
      if (editorOpenRef.current) {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          closeEditor();
        } else if (ev.code === 'BracketLeft' || ev.code === 'BracketRight') {
          ev.preventDefault();
          editorSizeStepRef.current?.(ev.code === 'BracketRight' ? 1 : -1);
        }
        return;
      }
      // Пробел — «приседание-желе» своего кота: удержание приплющивает модельку
      // (полный эффект за 4 с, с дрожью), отпускание выстреливает её вверх.
      // Автоповтор ОС не перезапускает приседание — важен только первый нажатие.
      if (ev.code === 'Space' || ev.key === ' ') {
        ev.preventDefault();
        if (!ev.repeat && settingsRef.current.controlled === 'main' && !engineRef.current.blocking) {
          const sp = spaceHoldRef.current;
          if (!sp.holding) {
            sp.holding = true;
            sp.since = performance.now();
            sp.releaseAt = 0;
            sp.charge = 0;
            // Присед видят все: комнату ставим в известность (эхо себе не приходит).
            netRef.current?.emit('space', { on: true });
          }
        }
        return;
      }
      const action = keyAction(ev);
      const t = ev.target as HTMLElement | null;
      if (t && t.tagName === 'BUTTON' && (action?.type === 'chat' || ev.code === 'Space' || ev.key === ' ')) t.blur();
      // автоповтор ОС игнорируем: каждое физическое нажатие — ровно одно срабатывание;
      // темп движения ограничен только замедлением (спам не превышает скорость шага)
      if (ev.repeat) return;
      if (!action) return;
      const eB = engineRef.current;
      // Блок (удержание К): встаёт в стойку сразу, снимается отпусканием.
      if (action.type === 'block') {
        ev.preventDefault();
        // Блок — стойка игрока (своего кота): за манекеном блокировать нечего.
        if (settingsRef.current.controlled !== 'main' || eB.blocking) return;
        eB.blocking = true;
        // В блоке нельзя двигаться, бить и крутить стрелу — всё начатое прекращаем.
        eB.held = [];
        eB.path = [];
        eB.step = null;
        eB.rot = 0;
        eB.strikeHeld = false;
        netRef.current?.emit('block', { on: true });
        return;
      }
      // Пока блок держится — движение, удары и вращение не работают.
      if (eB.blocking && (action.type === 'rot' || action.type === 'strike' || action.type === 'move')) {
        ev.preventDefault();
        return;
      }
      if (action.type === 'rot') {
        ev.preventDefault();
        engineRef.current.rot = action.sign;
        return;
      }
      if (action.type === 'chat') {
        if (t?.tagName === 'BODY' || t?.tagName === 'CANVAS') {
          ev.preventDefault();
          document.getElementById('roomChatInput')?.focus();
        }
        return;
      }
      if (action.type === 'battle') {
        // В «тесте» бой включается кнопкой с клетки захода (та же логика, что
        // у кнопки в шапке); в обычных комнатах B — прямой тумблер.
        battleToggleRef.current();
        return;
      }
      if (action.type === 'strike') {
        ev.preventDefault();
        const e = engineRef.current;
        e.strikeHeld = true;
        e.nextHoldStrike = performance.now() + strikeResponseMs(settingsRef.current);
        doStrikeRef.current?.();
        return;
      }
      ev.preventDefault();
      const e = engineRef.current;
      if (!e.held.includes(action.dir)) {
        e.held.push(action.dir);
        e.path = [];
      }
      // мирный «тест»: ходьба свободная (по пикселям) — её ведёт игровой цикл
      // по зажатым клавишам; клик-цель перебивается клавишами там же.
      const sK = settingsRef.current;
      if (fieldFormatRef.current === 'test' && !sK.arrow.battleMode && sK.controlled === 'main') {
        e.ptarget = null;
        return;
      }
      // одиночное нажатие: шаг сразу, если предыдущий завершён, — быстрее,
      // чем разрешает замедление, двигаться нельзя
      startStepRef.current?.(action.dir);
    };
    const up = (ev: KeyboardEvent) => {
      if (ev.key === 'Shift') sprintRef.current = false;
      // Отпускание пробела — желейный «выстрел» вверх из приплющенного состояния
      // и прыжок через обрыв: заряд (длительность удержания) определяет максимальный
      // перепад. Сам прыжок запускает игровой цикл — забирает запрос из leapRequestRef.
      if (ev.code === 'Space' || ev.key === ' ') {
        const sp = spaceHoldRef.current;
        if (sp.holding) {
          sp.holding = false;
          // Заряд «выстрела» по времени удержания: тап — минимальный подпрыг,
          // полные 4 с приседа — максимальный (нижняя планка 0.15, чтобы тап
          // не был нулевым, а верхняя ровно 1 — дальше заряд не растёт).
          sp.charge = 0.15 + 0.85 * Math.min(1, (performance.now() - sp.since) / 4000);
          sp.releaseAt = performance.now();
          leapRequestRef.current = sp.charge;
          // hold — длительность удержания: чужие клиенты посчитают по ней заряд,
          // не сверяя часы (у каждого свои performance.now()).
          netRef.current?.emit('space', { on: false, hold: Math.round(sp.releaseAt - sp.since) });
        }
        return;
      }
      const e = engineRef.current;
      const action = keyAction(ev);
      if (!action) return;
      if (action.type === 'block') {
        if (e.blocking) {
          e.blocking = false;
          netRef.current?.emit('block', { on: false });
        }
        return;
      }
      if (action.type === 'rot') {
        if (action.sign === -1 && e.rot === -1) e.rot = 0;
        if (action.sign === 1 && e.rot === 1) e.rot = 0;
      } else if (action.type === 'strike') {
        e.strikeHeld = false;
      } else if (action.type === 'move') {
        e.held = e.held.filter((d) => d !== action.dir);
      }
    };
    const blur = () => {
      const e = engineRef.current;
      e.held = [];
      e.rot = 0;
      e.strikeHeld = false;
      sprintRef.current = false; // Shift при потере фокуса уже не поймаем
      // Пробел при потере фокуса: keyup не придёт — тихо снимаем присед без
      // «выстрела», иначе кот застыл бы приплющенным навсегда.
      const sp = spaceHoldRef.current;
      if (sp.holding) {
        sp.holding = false;
        sp.releaseAt = 0;
        // Присед снят без «выстрела» — чужим тоже (cancel: кот просто выпрямится).
        netRef.current?.emit('space', { on: false, cancel: true });
      }
      // Окно потеряло фокус при зажатом блоке — стойку снимаем, иначе кот
      // остался бы в блоке навсегда (keyup уже не пришёл бы).
      if (e.blocking) {
        e.blocking = false;
        netRef.current?.emit('block', { on: false });
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

}

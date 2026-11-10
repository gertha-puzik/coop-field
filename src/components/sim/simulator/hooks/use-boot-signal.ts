'use client';

import { useEffect } from 'react';

/**
 * Сообщает странице /game/, что первый кадр входа или поля уже есть.
 * Сам лоадер живёт снаружи симулятора, чтобы не растить этот файл.
 * Кадр поля — канвас с ненулевой шириной два кадра подряд. Кадр входа —
 * два кадра без канваса: экран выбора комнаты можно показать, если автовход
 * не переключил стадию. Потолок кадров не даёт крутиться вечно без канваса.
 */
export function useBootSignal(stage: 'entry' | 'field') {
  useEffect(() => {
    let frames = 0;
    let sized = 0;
    let raf = 0;
    const tick = () => {
      frames += 1;
      const canvas = document.querySelector('canvas');
      const ready = stage === 'field' && canvas instanceof HTMLCanvasElement && canvas.clientWidth > 0;
      sized = ready ? sized + 1 : 0;
      const entryReady = stage === 'entry' && frames >= 2;
      if ((stage === 'field' && sized >= 2) || entryReady || frames > 90) {
        document.documentElement.dataset.coopBoot = stage;
        window.dispatchEvent(new CustomEvent('coop:boot', { detail: stage }));
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stage]);
}

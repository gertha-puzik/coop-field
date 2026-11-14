'use client';

/**
 * Пиксельный редактор шапки (спека 2026-11-14): сетка 120×40, кисть 1/2/3,
 * ластик, заливка, пипетка, палитра ночной гаммы + свой цвет, отмена/повтор.
 * Старт — сгенерированная шапка игрока; «Сохранить» → PNG 1200×400 (×10,
 * без сглаживания) → onDone(blob). Загрузку делает вызывающий.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { paintPixels } from '@/lib/sim/banner-gen';

import { floodFill, fromHex, pick, strokeLine, toHex, type RGBA } from './banner-paint-ops';
import styles from './banner-editor.module.css';

const NIGHT: RGBA = fromHex('#0b1026');
const HISTORY = 50;
const PALETTE = [
  '#0b1026', '#1a1640', '#2b2363', '#3e3486', '#5c4a9e', '#8a6cc0',
  '#b79be0', '#efe7ff', '#14283f', '#1f4a6b', '#3a7ca5', '#8fc7e8',
  '#123329', '#22573f', '#4f8f5e', '#a6d38a', '#3a1f2e', '#7a3b5c',
  '#c76a9a', '#f2a7c8', '#f6d7a2', '#ffe9a8', '#e2985a', '#000000',
];

type Tool = 'brush' | 'eraser' | 'fill' | 'picker';

const TOOLS: { id: Tool; label: string }[] = [
  { id: 'brush', label: 'Кисть' },
  { id: 'eraser', label: 'Ластик' },
  { id: 'fill', label: 'Заливка' },
  { id: 'picker', label: 'Пипетка' },
];

export type BannerPainterProps = {
  /** Сетка редактора (шапка 120×40, аватарка 64×64) и масштаб экспорта. */
  width?: number;
  height?: number;
  scale?: number;
  /** Стартовая картинка («Начать с …»): null — не удалось, старт с чистого листа. */
  loadBase: () => Uint8ClampedArray | null | Promise<Uint8ClampedArray | null>;
  /** Цвет ластика и чистого листа (аватарка — прозрачный). */
  eraseColor?: RGBA;
  title?: string;
  hint?: string;
  baseLabel?: string;
  square?: boolean;
  busy?: boolean;
  onDone: (blob: Blob) => void;
  onCancel: () => void;
};

export function BannerPainter({
  width: W = 120,
  height: H = 40,
  scale = 10,
  loadBase,
  eraseColor = NIGHT,
  title = 'Нарисовать шапку',
  hint = 'Каждая клетка — один пиксель шапки 120×40.',
  baseLabel = 'Начать с моей шапки',
  square = false,
  busy = false,
  onDone,
  onCancel,
}: BannerPainterProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const blank = useCallback(() => {
    const b = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < b.length; i += 4) b.set(eraseColor, i);
    return b;
  }, [W, H, eraseColor]);
  const [initial] = useState(blank);
  const px = useRef<Uint8ClampedArray>(initial);
  const [note, setNote] = useState<string | null>(null);
  const undo = useRef<Uint8ClampedArray[]>([]);
  const redo = useRef<Uint8ClampedArray[]>([]);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [tool, setTool] = useState<Tool>('brush');
  const [size, setSize] = useState<1 | 2 | 3>(1);
  const [color, setColor] = useState<RGBA>(fromHex('#f6d7a2'));
  const [, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const draw = useCallback(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(px.current), W, H), 0, 0);
  }, [W, H]);

  // Стартовая картинка (сгенерированная шапка / текущая аватарка) грузится сразу.
  const base = useCallback(async () => {
    const got = await loadBase();
    return got && got.length === W * H * 4 ? got : null;
  }, [loadBase, W, H]);
  useEffect(() => {
    let live = true;
    void base().then((got) => {
      if (!live) return;
      if (got) px.current = got;
      else setNote('Текущую картинку прочитать не удалось — начните с чистого листа.');
      draw();
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- только при открытии
  }, []);

  const snapshot = () => {
    undo.current.push(new Uint8ClampedArray(px.current));
    if (undo.current.length > HISTORY) undo.current.shift();
    redo.current = [];
    setTick((t) => t + 1);
  };

  const step = useCallback(
    (from: 'undo' | 'redo') => {
      const src = from === 'undo' ? undo.current : redo.current;
      const dst = from === 'undo' ? redo.current : undo.current;
      const prev = src.pop();
      if (!prev) return;
      dst.push(new Uint8ClampedArray(px.current));
      px.current = prev;
      draw();
      setTick((t) => t + 1);
    },
    [draw],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        step(e.shiftKey ? 'redo' : 'undo');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, step]);

  const cellOf = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(W - 1, Math.floor(((e.clientX - r.left) / r.width) * W))),
      y: Math.max(0, Math.min(H - 1, Math.floor(((e.clientY - r.top) / r.height) * H))),
    };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = cellOf(e);
    if (tool === 'picker') {
      const c = pick(px.current, x, y, W, H);
      if (c[3] > 0) setColor([c[0], c[1], c[2], 255]);
      setTool('brush');
      return;
    }
    snapshot();
    if (tool === 'fill') {
      floodFill(px.current, x, y, color, W, H);
      draw();
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    last.current = { x, y };
    strokeLine(px.current, x, y, x, y, size, tool === 'eraser' ? eraseColor : color, W, H);
    draw();
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const from = last.current;
    if (!from) return;
    const { x, y } = cellOf(e);
    strokeLine(px.current, from.x, from.y, x, y, size, tool === 'eraser' ? eraseColor : color, W, H);
    last.current = { x, y };
    draw();
  };
  const onUp = () => {
    last.current = null;
  };

  const reset = (fresh: Uint8ClampedArray) => {
    snapshot();
    px.current = fresh;
    draw();
  };

  const save = () => {
    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setError('Браузер не дал нарисовать картинку.');
      return;
    }
    paintPixels(ctx, px.current, scale, W, H);
    canvas.toBlob((b) => (b ? onDone(b) : setError('Не получилось подготовить картинку.')), 'image/png');
  };

  const hex = toHex(color);

  return (
    <div className={styles.modalBack} role="dialog" aria-modal="true" aria-label={title}>
      <div className={styles.modal}>
        <header className={styles.modalHead}>
          <h2 className={styles.modalTitle}>{title}</h2>
          <p className={styles.modalHint}>{hint}</p>
        </header>
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          className={square ? `${styles.paintCanvas} ${styles.paintSquare}` : styles.paintCanvas}
          style={{ cursor: tool === 'picker' ? 'copy' : 'crosshair' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
        <div className={styles.paintTools}>
          <div className={styles.seg} role="group" aria-label="Инструмент">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={tool === t.id ? `${styles.segBtn} ${styles.segOn}` : styles.segBtn}
                aria-pressed={tool === t.id}
                onClick={() => setTool(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className={styles.seg} role="group" aria-label="Размер кисти">
            {([1, 2, 3] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={size === s ? `${styles.segBtn} ${styles.segOn}` : styles.segBtn}
                aria-pressed={size === s}
                onClick={() => setSize(s)}
              >
                {s} px
              </button>
            ))}
          </div>
          <div className={styles.seg}>
            <button type="button" className={styles.segBtn} disabled={!undo.current.length} onClick={() => step('undo')}>
              ↶ Отменить
            </button>
            <button type="button" className={styles.segBtn} disabled={!redo.current.length} onClick={() => step('redo')}>
              ↷ Вернуть
            </button>
          </div>
        </div>
        <div className={styles.palette} role="group" aria-label="Палитра">
          {PALETTE.map((h) => (
            <button
              key={h}
              type="button"
              className={hex === h ? `${styles.swatch} ${styles.swatchOn}` : styles.swatch}
              style={{ background: h }}
              aria-label={`Цвет ${h}`}
              onClick={() => {
                setColor(fromHex(h));
                if (tool === 'eraser' || tool === 'picker') setTool('brush');
              }}
            />
          ))}
          <label className={styles.customColor} title="Свой цвет">
            <input type="color" value={hex} onChange={(e) => setColor(fromHex(e.target.value))} aria-label="Свой цвет" />
          </label>
        </div>
        {note ? <p className={styles.modalHint}>{note}</p> : null}
        {error ? <p className={styles.modalError}>{error}</p> : null}
        <footer className={styles.modalFoot}>
          <Button type="button" variant="outline" size="sm" onClick={() => void base().then((got) => reset(got || blank()))}>
            {baseLabel}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => reset(blank())}>
            Чистый лист
          </Button>
          <span className={styles.footGap} />
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Отмена
          </Button>
          <Button type="button" size="sm" className={styles.primaryBtn} disabled={busy} onClick={save}>
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

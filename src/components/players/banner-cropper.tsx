'use client';

/**
 * Кадр шапки «как в Твиттере» (спека 2026-11-14): любая картинка → рамка 3:1,
 * перетаскивание (мышь/тач, pointer events), зум ползунком и колесом →
 * браузер вырезает 1200×400 и отдаёт Blob. Загрузку делает вызывающий
 * (существующий POST /cfg/banners/mine), сервер не меняется.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

import { clampOffset, coverScale, cropRect, type Offset } from './banner-crop-math';
import styles from './banner-editor.module.css';

const MAX_FILE = 10 * 1024 * 1024;
const MAX_UPLOAD = 2 * 1024 * 1024;
const ZOOM_MAX = 4;

type Loaded = { img: HTMLImageElement; w: number; h: number; png: boolean };

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

export type BannerCropperProps = {
  file: File;
  /** Размер результата и пропорция рамки (по умолчанию шапка 1200×400). */
  frameW?: number;
  frameH?: number;
  /** Скруглённая рамка (аватарка). */
  round?: boolean;
  title?: string;
  /** Максимум байт для PNG, иначе JPEG. */
  maxUpload?: number;
  busy?: boolean;
  onDone: (blob: Blob) => void;
  onCancel: () => void;
};

export function BannerCropper({
  file,
  frameW: FRAME_W = 1200,
  frameH: FRAME_H = 400,
  round = false,
  title = 'Шапка профиля',
  maxUpload = MAX_UPLOAD,
  busy = false,
  onDone,
  onCancel,
}: BannerCropperProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; off: Offset } | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(file.size > MAX_FILE ? 'Картинка больше 10 МБ — выберите поменьше.' : null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState<Offset>({ x: 0, y: 0 });
  const [k, setK] = useState(0.5);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (file.size > MAX_FILE) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    let live = true;
    img.onload = () => {
      if (!live) return;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) {
        setError('Не удалось открыть картинку.');
        return;
      }
      const s = coverScale(w, h, FRAME_W, FRAME_H);
      setLoaded({ img, w, h, png: file.type === 'image/png' });
      setZoom(1);
      setOff({ x: (FRAME_W - w * s) / 2, y: (FRAME_H - h * s) / 2 });
    };
    img.onerror = () => {
      if (live) setError('Не удалось открыть картинку — нужен PNG, JPEG, GIF или WebP.');
    };
    img.src = url;
    return () => {
      // Отменённая загрузка (смена файла, StrictMode-двойной эффект) молчит:
      // revoke ниже иначе роняет её в onerror и показывает ложную ошибку.
      live = false;
      URL.revokeObjectURL(url);
    };
  }, [file, FRAME_W, FRAME_H]);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setK(el.clientWidth / FRAME_W || 0.5);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [FRAME_W]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const base = loaded ? coverScale(loaded.w, loaded.h, FRAME_W, FRAME_H) : 1;
  const scale = base * zoom;

  const applyZoom = useCallback(
    (next: number) => {
      if (!loaded) return;
      const z = Math.min(ZOOM_MAX, Math.max(1, next));
      const ratio = z / zoom;
      const cx = FRAME_W / 2;
      const cy = FRAME_H / 2;
      const moved = { x: cx - (cx - off.x) * ratio, y: cy - (cy - off.y) * ratio };
      setZoom(z);
      setOff(clampOffset(moved, loaded.w, loaded.h, base * z, FRAME_W, FRAME_H));
    },
    [base, loaded, off, zoom, FRAME_W, FRAME_H],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!loaded) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, off };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !loaded) return;
    const next = { x: d.off.x + (e.clientX - d.x) / k, y: d.off.y + (e.clientY - d.y) / k };
    setOff(clampOffset(next, loaded.w, loaded.h, scale, FRAME_W, FRAME_H));
  };
  const endDrag = () => {
    drag.current = null;
  };

  const save = async () => {
    if (!loaded || saving) return;
    setSaving(true);
    const canvas = document.createElement('canvas');
    canvas.width = FRAME_W;
    canvas.height = FRAME_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setSaving(false);
      setError('Браузер не дал нарисовать картинку.');
      return;
    }
    ctx.imageSmoothingQuality = 'high';
    const r = cropRect(off, scale, FRAME_W, FRAME_H);
    ctx.drawImage(loaded.img, r.sx, r.sy, r.sw, r.sh, 0, 0, FRAME_W, FRAME_H);
    let blob = loaded.png ? await canvasBlob(canvas, 'image/png') : null;
    if (!blob || blob.size > maxUpload) blob = await canvasBlob(canvas, 'image/jpeg', 0.9);
    setSaving(false);
    if (!blob) {
      setError('Не получилось подготовить картинку.');
      return;
    }
    onDone(blob);
  };

  return (
    <div className={styles.modalBack} role="dialog" aria-modal="true" aria-label={`Кадрирование: ${title}`}>
      <div className={styles.modal}>
        <header className={styles.modalHead}>
          <h2 className={styles.modalTitle}>{title}</h2>
          <p className={styles.modalHint}>Перетащите картинку, чтобы выбрать видимую часть.</p>
        </header>
        <div
          ref={frameRef}
          className={round ? `${styles.cropFrame} ${styles.cropRound}` : styles.cropFrame}
          style={{ aspectRatio: `${FRAME_W} / ${FRAME_H}` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={(e) => applyZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))}
        >
          {loaded ? (
            <img
              src={loaded.img.src}
              alt=""
              draggable={false}
              className={styles.cropImg}
              style={{
                left: off.x * k,
                top: off.y * k,
                width: loaded.w * scale * k,
                height: loaded.h * scale * k,
              }}
            />
          ) : null}
          {!loaded && !error ? <span className={styles.cropWait}>Открываем картинку…</span> : null}
        </div>
        <label className={styles.zoomRow}>
          <span aria-hidden>−</span>
          <input
            type="range"
            min={1}
            max={ZOOM_MAX}
            step={0.01}
            value={zoom}
            disabled={!loaded}
            onChange={(e) => applyZoom(Number(e.target.value))}
            aria-label="Масштаб"
          />
          <span aria-hidden>+</span>
        </label>
        {error ? <p className={styles.modalError}>{error}</p> : null}
        <footer className={styles.modalFoot}>
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Отмена
          </Button>
          <Button type="button" size="sm" className={styles.primaryBtn} disabled={!loaded || saving || busy} onClick={() => void save()}>
            {saving || busy ? 'Сохраняем…' : 'Сохранить'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

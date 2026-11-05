/**
 * Field HUD canvas painters, carved out of simulator.tsx verbatim (W5b stage 2,
 * behavior-preserving). Pure canvas drawing: no React, no refs, no engine state.
 * Contract: the only public export is `drawFieldHud(cv, vw, vh, p4, weather,
 * weatherPrev, weatherAt)` — called once per frame by the game loop in
 * simulator.tsx to paint the day/night dial and the weather badge overlay.
 * Internal helpers (hudCloud/hudSun/hudMoon/hudWeatherIcon) and geometry
 * constants stay module-private on purpose.
 */
import { DAYPART_LABEL, dayPartOfProgress, type WeatherKind } from '@/lib/sim/settings';

/* ---------- HUD поля: циферблат «день/ночь» и значок погоды ---------- */

/** Радиус циферблата и значка погоды (px экрана), отступ от угла поля и зазор. */
const HUD_DIAL_R = 21;
const HUD_WX_R = 13;
const HUD_PAD = 12;
const HUD_GAP = 10;
const HUD_DEG = Math.PI / 180;
const HUD_NIGHT_SKY = '#182a5c';

/** Облако из кругов с подошвой — и на светлой половине циферблата, и в значке погоды. */
function hudCloud(g: CanvasRenderingContext2D, x: number, y: number, s: number, fill: string): void {
  g.fillStyle = fill;
  g.beginPath();
  g.arc(x - s * 0.45, y + s * 0.15, s * 0.42, 0, Math.PI * 2);
  g.arc(x + s * 0.05, y - s * 0.2, s * 0.55, 0, Math.PI * 2);
  g.arc(x + s * 0.5, y + s * 0.12, s * 0.4, 0, Math.PI * 2);
  g.fill();
  g.fillRect(x - s * 0.8, y, s * 1.65, s * 0.42);
}

/** Солнце-маркер циферблата: тёплый диск с короткими лучами. */
function hudSun(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.strokeStyle = '#f0a92e';
  g.lineWidth = 1.3;
  g.lineCap = 'round';
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI * 0.25;
    g.beginPath();
    g.moveTo(x + Math.cos(a) * (r + 1.6), y + Math.sin(a) * (r + 1.6));
    g.lineTo(x + Math.cos(a) * (r + 3.4), y + Math.sin(a) * (r + 3.4));
    g.stroke();
  }
  g.fillStyle = '#ffd44d';
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.45)';
  g.beginPath();
  g.arc(x - r * 0.3, y - r * 0.3, r * 0.4, 0, Math.PI * 2);
  g.fill();
}

/** Луна-маркер: светлый диск с «откусом» в цвет ночного неба. */
function hudMoon(g: CanvasRenderingContext2D, x: number, y: number, r: number, sky: string): void {
  g.fillStyle = '#f4efcf';
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = sky;
  g.beginPath();
  g.arc(x + r * 0.45, y - r * 0.3, r * 0.85, 0, Math.PI * 2);
  g.fill();
}

/** Значок погоды: солнце / облачко / туча с косыми каплями. */
function hudWeatherIcon(g: CanvasRenderingContext2D, x: number, y: number, kind: WeatherKind): void {
  if (kind === 'sun') {
    g.strokeStyle = '#f0a92e';
    g.lineWidth = 1.2;
    g.lineCap = 'round';
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI * 0.25;
      g.beginPath();
      g.moveTo(x + Math.cos(a) * 5, y + Math.sin(a) * 5);
      g.lineTo(x + Math.cos(a) * 6.8, y + Math.sin(a) * 6.8);
      g.stroke();
    }
    g.fillStyle = '#ffd44d';
    g.beginPath();
    g.arc(x, y, 3.6, 0, Math.PI * 2);
    g.fill();
    return;
  }
  if (kind === 'cloud') {
    hudCloud(g, x, y + 0.5, 7.5, '#dbe4ec');
    return;
  }
  g.strokeStyle = '#3f97e4';
  g.lineWidth = 1.5;
  g.lineCap = 'round';
  for (let i = -1; i <= 1; i++) {
    g.beginPath();
    g.moveTo(x + i * 3.6 - 1, y + 3.2);
    g.lineTo(x + i * 3.6 - 2.4, y + 6.8);
    g.stroke();
  }
  hudCloud(g, x, y - 2, 7.5, '#c9d4de');
}

/**
 * Кадр HUD поля: круг, разделённый на день (светлая половина с облаками) и ночь
 * (тёмная со звёздами), с маркером, который движется по времени суток: солнце
 * выкатывается по светлой половине от восхода к закату, луна — по тёмной.
 * Рядом — значок текущей погоды с мягким кроссфейдом при смене. HUD рисуется
 * поверх слоя атмосферы (Pixi), поэтому сам не темнеет ночью и не прячется под дождём.
 */
function drawFieldHud(
  cv: HTMLCanvasElement,
  vw: number,
  vh: number,
  p4: number,
  weather: WeatherKind,
  weatherPrev: WeatherKind,
  weatherAt: number,
): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const bw = Math.round(vw * dpr);
  const bh = Math.round(vh * dpr);
  if (cv.width !== bw || cv.height !== bh) {
    cv.width = bw;
    cv.height = bh;
  }
  const g = cv.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, vw, vh);

  const R = HUD_DIAL_R;
  const cx = vw - HUD_PAD - R;
  const cy = HUD_PAD + R;
  const wxX = cx - R - HUD_GAP - HUD_WX_R;

  // тени-подложки: читаемость на любом фоне
  g.fillStyle = 'rgba(0,0,0,0.32)';
  g.beginPath();
  g.arc(cx, cy, R + 2.5, 0, Math.PI * 2);
  g.arc(wxX, cy, HUD_WX_R + 2.5, 0, Math.PI * 2);
  g.fill();

  // половины циферблата: день — верхний-левый полукруг (от 135° до 315°), ночь — нижний-правый
  g.save();
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.clip();
  g.fillStyle = '#a9d7f2';
  g.beginPath();
  g.moveTo(cx, cy);
  g.arc(cx, cy, R, 135 * HUD_DEG, 315 * HUD_DEG);
  g.closePath();
  g.fill();
  hudCloud(g, cx - R * 0.42, cy - R * 0.3, R * 0.3, 'rgba(255,255,255,0.85)');
  hudCloud(g, cx - R * 0.08, cy - R * 0.55, R * 0.22, 'rgba(255,255,255,0.7)');
  g.fillStyle = HUD_NIGHT_SKY;
  g.beginPath();
  g.moveTo(cx, cy);
  g.arc(cx, cy, R, 315 * HUD_DEG, 495 * HUD_DEG);
  g.closePath();
  g.fill();
  g.fillStyle = 'rgba(255,233,168,0.95)';
  const stars: ReadonlyArray<readonly [number, number, number]> = [
    [0.34, 0.34, 1.1],
    [0.55, 0.1, 0.9],
    [0.14, 0.52, 0.8],
    [0.46, 0.52, 1.2],
  ];
  for (const [sx, sy, sr] of stars) {
    g.beginPath();
    g.arc(cx + R * sx, cy + R * sy, sr, 0, Math.PI * 2);
    g.fill();
  }
  const stx = cx + R * 0.5;
  const sty = cy + R * 0.28;
  g.strokeStyle = 'rgba(255,233,168,0.9)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(stx - 2.2, sty);
  g.lineTo(stx + 2.2, sty);
  g.moveTo(stx, sty - 2.2);
  g.lineTo(stx, sty + 2.2);
  g.stroke();
  g.restore();

  // обод
  g.strokeStyle = 'rgba(255,255,255,0.92)';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.stroke();

  // маркер времени: солнце едет по светлой половине (0,125→0,625 суток),
  // луна — по тёмной (0,625→1,125); пока «не взошло» — маркера нет
  const cyc = (((p4 / 4) % 1) + 1) % 1;
  const mr = R - 7.5;
  if (cyc > 0.125 && cyc < 0.625) {
    const a = (135 + 180 * ((cyc - 0.125) / 0.5)) * HUD_DEG;
    hudSun(g, cx + Math.cos(a) * mr, cy + Math.sin(a) * mr, 5);
  } else {
    const u = (cyc + 1 - 0.625) % 1;
    if (u < 0.5) {
      const a = (315 + 180 * (u / 0.5)) * HUD_DEG;
      hudMoon(g, cx + Math.cos(a) * mr, cy + Math.sin(a) * mr, 4.6, HUD_NIGHT_SKY);
    }
  }

  // подпись части суток
  const label = DAYPART_LABEL[dayPartOfProgress(p4)];
  g.font = '600 10px ui-sans-serif, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'top';
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.strokeText(label, cx, cy + R + 5);
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.fillText(label, cx, cy + R + 5);

  // значок погоды с мягким кроссфейдом при смене
  g.beginPath();
  g.arc(wxX, cy, HUD_WX_R, 0, Math.PI * 2);
  g.fillStyle = 'rgba(252,252,255,0.88)';
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 1.5;
  g.stroke();
  const wt = Math.min(1, Math.max(0, (performance.now() - weatherAt) / 900));
  g.save();
  g.beginPath();
  g.arc(wxX, cy, HUD_WX_R - 0.5, 0, Math.PI * 2);
  g.clip();
  if (wt < 1) {
    g.globalAlpha = 1 - wt;
    hudWeatherIcon(g, wxX, cy, weatherPrev);
    g.globalAlpha = 1;
  }
  g.globalAlpha = wt;
  hudWeatherIcon(g, wxX, cy, weather);
  g.restore();
  g.globalAlpha = 1;
}
export { drawFieldHud };

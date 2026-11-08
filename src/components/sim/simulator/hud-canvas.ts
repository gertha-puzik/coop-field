/**
 * Field HUD canvas painters, carved out of simulator.tsx verbatim (W5b stage 2,
 * behavior-preserving). Pure canvas drawing: no React, no refs, no engine state.
 * Contract: the only public export is `drawFieldHud(cv, vw, vh, p4, weather,
 * weatherPrev, weatherAt)` — called once per frame by the game loop in
 * simulator.tsx to paint the rotating day panel and the weather badge overlay.
 * Internal helpers (hudCloud/hudWeatherIcon) and geometry constants stay
 * module-private on purpose.
 */
import { elisionActorFoot, type ElisionFrame, type ElisionSpace } from '@/lib/sim/elision-scene';
import { jumpFillOf } from '@/lib/sim/test-map';
import { DAYPART_LABEL, dayPartOfProgress, type DayPart, type WeatherKind } from '@/lib/sim/settings';

/* ---------- HUD поля: вращающаяся плашка суток и значок погоды ---------- */

/** Плашка суток: длина и высота (px экрана), стрелка на правом торце.
 *  Вращается вместе с серверным временем: в середине утра лежит горизонтально
 *  (стрелка на восток), дальше крутится по часовой — каждые 90° поворота это
 *  середина следующей части суток (день/вечер/ночь), полный оборот — сутки. */
const PANEL_L = 56;
const PANEL_H = 16;
/** Радиус круга, который заметает плашка при обороте (полудиагональ + зазор). */
const PANEL_SWEEP = Math.ceil(Math.hypot(PANEL_L / 2, PANEL_H / 2)) + 1;
const HUD_WX_R = 13;
const HUD_PAD = 12;
const HUD_GAP = 10;
const HUD_DEG = Math.PI / 180;
/** Цвета частей суток на плашке: от хвоста к стрелке — утро → день → вечер → ночь. */
const PANEL_SEGMENT: Record<DayPart, string> = {
  morning: '#f0bd62',
  day: '#a9d7f2',
  evening: '#e0885f',
  night: '#31427c',
};

/** Облако из кругов с подошвой — в значке погоды. */
function hudCloud(g: CanvasRenderingContext2D, x: number, y: number, s: number, fill: string): void {
  g.fillStyle = fill;
  g.beginPath();
  g.arc(x - s * 0.45, y + s * 0.15, s * 0.42, 0, Math.PI * 2);
  g.arc(x + s * 0.05, y - s * 0.2, s * 0.55, 0, Math.PI * 2);
  g.arc(x + s * 0.5, y + s * 0.12, s * 0.4, 0, Math.PI * 2);
  g.fill();
  g.fillRect(x - s * 0.8, y, s * 1.65, s * 0.42);
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

/** Плашка суток в локальных координатах (центр — точка вращения, стрелка на +X).
 *  cur — текущая часть суток: её сегмент подсвечен, её цвет у стрелки. */
function hudDayPanel(g: CanvasRenderingContext2D, p4: number, cur: DayPart): void {
  const half = PANEL_L / 2;
  const hh = PANEL_H / 2;
  // тело плашки: четыре сегмента суток, у текущего — полная яркость
  const keys: DayPart[] = ['morning', 'day', 'evening', 'night'];
  for (let i = 0; i < 4; i++) {
    g.globalAlpha = keys[i] === cur ? 1 : 0.66;
    g.fillStyle = PANEL_SEGMENT[keys[i]];
    g.fillRect(-half + (i * PANEL_L) / 4, -hh, PANEL_L / 4, PANEL_H);
  }
  g.globalAlpha = 1;
  // разделители сегментов
  g.strokeStyle = 'rgba(0,0,0,0.28)';
  g.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const x = -half + (i * PANEL_L) / 4;
    g.beginPath();
    g.moveTo(x, -hh + 1);
    g.lineTo(x, hh - 1);
    g.stroke();
  }
  // точка времени: едет от хвоста (начало утра) к стрелке (конец ночи)
  const t = (((p4 / 4) % 1) + 1) % 1;
  const dx = -half + t * PANEL_L;
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.beginPath();
  g.arc(dx, 0, 3.4, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(dx, 0, 2.2, 0, Math.PI * 2);
  g.fill();
  // корпус: белая кромка поверх сегментов — читаемость на любом фоне
  g.strokeStyle = 'rgba(255,255,255,0.92)';
  g.lineWidth = 1.5;
  g.strokeRect(-half, -hh, PANEL_L, PANEL_H);
  // стрелка на правом торце — цветом текущей части суток
  g.fillStyle = PANEL_SEGMENT[cur];
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(half - 1.5, -5.5);
  g.lineTo(half + 6.5, 0);
  g.lineTo(half - 1.5, 5.5);
  g.closePath();
  g.fill();
  g.stroke();
}

/**
 * Кадр HUD поля: плашка суток, вращающаяся вместе с серверным временем
 * (в середине утра лежит горизонтально, каждые 90° поворота — середина
 * следующей части суток, полный оборот — сутки), белая точка на ней показывает
 * точное положение в сутках, стрелка на торце — цветом текущей части суток.
 * Под плашкой — подпись части суток. Рядом — значок текущей погоды с мягким
 * кроссфейдом при смене. HUD рисуется поверх слоя атмосферы (Pixi), поэтому сам
 * не темнеет ночью и не прячется под дождём.
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

  const S = PANEL_SWEEP;
  const cx = vw - HUD_PAD - S - 3;
  const cy = HUD_PAD + S + 3;
  const wxX = cx - S - HUD_GAP - HUD_WX_R;
  const cur = dayPartOfProgress(p4);

  // тень-подложка: читаемость на любом фоне
  g.fillStyle = 'rgba(0,0,0,0.32)';
  g.beginPath();
  g.arc(cx, cy, S + 2.5, 0, Math.PI * 2);
  g.arc(wxX, cy, HUD_WX_R + 2.5, 0, Math.PI * 2);
  g.fill();

  // вращающаяся плашка суток: середина утра — горизонтально, далее по часовой
  g.save();
  g.translate(cx, cy);
  g.rotate((p4 - 0.5) * 90 * HUD_DEG);
  hudDayPanel(g, p4, cur);
  g.restore();
  // ось вращения поверх плашки
  g.fillStyle = 'rgba(0,0,0,0.7)';
  g.beginPath();
  g.arc(cx, cy, 2.4, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 1;
  g.beginPath();
  g.arc(cx, cy, 2.4, 0, Math.PI * 2);
  g.stroke();

  // подпись части суток
  const label = DAYPART_LABEL[cur];
  g.font = '600 10px ui-sans-serif, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'top';
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.strokeText(label, cx, cy + S + 5);
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.fillText(label, cx, cy + S + 5);

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

/** Заряд прыжка поверх WebGL и погоды; координаты из того же кадра, что спрайт. */
export function drawElisionJumpHud(cv: HTMLCanvasElement | null, frame: ElisionFrame, sp: ElisionSpace, now: number) {
  if (!cv || frame.editor || (!sp.holding && !(sp.releaseAt > 0 && now-sp.releaseAt < 420))) return;
  const actor = frame.decals.find(a => a.id === frame.controlledId);
  if (!actor) return;
  const g = cv.getContext('2d');
  if (!g) return;
  const f = elisionActorFoot(actor), dx = f.x-frame.camX, dy = f.z-frame.camY;
  const x = frame.viewW/2+(dx*Math.cos(frame.yaw)-dy*Math.sin(frame.yaw))*frame.zoom;
  const y = frame.viewH/2+(dx*Math.sin(frame.yaw)+dy*Math.cos(frame.yaw)-f.y)*frame.zoom;
  const h = Math.max(36,actor.h*0.55)*frame.zoom, w = Math.max(5,actor.h*0.045)*frame.zoom;
  const bx = x+(actor.w/2+Math.max(8,actor.h*0.07))*frame.zoom;
  const by = y-actor.h*frame.zoom+(actor.h*frame.zoom-h)*0.35;
  const fill = sp.holding ? Math.min(1,(now-sp.since)/4000) : jumpFillOf(sp.charge);
  g.save();
  const dpr = Math.min(2,window.devicePixelRatio||1);
  g.setTransform(dpr,0,0,dpr,0,0);
  g.fillStyle='rgba(0,0,0,0.55)';g.fillRect(bx-1,by-1,w+2,h+2);
  g.fillStyle=fill>=1?'#f6e7a1':fill>=0.5?'#8ef0b0':'#e7c48a';g.fillRect(bx,by+h*(1-fill),w,h*fill);
  g.strokeStyle='rgba(255,255,255,0.9)';g.lineWidth=1;
  g.strokeRect(bx-1,by-1,w+2,h+2);g.beginPath();g.moveTo(bx-2,by+h/2);g.lineTo(bx+w+2,by+h/2);g.stroke();
  g.restore();
}

/**
 * Трёхстрочная подпись над котом на поле (имя персонажа / логин / статус).
 * AFK — отдельная строка #C9A4A5 над именем (presence away на поле).
 * Общий хелпер для 2D-канваса и HUD поверх WebGL Элизии.
 */
export type Nameplate = {
  charName: string;
  accountLogin?: string;
  statusLabel?: string;
  /** Серверный AFK: рисуем «AFK» цветом #C9A4A5 над именем. */
  afk?: boolean;
};

const CHAR_FONT = 'bold 13px "Times New Roman", "Liberation Serif", Georgia, serif';
const USER_FONT = '12px "Times New Roman", "Liberation Serif", Georgia, serif';
const STATUS_FONT = 'italic 12px "Times New Roman", "Liberation Serif", Georgia, serif';
const AFK_FONT = 'bold 11px "Times New Roman", "Liberation Serif", Georgia, serif';
const AFK_COLOR = '#C9A4A5';
const LINE = 15;

/** Текст первой строки: ‹ Имя ›, как на макете. */
export function charNameLine(name: string): string {
  const n = String(name || "").trim();
  return n ? `‹ ${n} ›` : "";
}

/** Рисует подпись с тенью; якорь — центр над головой (x, topY). */
export function drawNameplate(
  ctx: CanvasRenderingContext2D,
  x: number,
  topY: number,
  plate: Nameplate,
): void {
  const charLine = charNameLine(plate.charName);
  const user = String(plate.accountLogin || "").trim();
  const status = String(plate.statusLabel || "").trim();
  const afk = !!plate.afk;
  if (!charLine && !user && !status && !afk) return;

  const lines: { text: string; font: string; color: string }[] = [];
  if (afk) lines.push({ text: 'AFK', font: AFK_FONT, color: AFK_COLOR });
  if (charLine) lines.push({ text: charLine, font: CHAR_FONT, color: '#ffffff' });
  if (user) lines.push({ text: user, font: USER_FONT, color: '#ffffff' });
  if (status) lines.push({ text: status, font: STATUS_FONT, color: '#ffffff' });

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  // макет: AFK → имя → логин → статус сверху вниз от topY − высота.
  const blockH = lines.length * LINE;
  let y = topY - blockH + LINE;
  for (const row of lines) {
    ctx.font = row.font;
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fillText(row.text, x + 1, y + 1);
    ctx.fillStyle = row.color;
    ctx.fillText(row.text, x, y);
    y += LINE;
  }
  ctx.restore();
}

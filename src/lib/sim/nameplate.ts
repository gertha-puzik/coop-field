/**
 * Трёхстрочная подпись над котом на поле (имя персонажа / логин / статус).
 * Общий хелпер для 2D-канваса и HUD поверх WebGL Элизии.
 */
export type Nameplate = {
  charName: string;
  accountLogin?: string;
  statusLabel?: string;
};

const CHAR_FONT = 'bold 13px "Times New Roman", "Liberation Serif", Georgia, serif';
const USER_FONT = '12px "Times New Roman", "Liberation Serif", Georgia, serif';
const STATUS_FONT = 'italic 12px "Times New Roman", "Liberation Serif", Georgia, serif';
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
  if (!charLine && !user && !status) return;

  const lines: { text: string; font: string }[] = [];
  if (charLine) lines.push({ text: charLine, font: CHAR_FONT });
  if (user) lines.push({ text: user, font: USER_FONT });
  if (status) lines.push({ text: status, font: STATUS_FONT });

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  let y = topY;
  // снизу вверх: статус → логин → имя, чтобы имя было ближе к голове…
  // макет: имя сверху, статус снизу — рисуем сверху вниз от topY − высота.
  const blockH = lines.length * LINE;
  y = topY - blockH + LINE;
  for (const row of lines) {
    ctx.font = row.font;
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fillText(row.text, x + 1, y + 1);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(row.text, x, y);
    y += LINE;
  }
  ctx.restore();
}

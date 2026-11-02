/**
 * Управление с клавиатуры не зависит от раскладки.
 * Сначала берём физическую клавишу (KeyboardEvent.code): на русской это те же
 * WASD, даже когда буква уже «ц». Если браузер код не сообщил (Firefox на Linux
 * с нелатинской раскладкой отдаёт пустой code), смотрим на саму букву —
 * латиницу и йцукен.
 */
export type KeyAction =
  | { type: 'move'; dir: number }
  | { type: 'rot'; sign: -1 | 1 }
  | { type: 'strike' }
  | { type: 'block' }
  | { type: 'battle' }
  | { type: 'chat' };

const BY_CODE: Record<string, KeyAction> = {
  KeyD: { type: 'move', dir: 0 },
  KeyX: { type: 'move', dir: 45 },
  KeyS: { type: 'move', dir: 90 },
  KeyZ: { type: 'move', dir: 135 },
  KeyA: { type: 'move', dir: 180 },
  KeyQ: { type: 'move', dir: 225 },
  KeyW: { type: 'move', dir: 270 },
  KeyE: { type: 'move', dir: 315 },
  KeyJ: { type: 'rot', sign: -1 },
  KeyL: { type: 'rot', sign: 1 },
  KeyI: { type: 'strike' },
  // Блок: клавиша «К» — в йцукен она стоит на физической R.
  KeyR: { type: 'block' },
  KeyB: { type: 'battle' },
  Enter: { type: 'chat' },
};

/** Буква на той же физической клавише: латиница и йцукен (украинская і на месте ы). */
const BY_KEY: Record<string, KeyAction> = {
  d: { type: 'move', dir: 0 },
  в: { type: 'move', dir: 0 },
  x: { type: 'move', dir: 45 },
  ч: { type: 'move', dir: 45 },
  s: { type: 'move', dir: 90 },
  ы: { type: 'move', dir: 90 },
  і: { type: 'move', dir: 90 },
  z: { type: 'move', dir: 135 },
  я: { type: 'move', dir: 135 },
  a: { type: 'move', dir: 180 },
  ф: { type: 'move', dir: 180 },
  q: { type: 'move', dir: 225 },
  й: { type: 'move', dir: 225 },
  w: { type: 'move', dir: 270 },
  ц: { type: 'move', dir: 270 },
  e: { type: 'move', dir: 315 },
  у: { type: 'move', dir: 315 },
  j: { type: 'rot', sign: -1 },
  о: { type: 'rot', sign: -1 },
  l: { type: 'rot', sign: 1 },
  д: { type: 'rot', sign: 1 },
  i: { type: 'strike' },
  ш: { type: 'strike' },
  // Блок: латиница r и йцукен «к» — одна и та же физическая клавиша.
  r: { type: 'block' },
  к: { type: 'block' },
  b: { type: 'battle' },
  и: { type: 'battle' },
};

export function keyAction(ev: { code?: string; key?: string }): KeyAction | null {
  const code = ev.code || '';
  const fromCode = BY_CODE[code];
  if (fromCode) return fromCode;
  if (code && code !== 'Unidentified') return null;
  const key = (ev.key || '').toLowerCase();
  return BY_KEY[key] ?? null;
}

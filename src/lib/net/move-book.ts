/** Клетка поля в координатах канваса: 0…9 / 0…5. В протоколе к ним прибавлена единица. */
export type Cell = { col: number; row: number };

/**
 * Своя клетка, которую уже назвал сервер, и шаги, нарисованные раньше подтверждения.
 * Сервер остаётся источником клеток: pending — только картинка, пока эхо не догнало.
 */
export type MoveBook = {
  server: Cell | null;
  pending: Cell[];
};

export type OwnAck =
  | { type: "duplicate" }
  | { type: "confirm" }
  | { type: "reject"; cell: Cell }
  | { type: "place"; cell: Cell };

/** Куда чужого кота уже дорисовали и какие клетки ещё надо пройти по одной. */
export type RemoteDraw = {
  col: number;
  row: number;
  queue: Cell[];
  /** performance.now() последней дорисованной клетки — темп достройки шага. */
  lastStepAt: number;
};

export function sameCell(a: Cell | null | undefined, b: Cell | null | undefined): boolean {
  return !!a && !!b && a.col === b.col && a.row === b.row;
}

function copyCell(cell: Cell): Cell {
  return { col: cell.col, row: cell.row };
}

/**
 * Эхо своего `update cat`.
 * Повтор уже подтверждённой клетки (сервер отдавал её и себе, и всей комнате)
 * не сбрасывает предикт: иначе спрайт шагает назад, кулдаун шага снимается,
 * и следующий кадр перепрыгивает клетку.
 * Настоящее расхождение с очередью по-прежнему возвращает на клетку сервера.
 */
export function applyOwnMoveAck(book: MoveBook, cell: Cell, visual: Cell): OwnAck {
  if (sameCell(book.server, cell)) return { type: "duplicate" };
  book.server = copyCell(cell);
  const head = book.pending[0];
  if (head && sameCell(head, cell)) {
    book.pending.shift();
    return { type: "confirm" };
  }
  if (head) {
    book.pending = [];
    return { type: "reject", cell: copyCell(cell) };
  }
  if (!sameCell(visual, cell)) return { type: "place", cell: copyCell(cell) };
  return { type: "confirm" };
}

/** Отказ сервера («клетка занята», «край поля»): предикт стираем, остаёмся на подтверждённой клетке. */
export function rejectOwnMove(book: MoveBook): Cell | null {
  const cell = book.server ? copyCell(book.server) : null;
  book.pending = [];
  return cell;
}

export function seedRemoteDraw(cell: Cell): RemoteDraw {
  return { col: cell.col, row: cell.row, queue: [], lastStepAt: 0 };
}

/** Следующая серверная клетка. Повтор той же клетки очередь не удлиняет. */
export function enqueueRemoteCell(draw: RemoteDraw, cell: Cell): void {
  const last = draw.queue[draw.queue.length - 1] ?? draw;
  if (last.col === cell.col && last.row === cell.row) return;
  draw.queue.push(copyCell(cell));
}

/**
 * Один шаг по Чебышёву за кадр. Диагональ сервера — один шаг.
 * Две клетки, пришедшие пачкой, не склеиваются: вторая ждёт следующего кадра.
 */
export function advanceRemoteDraw(draw: RemoteDraw): void {
  const next = draw.queue[0];
  if (!next) return;
  const dc = Math.sign(next.col - draw.col);
  const dr = Math.sign(next.row - draw.row);
  draw.col += dc;
  draw.row += dr;
  if (draw.col === next.col && draw.row === next.row) draw.queue.shift();
}

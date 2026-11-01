// @ts-nocheck
// Скрипт для node --experimental-strip-types, не для tsc приложения.
import {
  advanceRemoteDraw,
  applyOwnMoveAck,
  enqueueRemoteCell,
  rejectOwnMove,
  seedRemoteDraw,
  type Cell,
  type MoveBook,
} from "../src/lib/net/move-book.ts";

function cell(col: number, row: number): Cell {
  return { col, row };
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// Бег вправо: два предикта, затем эхо первой клетки дважды (как send + broadcast в HAR).
{
  const book: MoveBook = { server: cell(1, 0), pending: [] };
  let visual = cell(1, 0);
  const predict = (next: Cell) => {
    book.pending.push(next);
    visual = next;
  };
  predict(cell(2, 0));
  predict(cell(3, 0));
  const first = applyOwnMoveAck(book, cell(2, 0), visual);
  assert(first.type === "confirm", `first ack ${first.type}`);
  assert(visual.col === 3 && visual.row === 0, "visual jumped back on the first ack");
  assert(book.pending.length === 1 && book.pending[0].col === 3, "pending head after first ack");
  const dup = applyOwnMoveAck(book, cell(2, 0), visual);
  assert(dup.type === "duplicate", `duplicate ack treated as ${dup.type}`);
  assert(visual.col === 3, "duplicate echo stepped backward");
  assert(book.pending.length === 1 && book.pending[0].col === 3, "duplicate echo cleared the queue");
  const second = applyOwnMoveAck(book, cell(3, 0), visual);
  assert(second.type === "confirm", `second ack ${second.type}`);
  assert(visual.col === 3 && book.pending.length === 0, "second ack did not settle on its cell");
  assert(book.server?.col === 3, "server cell");
}

// Отказ не телепортирует дальше законной клетки и не оживает от повторного эха.
{
  const book: MoveBook = { server: cell(4, 3), pending: [] };
  let visual = cell(4, 3);
  book.pending.push(cell(5, 3));
  visual = cell(5, 3);
  const back = rejectOwnMove(book);
  assert(back && back.col === 4 && back.row === 3, "reject cell");
  visual = back;
  assert(book.pending.length === 0, "reject left a predicted step");
  const dup = applyOwnMoveAck(book, cell(4, 3), visual);
  assert(dup.type === "duplicate", `echo after reject ${dup.type}`);
  assert(visual.col === 4 && visual.row === 3, "echo after reject moved the cat");
  book.pending.push(cell(4, 4));
  visual = cell(4, 4);
  const ok = applyOwnMoveAck(book, cell(4, 4), visual);
  assert(ok.type === "confirm" && visual.col === 4 && visual.row === 4, "legal step after reject");
}

// Чужое пачка из двух клеток рисуется по одной, повтор клетки очередь не растит.
{
  const draw = seedRemoteDraw(cell(0, 0));
  enqueueRemoteCell(draw, cell(1, 0));
  enqueueRemoteCell(draw, cell(2, 0));
  enqueueRemoteCell(draw, cell(2, 0));
  assert(draw.queue.length === 2, `queue ${draw.queue.length}`);
  advanceRemoteDraw(draw);
  assert(draw.col === 1 && draw.row === 0 && draw.queue.length === 1, "first frame skipped a cell");
  advanceRemoteDraw(draw);
  assert(draw.col === 2 && draw.row === 0 && draw.queue.length === 0, "second frame");
  const diag = seedRemoteDraw(cell(4, 4));
  enqueueRemoteCell(diag, cell(5, 5));
  advanceRemoteDraw(diag);
  assert(diag.col === 5 && diag.row === 5 && diag.queue.length === 0, "diagonal is one step");
}

console.log("ok: move book");

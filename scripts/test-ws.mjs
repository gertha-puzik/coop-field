import { WebSocket } from "ws";

const url = process.env.WS_URL || "ws://127.0.0.1:3780";
const room = `t${Date.now().toString(36)}`;

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on("open", () => {
      ws.send(JSON.stringify(["join", { room, login: name }]));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      inbox.push(msg);
    });
    ws.on("error", reject);
    ws.inbox = inbox;
    ws.once("open", () => resolve(ws));
  });
}

function waitFor(ws, event, ms = 1500) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const hit = ws.inbox.find((m) => m[0] === event);
      if (hit) return resolve(hit);
      if (Date.now() - start > ms) return reject(new Error(`timeout waiting ${event} for inbox=${JSON.stringify(ws.inbox)}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const a = await client("Альфа");
const b = await client("Бета");
await waitFor(a, "you");
await waitFor(b, "you");
await waitFor(a, "field");
await waitFor(b, "field");

const youA = a.inbox.find((m) => m[0] === "you")[1];
const youB = b.inbox.find((m) => m[0] === "you")[1];
a.inbox.length = 0;
b.inbox.length = 0;

// First spawn is (4,3), second (5,3) — step left, not onto the neighbour.
const dx = youB && youB.x === youA.x + 1 ? -1 : 1;
a.send(JSON.stringify(["move", { x: dx, y: 0 }]));
const patchB = await waitFor(b, "update cat");
const patchA = await waitFor(a, "update cat");

if (patchB[1].id !== youA.id) throw new Error("broadcast id mismatch");
if (patchB[1].x !== youA.x + dx || patchB[1].y !== youA.y) {
  throw new Error(`bad coords ${JSON.stringify(patchB[1])}`);
}
if (patchA[1].x !== patchB[1].x) throw new Error("self echo mismatch");

console.log("ok: 2 sockets, room", room, "move", youA.x, youA.y, "→", patchB[1].x, patchB[1].y, "deg", patchB[1].deg);
a.close();
b.close();
process.exit(0);

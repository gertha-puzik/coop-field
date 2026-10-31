import { createRemoteAim, noteRemoteAim, stepRemoteAim, type RemoteAim } from "../src/lib/sim/remote-aim.ts";

function wrap360(a: number) {
  return ((a % 360) + 360) % 360;
}
function wrap180(a: number) {
  const x = wrap360(a);
  return x > 180 ? x - 360 : x;
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Удержание J/L при периоде 4.8 с — 75°/с. Сэмплы через кадр (~33 мс), рисуем на 60 Гц.
const degPerSec = 360 / 4.8;
let aim: RemoteAim = createRemoteAim(0, 0);
let maxErr = 0;
let maxStep = 0;
let prev = 0;
for (let frame = 1; frame <= 90; frame++) {
  const now = frame * (1000 / 60);
  const trueAng = wrap360((degPerSec * now) / 1000);
  if (frame % 2 === 0) {
    aim = noteRemoteAim(aim, Math.round(trueAng * 10) / 10, now, false);
  }
  stepRemoteAim(aim, now, 1000 / 60);
  const err = Math.abs(wrap180(aim.display - trueAng));
  const jump = Math.abs(wrap180(aim.display - prev));
  if (now > 200) {
    maxErr = Math.max(maxErr, err);
    maxStep = Math.max(maxStep, jump);
  }
  prev = aim.display;
}
assert(maxErr < 4, `steady error ${maxErr}`);
assert(maxStep < 2.5, `frame step ${maxStep} still looks snapped`);
console.log("ok: steady spin", { maxErr: Math.round(maxErr * 100) / 100, maxStep: Math.round(maxStep * 100) / 100 });

// Через 0°/360° идём короткой дугой, а не через 180°.
let across = createRemoteAim(350, 0);
across = noteRemoteAim(across, 10, 40, false);
for (let i = 1; i <= 30; i++) stepRemoteAim(across, 40 + i * 16, 16);
const acrossErr = Math.abs(wrap180(across.display - 10));
assert(acrossErr < 1, `wrap path landed on ${across.display}`);
assert(across.vel > 0, `shortest path should be +20°, vel=${across.vel}`);
console.log("ok: shortest wrap", Math.round(across.display * 10) / 10);

// Вход и большой скачок — сразу, без долгой дуги.
const joined = noteRemoteAim(undefined, 123, 0, true);
assert(joined.display === 123, "join snap");
let jumped = createRemoteAim(0, 0);
jumped = noteRemoteAim(jumped, 90, 30, false);
assert(jumped.display === 90, `huge error should snap, got ${jumped.display}`);
console.log("ok: snap join and >40°");

// Пакеты кончились — стрела не продолжает крутиться.
let coast = createRemoteAim(0, 0);
coast = noteRemoteAim(coast, 10, 40, false);
for (let i = 1; i <= 40; i++) stepRemoteAim(coast, 40 + i * 16, 16);
const runaway = Math.abs(wrap180(coast.display - 10));
assert(runaway < 0.5, `ran away to ${coast.display}`);
console.log("ok: extrapolation clamped", Math.round(coast.display * 100) / 100);

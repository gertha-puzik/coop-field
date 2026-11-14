/**
 * §5 fail-closed startup CSRF: инстанс-класс и запрет выключенного CSRF
 * на production/preview.
 *
 * Две секции:
 *  1. юнит: instanceEnvClass / assertStartupSecurity на прямых вызовах
 *     (env-мутации в этом процессе, аккуратный restore);
 *  2. живые спавны node server.js: invalid-конфиг не поднимает health,
 *     процесс умирает с внятной ошибкой; валидный — поднимается.
 *
 * Никаких записей в прод data-каталог: DATA_DIR всегда mkdtemp; тесты
 * самодостаточны и не требуют живого сервера.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

const netCreateServer = () => net.createServer();

const ROOT = path.resolve(import.meta.dirname, "..");
const SERVER = path.join(ROOT, "server.js");
let passed = 0;
const failed = [];

function check(ok, label) {
  if (ok) {
    passed++;
    console.log("ok   " + label);
  } else {
    failed.push(label);
    console.log("FAIL " + label);
  }
}

/* ---------- секция 1: юнит instanceEnvClass / assertStartupSecurity ---------- */
const cfg = await import(path.join(ROOT, "server/config.js"));
const savedKeys = ["COOP_INSTANCE_CLASS", "AUTH_CSRF_STRICT", "PREVIEW_SITES_MODE", "PREVIEW_SLUG"];
const saved = {};
for (const k of savedKeys) saved[k] = process.env[k];

function setEnv(patch) {
  for (const k of savedKeys) delete process.env[k];
  for (const [k, v] of Object.entries(patch || {})) process.env[k] = v;
}
function restoreEnv() {
  setEnv(saved);
}
process.on("exit", restoreEnv);

try {
  // (1) unknown значение — fail closed прямо на классификации.
  setEnv({ COOP_INSTANCE_CLASS: "staging" });
  let threw = false;
  try { cfg.instanceEnvClass(); } catch { threw = true; }
  check(threw, "(1) unknown COOP_INSTANCE_CLASS='staging' → throw (fail closed)");

  setEnv({ COOP_INSTANCE_CLASS: "PRODUCTION" });
  check(cfg.instanceEnvClass() === "production", "(2) COOP_INSTANCE_CLASS регистронезависим ('PRODUCTION' → production)");

  // (3) production + выключенный CSRF → throw с внятным сообщением.
  setEnv({ COOP_INSTANCE_CLASS: "production", AUTH_CSRF_STRICT: "0" });
  threw = false;
  let msg = "";
  try { cfg.assertStartupSecurity(); } catch (e) { threw = true; msg = String(e.message); }
  check(
    threw && /CSRF/.test(msg) && /production/.test(msg),
    "(3) production + AUTH_CSRF_STRICT=0 → throw старт отменён, сообщение про CSRF",
  );

  // (4) preview через явный env — тот же запрет.
  setEnv({ COOP_INSTANCE_CLASS: "preview", AUTH_CSRF_STRICT: "off" });
  threw = false;
  try { cfg.assertStartupSecurity(); } catch { threw = true; }
  check(threw, "(4) preview + AUTH_CSRF_STRICT='off' → throw");

  // (5) preview через легаси-маркер превью (PREVIEW_SITES_MODE), без явного класса.
  setEnv({ PREVIEW_SITES_MODE: "dual", AUTH_CSRF_STRICT: "false" });
  check(cfg.instanceEnvClass() === "preview", "(5a) PREVIEW_SITES_MODE-маркер → класс preview");
  threw = false;
  try { cfg.assertStartupSecurity(); } catch { threw = true; }
  check(threw, "(5b) preview по маркеру + STRICT='false' → throw");

  // (6) local и test сохраняют легаси-режим: контрольные стенды B1 живы.
  setEnv({ AUTH_CSRF_STRICT: "0" });
  let okLocal = true;
  try { cfg.assertStartupSecurity(); } catch { okLocal = false; }
  check(okLocal, "(6a) без явного класса (local) + STRICT=0 → старт разрешён (легаси-стенды)");
  setEnv({ COOP_INSTANCE_CLASS: "local", AUTH_CSRF_STRICT: "0" });
  okLocal = true;
  try { cfg.assertStartupSecurity(); } catch { okLocal = false; }
  check(okLocal, "(6b) явный local + STRICT=0 → старт разрешён");
  setEnv({ COOP_INSTANCE_CLASS: "test", AUTH_CSRF_STRICT: "no" });
  let okTest = true;
  try { cfg.assertStartupSecurity(); } catch { okTest = false; }
  check(okTest, "(6c) явный test + STRICT='no' → старт разрешён");

  // (7) production с валидными значениями стартует: auto/'1'/отсутствие.
  setEnv({ COOP_INSTANCE_CLASS: "production", AUTH_CSRF_STRICT: "auto" });
  okTest = true;
  try { cfg.assertStartupSecurity(); } catch { okTest = false; }
  check(okTest, "(7a) production + STRICT=auto → старт разрешён (важно: дефолт прода не сломан)");
  setEnv({ AUTH_CSRF_STRICT: "1" });
  okTest = true;
  try { cfg.assertStartupSecurity(); } catch { okTest = false; }
  check(okTest, "(7b) production + STRICT=1 → старт разрешён");
  setEnv({});
  okTest = true;
  try { cfg.assertStartupSecurity(); } catch { okTest = false; }
  check(okTest, "(7c) production, STRICT не задан (auto) → старт разрешён");
} finally {
  restoreEnv();
}

/* ---------- секция 2: живой server.js — старт умирает/живёт как заявлено ---------- */
const dir = mkdtempSync(path.join(tmpdir(), "coop-csrf-startup-"));

// Reserve a guaranteed-free port instead of PORT=0: server.js treats 0 as
// unset and falls back to its default port, so a live local stage sharing
// that default would make every "must survive" spawn die with EADDRINUSE.
const probe = netCreateServer();
await new Promise((res) => probe.listen(0, "127.0.0.1", res));
const FREE_PORT = String(probe.address().port);
probe.close();

async function spawnServer(envPatch, waitMs = 4000) {
  const env = {
    ...process.env,
    DATA_DIR: dir,
    HOST: "127.0.0.1",
    PORT: FREE_PORT, // just a free-port placeholder: validation runs before listen
    ...envPatch,
  };
  for (const k of savedKeys) if (!(k in envPatch)) delete env[k];
  const p = spawn("node", [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { out += d; });
  const done = new Promise((resolve) => p.on("exit", (code, sig) => resolve({ code, sig, out })));
  // даём процессу осесть: fail происходит сразу на startServer, до listen.
  const raced = await Promise.race([
    done.then((r) => ({ ...r, exited: true })),
    new Promise((res) => setTimeout(() => res({ exited: false }), waitMs)),
  ]);
  if (!raced.exited) p.kill("SIGKILL");
  return raced;
}

const r1 = await spawnServer({ COOP_INSTANCE_CLASS: "production", AUTH_CSRF_STRICT: "0" });
check(
  r1.exited && r1.code !== 0 && /CSRF-защита не может быть выключена/.test(r1.out),
  "(8) живой старт: production + STRICT=0 → процесс умирает до listen с ошибкой про CSRF",
);

const r2 = await spawnServer({ PREVIEW_SITES_MODE: "dual", AUTH_CSRF_STRICT: "0" });
check(
  r2.exited && r2.code !== 0 && /инстансе 'preview'/.test(r2.out),
  "(9) живой старт: preview по маркеру PREVIEW_SITES_MODE + STRICT=0 → умирает с 'preview' в ошибке",
);

const r3 = await spawnServer({ COOP_INSTANCE_CLASS: "staging" });
check(
  r3.exited && r3.code !== 0 && /COOP_INSTANCE_CLASS/.test(r3.out),
  "(10) живой старт: unknown COOP_INSTANCE_CLASS='staging' → умирает, fail closed",
);

const r4 = await spawnServer({ COOP_INSTANCE_CLASS: "production" });
check(
  !r4.exited,
  "(11) живой старт: production + STRICT=auto → живёт (валидация не блокирует нормальный старт)",
);

rmSync(dir, { recursive: true, force: true });

if (failed.length) {
  console.log(`csrf startup tests: FAIL (${failed.length})`);
  process.exit(1);
}
console.log(`csrf startup tests: зелёный (${passed} ok)`);

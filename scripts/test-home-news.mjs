#!/usr/bin/env node
/**
 * Контракт новостей доски главной (server/home-news.js):
 *   GET  /cfg/news|/news — публично на local;
 *   POST /cfg/news|/admin/news — только admin + Origin (CSRF).
 *
 * Песочница: mkdtemp DATA_DIR, свободный порт, спавн server.js.
 * Запуск: node scripts/test-home-news.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = mkdtempSync(path.join(tmpdir(), "coop-home-news-"));
const PORT = 4400 + Math.floor(Math.random() * 60);
const HOST = "127.0.0.1";
const HTTP = `http://${HOST}:${PORT}`;
const ORIGIN = HTTP;
const ADMIN = "news_admin_q";
const USER = "news_user_q";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    console.error(`  FAIL ${msg}`);
    fails += 1;
  }
};

async function jsonFetch(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text, headers: res.headers };
}

function startServer() {
  return spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST,
      DATA_DIR: DATA,
      AUTH_CSRF_STRICT: "1",
      REQUIRE_ORIGIN: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitHealth(child) {
  for (let i = 0; i < 40; i++) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}`);
    try {
      const r = await fetch(`${HTTP}/health`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await sleep(150);
  }
  throw new Error("health timeout");
}

async function register(login, pass) {
  return jsonFetch(`${HTTP}/auth/register`, {
    method: "POST",
    headers: { Origin: ORIGIN },
    body: JSON.stringify({ login, pass, name: login }),
  });
}

async function login(loginName, pass) {
  return jsonFetch(`${HTTP}/auth/login`, {
    method: "POST",
    headers: { Origin: ORIGIN },
    body: JSON.stringify({ login: loginName, pass }),
  });
}

function cookieFrom(res) {
  const raw = res.headers.getSetCookie?.() || [];
  const line = raw.find((c) => c.startsWith("coop_session=")) || "";
  return line.split(";")[0] || "";
}

async function main() {
  console.log("test-home-news: start");
  let child = startServer();
  try {
    await waitHealth(child);

    // Public GET defaults
    {
      const r = await jsonFetch(`${HTTP}/cfg/news`);
      ok(r.status === 200 && r.body?.ok === true, "GET /cfg/news → 200");
      ok(Array.isArray(r.body?.items) && r.body.items.length >= 1, "default items present");
      const r2 = await jsonFetch(`${HTTP}/news`);
      ok(r2.status === 200 && r2.body?.ok === true, "GET /news alias → 200");
    }

    // Register ladder + make-admin
    {
      const reg = await register(ADMIN, "password-news-1");
      ok(reg.status === 200 || reg.status === 201 || reg.body?.ok === true, "register admin account");
      child.kill("SIGTERM");
      await sleep(400);
      execFileSync(process.execPath, ["scripts/make-admin.mjs", ADMIN], {
        cwd: ROOT,
        env: { ...process.env, DATA_DIR: DATA },
        stdio: "inherit",
      });
      child = startServer();
      await waitHealth(child);
    }

    const adminLogin = await login(ADMIN, "password-news-1");
    const adminCookie = cookieFrom(adminLogin);
    ok(!!adminCookie, "admin session cookie");

    const userReg = await register(USER, "password-news-2");
    ok(userReg.body?.ok !== false || userReg.status < 400, "register plain user");
    const userLogin = await login(USER, "password-news-2");
    const userCookie = cookieFrom(userLogin);

    // Non-admin POST → 403
    {
      const r = await jsonFetch(`${HTTP}/cfg/news`, {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: userCookie },
        body: JSON.stringify({ items: [{ title: "x", body: "y" }] }),
      });
      ok(r.status === 403 && r.body?.reason === "forbidden", "user POST /cfg/news → 403 forbidden");
    }

    // Admin without Origin → CSRF
    {
      const r = await jsonFetch(`${HTTP}/cfg/news`, {
        method: "POST",
        headers: { Cookie: adminCookie },
        body: JSON.stringify({ items: [{ title: "x", body: "y" }] }),
      });
      ok(r.status === 403 && String(r.body?.reason || "").startsWith("csrf"), "admin POST without Origin → csrf");
    }

    // Admin save via /cfg/news (nginx-safe path)
    {
      const payload = {
        items: [
          { title: "Тест А", body: "Первая запись доски." },
          { title: "Тест Б", body: "Вторая запись доски." },
        ],
      };
      const r = await jsonFetch(`${HTTP}/cfg/news`, {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: adminCookie },
        body: JSON.stringify(payload),
      });
      ok(r.status === 200 && r.body?.ok === true, "admin POST /cfg/news → 200");
      ok(r.body?.items?.length === 2, "saved 2 items");
      ok(r.body.items[0].title === "Тест А", "title preserved");
    }

    // Alias /admin/news also accepts POST
    {
      const r = await jsonFetch(`${HTTP}/admin/news`, {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: adminCookie },
        body: JSON.stringify({ items: [{ title: "Алиас", body: "через /admin/news" }] }),
      });
      ok(r.status === 200 && r.body?.ok === true, "admin POST /admin/news → 200");
    }

    // Public sees update
    {
      const r = await jsonFetch(`${HTTP}/cfg/news`);
      ok(r.body?.items?.[0]?.title === "Алиас", "public GET sees admin write");
    }

    // Empty items rejected
    {
      const r = await jsonFetch(`${HTTP}/cfg/news`, {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: adminCookie },
        body: JSON.stringify({ items: [] }),
      });
      ok(r.status === 400 && r.body?.reason === "invalid_items", "empty items → 400");
    }

    // Pin floats to top; rich HTML kept allowlisted; scripts stripped
    {
      const r = await jsonFetch(`${HTTP}/cfg/news`, {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: adminCookie },
        body: JSON.stringify({
          items: [
            {
              title: "Новая",
              body: "свежая <b>запись</b>",
              pinned: false,
            },
            {
              title: "Старая закрепа",
              body: '<span class="news-size-lg">крупно</span> <script>x</script><i>и курсив</i>',
              pinned: true,
            },
          ],
        }),
      });
      ok(r.status === 200 && r.body?.ok === true, "admin POST pin+html → 200");
      ok(r.body?.items?.length === 2, "pin+html saved 2");
      ok(r.body.items[0].title === "Старая закрепа", "pinned item first");
      ok(r.body.items[0].pinned === true, "pinned flag true");
      ok(r.body.items[1].pinned === false, "unpinned flag false");
      const pinnedBody = r.body.items[0].body || "";
      ok(
        pinnedBody.includes('class="news-size-lg"') && pinnedBody.includes("<i>") && !/script/i.test(pinnedBody),
        "html allowlist keeps size+i, drops script",
      );
      ok(r.body.items[1].body.includes("<b>"), "bold kept on unpinned");
    }
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    await sleep(200);
    rmSync(DATA, { recursive: true, force: true });
  }

  if (fails) {
    console.error(`test-home-news: FAIL (${fails})`);
    process.exit(1);
  }
  console.log("test-home-news: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

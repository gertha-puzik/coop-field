// @ts-nocheck
/**
 * Wave C regression: /auth/me de-dup on the tab (W2, http-auth.ts).
 *
 * Re-entering a page (AuthGate + catalog + headers of the SAME page) must NOT
 * spam GET /auth/me: httpMe() memoizes ONE promise per tab (meMemo), and a
 * successful register|login|logout RESETS the memo (the cookie changed) and
 * broadcasts the browser ME_EVENT «coop:me» so headers refresh without a
 * reload. A FAILED login must NOT reset the memo (cookie is unchanged).
 *
 * Unit level: no network — global fetch is mocked and counted. Importing the
 * real src/lib/net/http-auth.ts needs the «@/»-alias loader
 * (scripts/unit-ts-loader.mjs, module.register) because the client module
 * graph uses tsconfig aliases that node's strip-types does not resolve.
 * The grotto variant instance (env unset via a query-busted second import)
 * must fold all /auth/ literals away — the unit mirror of A1 bundle folding.
 *
 * Запуск: через `npm run test:unit` (node --experimental-strip-types);
 * вручную — node --experimental-strip-types scripts/test-me-dedup.mts
 */

/** Счётчик fetch-вызовов + скрипты ответов по подстроке URL. */
function makeFetchSpy() {
  const calls = [];
  const spy = async (input) => {
    const url = String(input);
    calls.push(url);
    const body = url.endsWith("/dev/null")
      ? { ok: true, role: "guest" }
      : url.includes("/auth/login") && spy.loginFail
        ? { ok: false, reason: "bad" }
        : url.includes("/auth/logout")
          ? { ok: true, role: "guest" }
          : spy.meError
            ? null
            : { ok: true, role: "registered", accountId: "a1", login: "tester" };
    if (body === null) throw new TypeError("fetch failed");
    return { json: async () => body, text: async () => JSON.stringify(body), status: 200 };
  };
  spy.calls = calls;
  spy.loginFail = false;
  spy.meError = false;
  return spy;
}

function assert(cond, msg) {
  if (!cond) throw new Error(`me-dedup: ${msg}`);
}

const meCalls = (spy) => spy.calls.filter((u) => u.includes("/auth/me")).length;

/* ---------- Elysiae-вариант: один GET /auth/me на вкладку ---------- */

process.env.NEXT_PUBLIC_SITE = "elyria";
const { register } = await import("node:module");
register(new URL("./unit-ts-loader.mjs", import.meta.url));

const spy = makeFetchSpy();
globalThis.fetch = spy;
// window — для проверки ME_EVENT: emitMe гейтится по typeof window, так что
// подставляем шпиона dispatchEvent (CustomEvent в node глобально есть).
const events = [];
globalThis.window = { dispatchEvent: (ev) => events.push(ev) };

const httpAuth = await import("../src/lib/net/http-auth.ts?variant=elyria");

const p1 = httpAuth.httpMe();
const p2 = httpAuth.httpMe();
const p3 = httpAuth.meCached();
assert(p1 === p2 && p2 === p3, "repeat page entries share ONE memoized promise (no refetch)");
assert(meCalls(spy) === 1, `exactly one GET /auth/me is sent (got ${meCalls(spy)})`);
assert((await p1).ok === true, "the shared snapshot resolves to a whoami row");

/* ---------- login/logout сбрасывают кэш и шлют ME_EVENT ---------- */

await httpAuth.httpLogin("tester", "iwontleakit");
assert(spy.calls.some((u) => u.includes("/auth/login")), "login went out");
const p4 = httpAuth.httpMe();
assert(p4 !== p1, "a successful login RESETS the tab memo");
await p4;
assert(meCalls(spy) === 2, "only one NEW /auth/me after the cache reset (no batch spam)");

await httpAuth.httpLogout();
const p5 = httpAuth.httpMe();
assert(p5 !== p4, "a successful logout resets the tab memo too");
await p5;
assert(meCalls(spy) === 3, "logout → exactly one more /auth/me");

assert(events.length >= 2, "login and logout each broadcast the browser ME_EVENT");
assert(
  events.slice(0, 2).every((e) => e.type === "coop:me" && e.detail && e.detail.ok === true),
  "ME_EVENT carries the fresh whoami frame",
);

/* ---------- провалившийся вход НЕ сбрасывает кэш ---------- */

spy.loginFail = true;
await httpAuth.httpLogin("tester", "wrong-password");
const p6 = httpAuth.httpMe();
assert(p6 === p5, "a FAILED login keeps the memo snapshot (cookie unchanged)");
await p6;
assert(meCalls(spy) === 3, "failed login causes no extra /auth/me");

/* ---------- сетевой сбой /auth/me отдаётся как {ok:false} без throw ---------- */

spy.meError = true;
const { httpAuth: fresh } = { httpAuth: await import("../src/lib/net/http-auth.ts?variant=elyria&net=down") };
let threw = false;
try {
  fresh.httpMe();
} catch {
  threw = true;
}
assert(!threw, "meRequest catches network errors (no unhandled rejection)");
assert((await fresh.httpMe()).ok === false, "a network failure resolves to {ok:false}");

/* ---------- Grotto-вариант: литералы «/auth/…» умирают в мёртвой ветке ---------- */

delete process.env.NEXT_PUBLIC_SITE;
const grotto = await import("../src/lib/net/http-auth.ts?variant=grotto");
process.env.NEXT_PUBLIC_SITE = "elyria";
const grottoSpy = makeFetchSpy();
globalThis.fetch = grottoSpy;

const g1 = grotto.httpMe();
const g2 = grotto.httpMe();
await g1;
await g2;
assert(g1 === g2, "grotto build dedups too (.shared promise)");
assert(
  grottoSpy.calls.every((u) => !u.includes("/auth/")),
  "no «/auth/» literal reaches fetch in the grotto variant (A1 folding, authRoute → /dev/null)",
);
console.log("me-dedup: one GET /auth/me per tab, login/logout reset the memo, folding intact — ok");

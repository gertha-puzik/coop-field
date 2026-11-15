// @ts-nocheck
import assert from 'node:assert/strict';

const previousVariant = process.env.NEXT_PUBLIC_SITE;
let saved = 'beer';
let painted = '';
globalThis.window = {};
globalThis.localStorage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
globalThis.document = { documentElement: { setAttribute: (_key, value) => { painted = value; } } };
try {
  process.env.NEXT_PUBLIC_SITE = 'elyria';
  const closed = await import('../src/lib/sim/theme.ts?variant=closed');
  assert.equal(closed.loadTheme(), 'night', 'saved beer theme cannot override Elysiae night');
  let notified;
  const unsubscribe = closed.subscribeTheme((theme) => { notified = theme; });
  closed.applyTheme('light');
  assert.equal(painted, 'night');
  assert.equal(saved, 'night');
  assert.equal(notified, 'night');
  unsubscribe();

  process.env.NEXT_PUBLIC_SITE = 'grotto';
  const publicSite = await import('../src/lib/sim/theme.ts?variant=public');
  saved = 'light';
  assert.equal(publicSite.loadTheme(), 'light', 'public-site preferences remain supported');
  publicSite.applyTheme('beer');
  assert.equal(painted, 'beer');
  assert.equal(saved, 'beer');
  console.log('theme-policy: night enforced on Elysiae; public preferences preserved');
} finally {
  if (previousVariant === undefined) delete process.env.NEXT_PUBLIC_SITE;
  else process.env.NEXT_PUBLIC_SITE = previousVariant;
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.localStorage;
}

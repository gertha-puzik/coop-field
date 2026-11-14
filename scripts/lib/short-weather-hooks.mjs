// Хуки загрузчика для short-weather.mjs. Если строка в server/atmo.js поменялась —
// громко падает, чтобы тест не прошёл «вхолостую» с боевым интервалом.
let ms = 0;
export function initialize(data) {
  ms = data?.ms || 0;
}

const NEEDLE = "if (now - a.ws >= a.wl) {";

export async function load(url, context, nextLoad) {
  const res = await nextLoad(url, context);
  if (!ms || !url.endsWith("/server/atmo.js")) return res;
  const src = String(res.source);
  if (!src.includes(NEEDLE)) {
    throw new Error(`short-weather: в server/atmo.js нет строки «${NEEDLE}» — обнови хук`);
  }
  return { ...res, source: src.replace(NEEDLE, `if (now - a.ws >= Math.min(a.wl, ${ms})) {`) };
}

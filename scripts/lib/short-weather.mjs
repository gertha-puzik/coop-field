// Тестовая точка входа для scripts/test-weather-rotation.mjs: в ПЕСОЧНИЦЕ сервера
// укорачивает интервал погоды до WEATHER_TEST_MS (боевые минуты тест не дождётся).
// Подключается только так: node --import ./scripts/lib/short-weather.mjs server.js
// Прод-код не трогает; сама подмена — в short-weather-hooks.mjs.
import { register } from "node:module";

const ms = Number(process.env.WEATHER_TEST_MS);
if (!(ms > 0)) {
  throw new Error("short-weather: WEATHER_TEST_MS не задан — хук только для тестовой песочницы");
}
register(new URL("./short-weather-hooks.mjs", import.meta.url), { data: { ms } });

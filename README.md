# Coop field — котобитвы на общем canvas-поле

Агентам: карта репо и контракт комнаты — в [AGENTS.md](AGENTS.md), глубина (слои, зеркала, цель рефакторинга) — в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Фронт — канвас-симулятор из [abnocw](https://github.com/ggaymelini/abnocw) + WebSocket-комната: до 30 котов,
ходьба WASD (та же раскладка на русской клавиатуре), стрелы-удары, скины, панель настроек, чат и боевой лог.
Сервер комнаты — авторитет клеток: двоих в одну клетку не сажает, отказы приходят событием `refuse`.

## Быстрый старт

```bash
npm install
# терминал 1 — комната (порт 3780)
npm start
# терминал 2 — фронт (http://localhost:3000)
npm run dev
```

Откройте `http://localhost:3000/?room=demo&name=Сырь` и вторую вкладку с другим `?name=`.
Комнаты: «Пивные гроты» (поле 10×6) и рисованная локация «Элизия Эйдес».

Тесты: `npm run test:queue` — очередь шагов (сервер поднимает сам); `npm run test:ws` — контракт комнаты,
нужен уже поднятый сервер (`npm start`, либо `WS_URL=ws://...`); `npm run test:unit` — юнит-тесты движка
(нужен node ≥22.6, на старых печатает SKIP); `npm run arch:check` — гейт архитектуры.

## Что уже есть в игре

Эпохи после базовой сетки: редактор локаций с кистью и entry-клетками, террейн с обрывами и
заряжёнными прыжками, смена дня-ночи и погоды, мирный режим с манекеном и мишенью «РАБ»,
комната «тест» 19×7 «Элизия Эйдес», наборы спрайтов Malyshochki/Puzik и пиксельная отрисовка локации.

## Прод

- Фронт: https://coop-field.vercel.app и https://abnocw.89-232-184-77.sslip.io (статика `/opt/coop-field/www` на VPS)
- Комната: `wss://coop.89-232-184-77.sslip.io` — VPS 89.232.184.77, systemd-сервис `coop-field`,
  **порт 8787** за nginx (локальный дефолт — 3780)

Пуш в `main` [gertha-puzik/coop-field](https://github.com/gertha-puzik/coop-field) запускает Actions:

| Workflow | Когда стартует | Что делает / ловит |
|----------|---------------|--------------------|
| «Проверки» (ci.yml) | push в `main`, PRы по путям кода | typecheck, юнит-тесты, гейт архитектуры (≥800 строк), версия `ws` в двух lockfile, очередь шагов |
| «Фронтенд на Vercel и VPS» | изменения `src/`, `public/`, Next-конфига, зависимостей | `vercel deploy --prod` + rsync `out/` → `/opt/coop-field/www` |
| «Сервер комнаты на VPS» | изменения `server.js`, `scripts/`, `deploy/vps/` | rsync + `deploy/vps/apply.sh` (рестарт только если серверные файлы изменились, health-check после) |

Секреты в GitHub: `VERCEL_TOKEN`, `VPS_SSH_KEY` — в коде и логах их нет.

## Для разработки — куда смотреть

- Протокол комнаты `[event, payload]`, лимиты и refuse-коды — [AGENTS.md](AGENTS.md).
- Слои модулей, зеркала-константы клиент↔сервер, план разреза god-файлов — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

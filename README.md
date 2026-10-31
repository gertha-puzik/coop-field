# Coop field — общее поле на canvas abnocw

Фронт — симулятор из [abnocw](https://github.com/ggaymelini/abnocw) (canvas, спрайты, панель настроек).
Комната — тот же WebSocket, что и раньше: до 3 котов, ходьба WASD, сервер — авторитет клеток.

Бой (когти / зубы / смерть) по сети не синхронизируется. Локальные манекены остаются, только пока вы одни в комнате.

## Локально

```bash
npm install
# терминал 1 — комната
npm start
# терминал 2 — Next UI
npm run dev
```

Откройте http://localhost:3000/?room=demo и ту же ссылку во второй вкладке.
Имя: `?name=Сырь`. Прод-сокет: `wss://coop.89-232-184-77.sslip.io`.

Проверка комнаты без браузера (сервер уже на 3780 или `WS_URL`):

```bash
npm run test:ws
```

## Деплой

| Куда | Что |
|------|-----|
| Vercel project `coop-field` | только Next-фронт |
| VPS `/opt/coop-field` + `coop-field.service` | `server.js` (WS + `/health`) |

Vercel serverless комнату не держит.

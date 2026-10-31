const WIDTH = 10;
const HEIGHT = 6;
const KEYS = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
  KeyQ: [-1, -1],
  KeyE: [1, -1],
  KeyZ: [-1, 1],
  KeyX: [1, 1],
};

const params = new URLSearchParams(location.search);
const roomInput = document.getElementById("room");
const loginInput = document.getElementById("login");
const statusEl = document.getElementById("status");
const shareEl = document.getElementById("share");
const locationEl = document.getElementById("location");
const table = document.getElementById("cages");
const PRODUCTION_WS = "wss://coop.89-232-184-77.sslip.io";

roomInput.value = params.get("room") || "demo";
loginInput.value = params.get("name") || params.get("login") || "";

const state = {
  ws: null,
  me: null,
  cats: new Map(),
  width: WIDTH,
  height: HEIGHT,
};

function isLocalHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function wsUrl() {
  const override = params.get("ws");
  if (override) return override;
  if (isLocalHost(location.hostname)) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}`;
  }
  if (location.hostname === "coop.89-232-184-77.sslip.io") {
    return `wss://${location.host}`;
  }
  return PRODUCTION_WS;
}

function emit(event, payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify([event, payload]));
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

function shareLink() {
  const url = new URL(location.href);
  url.searchParams.set("room", roomInput.value || "demo");
  if (loginInput.value) url.searchParams.set("name", loginInput.value);
  else url.searchParams.delete("name");
  history.replaceState(null, "", url);
  shareEl.innerHTML = `Ссылка комнаты: <a href="${url.pathname + url.search}">${url.href}</a>`;
}

function buildGrid() {
  table.replaceChildren();
  const tbody = document.createElement("tbody");
  for (let y = 1; y <= state.height; y++) {
    const tr = document.createElement("tr");
    for (let x = 1; x <= state.width; x++) {
      const td = document.createElement("td");
      td.dataset.x = String(x);
      td.dataset.y = String(y);
      if ((x === 1 && y === 6) || (x === 5 && y === 1)) td.classList.add("exit");
      td.addEventListener("click", () => clickCell(x, y));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

function cellAt(x, y) {
  return table.querySelector(`td[data-x="${x}"][data-y="${y}"]`);
}

function render() {
  for (const td of table.querySelectorAll("td")) td.replaceChildren();
  for (const cat of state.cats.values()) {
    const td = cellAt(cat.x, cat.y);
    if (!td) continue;
    const wrap = document.createElement("div");
    const disc = document.createElement("div");
    disc.className = "cat" + (state.me && cat.id === state.me.id ? " me" : "");
    disc.style.background = cat.color || "#888";
    disc.style.transform = `rotate(${cat.deg || 0}deg)`;
    const face = document.createElement("div");
    face.className = "face";
    disc.appendChild(face);
    const nick = document.createElement("span");
    nick.className = "nick";
    nick.textContent = cat.login || `#${cat.id}`;
    wrap.append(disc, nick);
    td.appendChild(wrap);
  }
}

function upsert(cat) {
  if (!cat || !cat.id) return;
  if (cat.x === 0 && cat.y === 0) {
    state.cats.delete(cat.id);
    if (state.me && state.me.id === cat.id) state.me = null;
    return;
  }
  const prev = state.cats.get(cat.id) || {};
  const next = { ...prev, ...cat };
  state.cats.set(cat.id, next);
  if (state.me && state.me.id === cat.id) state.me = next;
}

function loadField(field) {
  state.width = field.width || WIDTH;
  state.height = field.height || HEIGHT;
  if (field.location && field.location.name) locationEl.textContent = field.location.name;
  state.cats.clear();
  if (Array.isArray(field.cats)) {
    for (const cat of field.cats) upsert(cat);
  } else {
    const users = field.users || {};
    for (const col of Object.values(users)) {
      if (!Array.isArray(col)) continue;
      for (const cat of col) if (cat) upsert(cat);
    }
  }
  buildGrid();
  render();
}

function clickCell(x, y) {
  if (!state.me) return;
  const dx = x - state.me.x;
  const dy = y - state.me.y;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return;
  emit("move", { x: dx, y: dy });
}

function onEvent(event, payload) {
  if (event === "you") {
    state.me = payload;
    upsert(payload);
    setStatus(`Вы — ${payload.login} (#${payload.id}), клетка ${payload.x}:${payload.y}`);
    render();
  } else if (event === "field") {
    loadField(payload);
    if (state.me) {
      setStatus(`Вы — ${state.me.login} · комната ${payload.room || roomInput.value} · ${state.cats.size} на поле`);
    }
  } else if (event === "update cat" || event === "move") {
    upsert(payload);
    render();
    if (state.me && payload && payload.id === state.me.id && payload.x) {
      setStatus(`Вы — ${state.me.login} · ${payload.x}:${payload.y} · deg ${payload.deg ?? 0}`);
    } else if (state.me) {
      setStatus(`Вы — ${state.me.login} · комната ${roomInput.value} · ${state.cats.size} на поле`);
    }
  } else if (event === "info") {
    setStatus(String(payload));
  } else if (event === "noplace") {
    setStatus("Комната полная (макс. 3). Смените ?room=");
  }
}

function connect() {
  if (state.ws) state.ws.close();
  const ws = new WebSocket(wsUrl());
  state.ws = ws;
  ws.addEventListener("open", () => {
    setStatus("Соединение есть, заходим…");
    emit("join", { room: roomInput.value || "demo", login: loginInput.value });
    shareLink();
  });
  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (Array.isArray(msg)) onEvent(msg[0], msg[1]);
  });
  ws.addEventListener("close", () => setStatus("Сокет закрыт. Обновите страницу."));
}

document.getElementById("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  connect();
});

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea")) return;
  const delta = KEYS[e.code];
  if (!delta || e.repeat) return;
  e.preventDefault();
  emit("move", { x: delta[0], y: delta[1] });
});

buildGrid();
connect();

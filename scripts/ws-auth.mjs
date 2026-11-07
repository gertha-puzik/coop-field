/** Join helper: open rooms join immediately; room `test` registers (or logs in) first. */
export function sendJoin(ws, { room, login, pass = "password1" }) {
  if (room !== "test") {
    ws.send(JSON.stringify(["join", { room, login }]));
    return;
  }
  let sentJoin = false;
  const join = () => {
    if (sentJoin) return;
    sentJoin = true;
    ws.send(JSON.stringify(["join", { room, login }]));
  };
  const onMsg = (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg[0] !== "whoami") return;
    if (msg[1]?.accountId) {
      ws.off("message", onMsg);
      join();
    } else if (msg[1]?.reason === "taken") {
      ws.send(JSON.stringify(["auth", { action: "login", login, pass }]));
    }
  };
  ws.on("message", onMsg);
  ws.send(JSON.stringify(["auth", { action: "register", login, pass }]));
}

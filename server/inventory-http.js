/** Inventory HTTP boundary; ownership, admin permission and upload checks. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR } from "./config.js";
import { accountsStore, findById, activeCharacter } from "./accounts.js";
import { sessionFromRequest } from "./auth.js";
import { hasPermission } from "./access-roles.js";
import { json, setCors } from "./runtime-config.js";
import { readBody, PNG_MAGIC } from "./sprites.js";
import { writeFileAtomic } from "./atomic-file.js";
import { pushAdminAudit } from "./admin-audit.js";
import {
  itemCatalogue,
  inventoryView,
  saveItem,
  deleteItem,
  moveStack,
  grantItems,
  grantItemBatch,
} from "./inventory-store.js";
import { worldItemsView, actOnWorldItem } from "./world-items.js";
const dir = path.join(DATA_DIR, "items");
const fail = (res, out) =>
  json(res, out.status || 400, { ok: false, reason: out.error });
function characterOf(account, id) {
  return account?.characters?.find((character) => character.id === id);
}
export async function handleInventoryHttp(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url, "http://localhost"),
    p = url.pathname;
  if (
    req.method === "GET" &&
    /^\/cfg\/items\/files\/[a-f0-9]{64}\.png$/.test(p)
  ) {
    const file = path.join(dir, path.basename(p));
    if (!fs.existsSync(file))
      return json(res, 404, { ok: false, reason: "not_found" });
    res.writeHead(200, {
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const actor = sessionFromRequest(req)?.account;
  if (!actor || actor.profile?.deletedAt)
    return json(res, 401, { ok: false, reason: "auth_required" });
  if (p.startsWith("/cfg/items") && !hasPermission(actor, "items"))
    return json(res, 403, { ok: false, reason: "forbidden" });
  try {
    if (req.method === "GET") {
      if (p === "/cfg/inventory" || p === "/cfg/inventory/world") {
        const character = characterOf(
          actor,
          url.searchParams.get("characterId") || activeCharacter(actor)?.id,
        );
        if (!character)
          return json(res, 404, { ok: false, reason: "character_not_found" });
        return json(res, 200, {
          ok: true,
          ...(p.endsWith("/world")
            ? {
                world: worldItemsView(
                  actor.id,
                  character.id,
                  url.searchParams.has("catId")
                    ? Number(url.searchParams.get("catId"))
                    : undefined,
                ),
              }
            : { inventory: inventoryView(actor.id, character.id) }),
        });
      }
      if (p === "/cfg/items")
        return json(res, 200, { ok: true, items: itemCatalogue() });
      if (p === "/cfg/items/players")
        return json(res, 200, {
          ok: true,
          players: Object.values(accountsStore().accounts)
            .filter((a) => !a.profile?.deletedAt)
            .map((a) => ({
              accountId: a.id,
              login: a.login,
              name: a.profile?.displayName || a.login,
              characters: (a.characters || []).map((c) => ({
                id: c.id,
                name: c.name,
                weight: inventoryView(a.id, c.id).weight,
              })),
            })),
        });
    }
    if (req.method === "POST" && p === "/cfg/items/sprite") {
      const bytes = await readBody(req, 2 * 1024 * 1024);
      if (
        bytes.length < 33 ||
        !bytes.subarray(0, 8).equals(PNG_MAGIC) ||
        bytes.subarray(12, 16).toString() !== "IHDR"
      )
        return json(res, 400, { ok: false, reason: "invalid_png" });
      const w = bytes.readUInt32BE(16),
        h = bytes.readUInt32BE(20);
      if (w < 1 || h < 1 || w > 2048 || h > 2048 || w * h > 1048576)
        return json(res, 400, { ok: false, reason: "invalid_dimensions" });
      const name = createHash("sha256").update(bytes).digest("hex") + ".png";
      fs.mkdirSync(dir, { recursive: true });
      writeFileAtomic(path.join(dir, name), bytes);
      return json(res, 200, { ok: true, sprite: "/cfg/items/files/" + name });
    }
    if (req.method === "POST") {
      const raw = JSON.parse((await readBody(req, 8192)).toString());
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return json(res, 400, { ok: false, reason: "invalid_request" });
      if (p === "/cfg/inventory/move" || p === "/cfg/inventory/world") {
        const character = characterOf(actor, raw.characterId);
        if (!character)
          return json(res, 404, { ok: false, reason: "character_not_found" });
        const out = p.endsWith("/world")
          ? actOnWorldItem(actor.id, character.id, raw)
          : moveStack(actor.id, character.id, raw);
        return out.error
          ? fail(res, out)
          : json(res, 200, { ok: true, ...out });
      }
      if (p === "/cfg/items") {
        const out = saveItem(raw);
        if (out.error) return fail(res, out);
        pushAdminAudit(
          "items",
          `Сохранён предмет «${out.item.name}» (${out.item.id}), вес ${out.item.weight}`,
          actor.login,
        );
        return json(res, 200, { ok: true, ...out });
      }
      if (p === "/cfg/items/delete") {
        const out = deleteItem(String(raw.id || ""));
        if (out.error) return fail(res, out);
        pushAdminAudit(
          "items",
          `Удалён из базы предмет «${out.item.name}» (${out.item.id})`,
          actor.login,
        );
        return json(res, 200, { ok: true });
      }
      if (p === "/cfg/items/grant-batch") {
        if (
          !Array.isArray(raw.recipients) ||
          raw.recipients.some(
            (r) =>
              !r ||
              !characterOf(findById(String(r.accountId)), r.characterId) ||
              findById(String(r.accountId))?.profile?.deletedAt,
          )
        )
          return json(res, 404, { ok: false, reason: "character_not_found" });
        const out = grantItemBatch(
          actor.id,
          raw.recipients,
          raw.items,
          raw.comment || "",
          raw.operationId,
        );
        if (out.error) return fail(res, out);
        if (!out.replayed)
          pushAdminAudit(
            "items",
            `Выдача: ${raw.items.map((r) => `${r.itemId} ×${r.quantity}`).join(", ")} → ${raw.recipients.map((r) => `${findById(r.accountId)?.login}/${r.characterId}`).join(", ")}${raw.comment ? `; ${raw.comment}` : ""}`,
            actor.login,
          );
        return json(res, 200, { ok: true, ...out });
      }
      if (p === "/cfg/items/grant") {
        const target = findById(String(raw.accountId || "")),
          character = characterOf(target, raw.characterId);
        if (!target || target.profile?.deletedAt || !character)
          return json(res, 404, { ok: false, reason: "character_not_found" });
        const out = grantItems(actor.id, target.id, character.id, raw);
        if (out.error) return fail(res, out);
        if (!out.replayed)
          pushAdminAudit(
            "items",
            `Выдано: ${out.item.name} ×${raw.quantity} → ${target.login}, персонаж «${character.name}» (${character.id})`,
            actor.login,
          );
        return json(res, 200, {
          ok: true,
          inventory: out.inventory,
          replayed: out.replayed,
        });
      }
    }
    return json(res, 404, { ok: false, reason: "not_found" });
  } catch (error) {
    return json(res, error?.code === "too_large" ? 413 : 400, {
      ok: false,
      reason: error?.code === "too_large" ? "too_large" : "invalid_request",
    });
  }
}

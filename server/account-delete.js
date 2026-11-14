/**
 * Самоудаление аккаунта (DELETE /profiles/me).
 *
 * Строка в accounts.json остаётся, но перестаёт быть входом и публичной
 * карточкой: логин меняется на маркер, привязанный к id, пароль заменяется
 * случайным хэшем, день рождения, био, СП и аватарка стираются, отображаемое
 * имя становится «Удалён <id>». Сессии этого accountId отзываются все.
 *
 * Личные файлы только этого аккаунта: avatars/<id>.png|jpg и строки каталога
 * спрайтов с ownerAccountId === id (не builtin и не чужой владелец).
 *
 * Книга позиций (server/persist.js) ключуется только именем персонажа, без
 * accountId. Одно и то же имя может быть у другого кота, поэтому ни одну
 * запись test-cats.json удаление не трогает — иначе снос по совпавшему имени
 * сдвинул бы чужого игрока. Имена персонажей в строке аккаунта по той же
 * причине не переписываются.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "./config.js";
import { flushAccounts, hashPassword, verifyPassword } from "./accounts.js";
import { mutateSprites } from "./sprites.js";
import { revokeAccountSessions } from "./auth.js";
import { forgetActivity } from "./activity.js";

const AVATAR_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Удаляет файлы аватарки этого id. Чужой id в путь не подставляется. */
function removeOwnAvatarFiles(accountId) {
  if (!AVATAR_ID.test(accountId)) {
    return { error: "bad_id" };
  }
  const dir = path.join(DATA_DIR, "avatars");
  for (const ext of ["png", "jpg"]) {
    const file = path.join(dir, `${accountId}.${ext}`);
    if (path.dirname(file) !== dir) return { error: "bad_id" };
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if (e?.code !== "ENOENT") {
        console.warn("avatar delete failed:", e?.message || e);
        return { error: "io" };
      }
    }
  }
  return { ok: true };
}

/** Удаляет файлы баннера профиля этого id. */
function removeOwnBannerFiles(accountId) {
  if (!AVATAR_ID.test(accountId)) {
    return { error: "bad_id" };
  }
  const dir = path.join(DATA_DIR, "banners");
  for (const ext of ["png", "jpg", "gif"]) {
    const file = path.join(dir, `${accountId}.${ext}`);
    if (path.dirname(file) !== dir) return { error: "bad_id" };
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if (e?.code !== "ENOENT") {
        console.warn("banner delete failed:", e?.message || e);
        return { error: "io" };
      }
    }
  }
  return { ok: true };
}

/** Снимает личные окрасы владельца. Builtin и чужие ownerAccountId не входят. */
async function removeOwnSprites(accountId) {
  return mutateSprites((ops) => {
    const mine = ops.rows.filter(
      (row) => row && !row.builtin && row.ownerAccountId === accountId,
    );
    const ids = [];
    for (const row of mine) {
      const commit = ops.commitRemove(row);
      if (commit.io) return { error: "io", cause: commit.error };
      ids.push(row.id);
    }
    return { ok: true, ids };
  });
}

/**
 * Проверяет пароль и только потом стирает файлы и обезличивает строку.
 * Неверный пароль ничего не меняет.
 */
export async function deleteOwnAccount(acc, password) {
  if (!acc || typeof acc.id !== "string") return { error: "bad_id" };
  const pass = typeof password === "string" ? password : "";
  if (!pass) return { error: "password_required" };
  const matches = await verifyPassword(pass, acc.pass);
  if (!matches) return { error: "bad_password" };

  const sprites = await removeOwnSprites(acc.id);
  if (sprites.error) return { error: "io" };
  const avatars = removeOwnAvatarFiles(acc.id);
  if (avatars.error) return { error: avatars.error === "bad_id" ? "bad_id" : "io" };
  const banners = removeOwnBannerFiles(acc.id);
  forgetActivity(acc.id);
  if (banners.error) return { error: banners.error === "bad_id" ? "bad_id" : "io" };

  const removed = new Set(sprites.ids || []);
  if (Array.isArray(acc.characters)) {
    for (const ch of acc.characters) {
      if (ch && removed.has(ch.sprite)) ch.sprite = "";
    }
  }
  acc.login = `x${acc.id}`;
  acc.pass = await hashPassword(randomBytes(32).toString("hex"));
  acc.profile = {
    displayName: `Удалён ${acc.id}`,
    bio: "",
    birthday: null,
    avatarCharacterId: null,
    avatarExt: null,
    avatarAt: 0,
    bannerExt: null,
    bannerAt: 0,
    playtimeMs: 0,
    deletedAt: Date.now(),
  };
  flushAccounts(true);
  revokeAccountSessions(acc.id);
  return { ok: true };
}

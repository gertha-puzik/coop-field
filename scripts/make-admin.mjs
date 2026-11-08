#!/usr/bin/env node
/**
 * Одноразовый CLI владелицы: назначение роли admin (аудит Z.AI S1, 2026-11-08).
 *
 *   node scripts/make-admin.mjs <login> [pass]
 *
 * • логин занят → ПОВЫШЕНИЕ существующего аккаунта до admin с сохранением
 *   пароль-хеша и остальных полей (pass в этом случае игнорируется и НЕ нужен);
 * • логин свободен → создаёт аккаунт сразу с ролью admin (scrypt-хеш тем же
 *   форматом, что createAccount в server/accounts.js; pass обязателен, минимум
 *   PASS_MIN символов);
 * • уже admin → no-op (idempotent, exit 0);
 * • ПОНИЖЕНИЕ роли и удаление аккаунтов CLI не умеет вообще; правит ТОЛЬКО
 *   accounts.json (атомарная запись tmp+rename, как в accounts.js).
 *
 * ЗАПУСКАТЬ ПРИ ОСТАНОВЛЕННОМ СЕРВЕРЕ (systemctl stop coop-field): работающий
 * сервер держит копию стора в памяти и своим следующим flush'ом перезапишет
 * файл. После назначения — systemctl start coop-field (команды для владелицы
 * см. в отчёте B7). DATA_DIR — тот же env, что у сервера (по умолчанию data/).
 */
import {
  PASS_MIN,
  findByLogin,
  createAccount,
  promoteToAdmin,
  flushAccounts,
} from "../server/accounts.js";

const argLogin = String(process.argv[2] || "").trim();
const argPass = String(process.argv[3] || "");

if (!argLogin) {
  console.error("Использование: node scripts/make-admin.mjs <login> [pass]");
  console.error("  login — имя аккаунта (существующий повышается, новый создаётся с ролью admin).");
  console.error("  pass  — пароль ТОЛЬКО для нового аккаунта (минимум " + PASS_MIN + " символов).");
  console.error("Сервер должен быть остановлен; DATA_DIR — как у сервера.");
  process.exit(1);
}

const existing = findByLogin(argLogin);
if (existing) {
  const out = promoteToAdmin(argLogin);
  if (out.error) {
    console.error(`make-admin: ошибка (${out.error}) — ${JSON.stringify(argLogin)}`);
    process.exit(1);
  }
  flushAccounts(true);
  if (out.already) {
    console.log(`make-admin: ${argLogin} уже админ (idempotent, ничего не изменено).`);
  } else {
    console.log(`make-admin: ${argLogin} повышен до admin (пароль-хеш сохранён).`);
  }
  process.exit(0);
}

// Свободное имя: создаём аккаунт с ролью admin (создание — + немедленное
// повышение той же атомарной записью; до выключения процесса сервера не доходит).
if (Array.from(argPass).length < PASS_MIN) {
  console.error(
    `make-admin: аккаунта «${argLogin}» нет — для создания нужен пароль (минимум ${PASS_MIN} символов):`,
  );
  console.error(`  node scripts/make-admin.mjs ${JSON.stringify(argLogin)} <pass>`);
  process.exit(1);
}
const created = await createAccount(argLogin, argPass);
if (created.error) {
  console.error(`make-admin: создать аккаунт не удалось (${created.error}).`);
  process.exit(1);
}
const promoted = promoteToAdmin(argLogin);
if (promoted.error) {
  console.error(`make-admin: аккаунт создан, но повышение упало (${promoted.error}).`);
  process.exit(1);
}
flushAccounts(true);
console.log(`make-admin: аккаунт ${argLogin} создан с ролью admin.`);

/**
 * Одна атомарная запись data-файлов: временный файл `${file}.tmp` и rename.
 * Так писали локальные копии writeFileAtomic. Режим файла не задаётся —
 * writeFileSync без mode, как в тех копиях.
 *
 * Не переведены:
 * - server/auth.js — своя копия, файл в открытых PR 115–117;
 * - server/room-config.js — не эта функция: tmp+rename с mode 0o600.
 */
import fs from "node:fs";

export function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

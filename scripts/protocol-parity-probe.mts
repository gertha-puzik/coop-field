// @ts-nocheck
// Зонд клиентского канона протокола (W3): дампит значения реестра
// src/lib/net/protocol.ts JSON-ом в stdout. Исполнитель — parent-скрипт
// scripts/test-protocol-parity.mjs через node --experimental-strip-types
// (нужен node >= 22.6; сам по себе файл ничего не проверяет и не печатает
// ничего кроме JSON, чтобы вывод парсился однозначно).
// Запуск вручную: node --experimental-strip-types scripts/protocol-parity-probe.mts
import * as protocol from "../src/lib/net/protocol.ts";

const dump = {
  CLIENT_TO_SERVER: [...protocol.CLIENT_TO_SERVER],
  SERVER_TO_CLIENT: [...protocol.SERVER_TO_CLIENT],
  EV: { ...protocol.EV },
  MAX_PLAYERS: protocol.MAX_PLAYERS,
  MOVE_COOLDOWN_MS: protocol.MOVE_COOLDOWN_MS,
  MOVE_QUEUE_MAX: protocol.MOVE_QUEUE_MAX,
  JOIN_COOLDOWN_MS: protocol.JOIN_COOLDOWN_MS,
  AIM_MIN_GAP_MS: protocol.AIM_MIN_GAP_MS,
  STRIKE_CATCH_MS: protocol.STRIKE_CATCH_MS,
  STRIKE_CATCH_MAX_MS: protocol.STRIKE_CATCH_MAX_MS,
  CHAT_MAX_LEN: protocol.CHAT_MAX_LEN,
  CHAT_COOLDOWN_MS: protocol.CHAT_COOLDOWN_MS,
  CHAT_HISTORY: protocol.CHAT_HISTORY,
  STRIKE_ZONES: protocol.STRIKE_ZONES,
  ARMOR_CURVE: protocol.ARMOR_CURVE.map((p) => [...p]),
  GROUND_COVER_IDS: [...protocol.GROUND_COVER_IDS],
  TERRAIN_MAX_LEVEL: protocol.TERRAIN_MAX_LEVEL,
  ELEV_STEP_MAX: protocol.ELEV_STEP_MAX,
  JUMP_CHARGE_HALF: protocol.JUMP_CHARGE_HALF,
  JUMP_CHARGE_FULL: protocol.JUMP_CHARGE_FULL,
  JUMP_MAX_UP: protocol.JUMP_MAX_UP,
  TEST_MAP_LIMITS: { ...protocol.TEST_MAP_LIMITS },
  DUMMY_DEFAULT: { ...protocol.DUMMY_DEFAULT },
  RAB_CELL: { ...protocol.RAB_CELL },
  ATMO_PHASE_LIST: [...protocol.ATMO_PHASE_LIST],
  ATMO_WEATHER_LIST: [...protocol.ATMO_WEATHER_LIST],
  ATMO_PHASE_MS_DEF: protocol.ATMO_PHASE_MS_DEF,
  ATMO_WEATHER_MS_DEF: protocol.ATMO_WEATHER_MS_DEF,
  ATMO_PHASE_MS_MIN: protocol.ATMO_PHASE_MS_MIN,
  ATMO_PHASE_MS_MAX: protocol.ATMO_PHASE_MS_MAX,
  ATMO_WEATHER_MS_MIN: protocol.ATMO_WEATHER_MS_MIN,
  ATMO_WEATHER_MS_MAX: protocol.ATMO_WEATHER_MS_MAX,
  JUMP_COOLDOWN_MS: protocol.JUMP_COOLDOWN_MS,
  JUMP_MAX_CELLS: protocol.JUMP_MAX_CELLS,
  JUMP_DIRECTIONS: protocol.JUMP_DIRECTIONS,
  JUMP_MAX_DROP: protocol.JUMP_MAX_DROP,
};

console.log(JSON.stringify(dump));

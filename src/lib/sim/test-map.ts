/**
 * Конфигурация локации комнаты «тест» — то, что правит редактор локации.
 *
 * Мир задаётся размером в клетках и списком зон двух видов:
 *  - «cells» — зона с клетками: в боевом режиме ходьба строго по клеткам,
 *    на земле рисуется доска с сеткой;
 *  - «green» — зелёная зона: только мирный режим (свободная ходьба по якорям),
 *    чистая трава с цветами, сетки нет.
 *
 * Из зон (с отступом margin) клиент и сервер строят одинаковую нарисованную
 * кромку локации, поэтому конфиг обязан проходить строгую проверку
 * (sanitizeTestMap) на обеих сторонах — порт проверки для server.js держится
 * рядом с портом геометрии.
 */

export type TestMapZoneKind = 'cells' | 'green';

/** Физическое препятствие: камень или дерево на клетке (0-based). Через него
 *  нельзя пройти ни в мирном режиме (якоря внутри заняты), ни в боевом
 *  (клетка непроходима). Спрайт рисуется от низа клетки вверх. */
export type TestMapObjectKind = 'stone' | 'tree';

export type TestMapObject = {
  id: string;
  kind: TestMapObjectKind;
  /** 0-based клетка, которую объект занимает целиком. */
  c: number;
  r: number;
};

export type TestMapZone = {
  id: string;
  name: string;
  kind: TestMapZoneKind;
  /** 0-based координаты, включительно: зона занимает клетки c0..c1 × r0..r1. */
  c0: number;
  r0: number;
  c1: number;
  r1: number;
};

export type TestMap = {
  v: 1;
  cols: number;
  rows: number;
  /** Насколько (в долях клетки) нарисованная кромка отступает от зон. */
  margin: number;
  /** Сид дрожи кромки и декора — одинаковая картинка у всех игроков. */
  seed: string;
  zones: TestMapZone[];
  /** Физические препятствия: камни и деревья (появились позже зон — поэтому
   *  необязательное поле; старые конфиги без него читаются как «пусто»). */
  objects?: TestMapObject[];
};

/** Пределы редактора: мир, число зон и число препятствий. */
export const TEST_MAP_LIMITS = {
  colsMin: 6,
  colsMax: 60,
  rowsMin: 3,
  rowsMax: 40,
  zonesMax: 48,
  objectsMax: 60,
  nameMax: 24,
} as const;

/** Локация «тест» по умолчанию — та же раскладка, что была залита в код. */
export const TEST_MAP_DEFAULT: TestMap = {
  v: 1,
  cols: 19,
  rows: 7,
  margin: 0.5,
  seed: 'test',
  zones: [
    { id: 'z1', name: 'Лужайка', kind: 'cells', c0: 0, r0: 0, c1: 9, r1: 6 },
    { id: 'z2', name: 'Переход', kind: 'cells', c0: 10, r0: 1, c1: 12, r1: 5 },
    { id: 'z3', name: 'Закуток', kind: 'cells', c0: 13, r0: 0, c1: 18, r1: 5 },
  ],
};

let uidSeq = 0;

/** Уникальный id зоны (в пределах сессии — больше от него ничего не требуется). */
export function newZoneId(): string {
  uidSeq += 1;
  return `z${Date.now().toString(36)}-${uidSeq.toString(36)}`;
}

/** Уникальный id препятствия (камень/дерево). */
export function newObjectId(): string {
  uidSeq += 1;
  return `o${Date.now().toString(36)}-${uidSeq.toString(36)}`;
}

function asInt(v: unknown): number | null {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Зоны обязаны срастаться в один островок: у контура объединения в каждой вершине
 * ровно два граничных ребра только если зоны перекрываются или касаются сторонами.
 * Диагональное касание или разрыв дают развилку/второй остров — контур соберётся
 * неверно, поэтому такая конфигурация отклоняется с понятной ошибкой.
 */
export function testMapConnectivityError(zones: TestMapZone[]): string | null {
  const cells = new Set<string>();
  for (const z of zones) {
    for (let r = z.r0; r <= z.r1; r++) {
      for (let c = z.c0; c <= z.c1; c++) cells.add(`${c},${r}`);
    }
  }
  if (cells.size === 0) return 'Локация пуста — нужна хотя бы одна зона.';
  const start = cells.keys().next().value as string;
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const [c, r] = queue.pop()!.split(',').map(Number);
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const k = `${c + dc},${r + dr}`;
      if (cells.has(k) && !seen.has(k)) {
        seen.add(k);
        queue.push(k);
      }
    }
  }
  if (seen.size !== cells.size) {
    return 'Зоны должны соединяться в одну локацию (касаться сторонами, не углами).';
  }
  return null;
}

/**
 * Строгая проверка конфига (клиент перед отправкой и сервер перед сохранением).
 * Возвращает нормализованный конфиг или понятную ошибку — второе сообщение идёт
 * в интерфейс редактора без изменений.
 */
export function sanitizeTestMap(raw: unknown): { map?: TestMap; error?: string } {
  if (!raw || typeof raw !== 'object') return { error: 'конфиг не распознан' };
  const src = raw as Partial<TestMap> & { v?: unknown };
  if (src.v !== 1) return { error: 'неизвестная версия конфига' };
  const cols = asInt(src.cols);
  const rows = asInt(src.rows);
  if (cols === null || rows === null) return { error: 'размер мира не распознан' };
  if (cols < TEST_MAP_LIMITS.colsMin || cols > TEST_MAP_LIMITS.colsMax) {
    return { error: `ширина мира должна быть ${TEST_MAP_LIMITS.colsMin}–${TEST_MAP_LIMITS.colsMax}` };
  }
  if (rows < TEST_MAP_LIMITS.rowsMin || rows > TEST_MAP_LIMITS.rowsMax) {
    return { error: `высота мира должна быть ${TEST_MAP_LIMITS.rowsMin}–${TEST_MAP_LIMITS.rowsMax}` };
  }
  if (!Array.isArray(src.zones) || src.zones.length === 0) return { error: 'список зон пуст' };
  if (src.zones.length > TEST_MAP_LIMITS.zonesMax) {
    return { error: `зон не больше ${TEST_MAP_LIMITS.zonesMax}` };
  }
  // Препятствия необязательны: старые конфиги без поля objects читаются как «пусто».
  let objects: TestMapObject[] = [];
  if (src.objects != null) {
    if (!Array.isArray(src.objects)) return { error: 'список препятствий не распознан' };
    if (src.objects.length > TEST_MAP_LIMITS.objectsMax) {
      return { error: `препятствий не больше ${TEST_MAP_LIMITS.objectsMax}` };
    }
    const taken = new Set<string>();
    for (let i = 0; i < src.objects.length; i++) {
      const o = src.objects[i] as Partial<TestMapObject>;
      const kind = o.kind === 'stone' ? 'stone' : o.kind === 'tree' ? 'tree' : null;
      if (!kind) return { error: `препятствие №${i + 1}: неизвестный тип` };
      const c = asInt(o.c);
      const r = asInt(o.r);
      if (c === null || r === null || c < 0 || r < 0 || c >= cols || r >= rows) {
        return { error: `препятствие №${i + 1}: вне границ мира` };
      }
      const key = `${c},${r}`;
      if (taken.has(key)) continue; // два объекта на одной клетке схлопываем в один
      taken.add(key);
      objects.push({ id: `o${i + 1}`, kind, c, r });
    }
  }
  const zones: TestMapZone[] = [];
  for (let i = 0; i < src.zones.length; i++) {
    const z = src.zones[i] as Partial<TestMapZone>;
    const kind = z.kind === 'green' ? 'green' : z.kind === 'cells' ? 'cells' : null;
    if (!kind) return { error: `зона №${i + 1}: неизвестный тип` };
    const c0 = asInt(z.c0);
    const r0 = asInt(z.r0);
    const c1 = asInt(z.c1);
    const r1 = asInt(z.r1);
    if (c0 === null || r0 === null || c1 === null || r1 === null) {
      return { error: `зона №${i + 1}: координаты не распознаны` };
    }
    if (c0 < 0 || r0 < 0 || c0 > c1 || r0 > r1 || c1 >= cols || r1 >= rows) {
      return { error: `зона №${i + 1}: выходит за границы мира` };
    }
    const name = String(z.name ?? '').trim().slice(0, TEST_MAP_LIMITS.nameMax) || (kind === 'cells' ? 'Клетки' : 'Зелёная зона');
    zones.push({ id: `z${i + 1}`, name, kind, c0, r0, c1, r1 });
  }
  if (!zones.some((z) => z.kind === 'cells')) {
    return { error: 'нужна хотя бы одна зона с клетками — иначе бой не работает' };
  }
  const conn = testMapConnectivityError(zones);
  if (conn) return { error: conn };
  return {
    map: {
      v: 1,
      cols,
      rows,
      margin: 0.5,
      seed: typeof src.seed === 'string' && src.seed.trim() ? src.seed.trim().slice(0, 24) : 'test',
      zones,
      objects,
    },
  };
}

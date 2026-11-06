/**
 * Cell-object tools of the location editor: dirt/ground painting, battle cell,
 * spawn points, entry cells. Carved from editor-ops (god-file diet,
 * ARCHITECTURE §8); bodies unchanged, closures come from the deps factory.
 */
import type { RefObject } from 'react';
import type { EditorDraft } from '@/lib/sim/editor-model';
import { paintCellCoverage, paintPointOn, testObjectAt } from '@/lib/sim/test-field';
import {
  newObjectId,
  TEST_MAP_LIMITS,
  type GroundCover,
  type TestMapEntryDir,
} from '@/lib/sim/test-map';

export interface EditorCellsDeps {
  editorRef: RefObject<EditorDraft | null>;
  editorCoverRef: RefObject<GroundCover>;
  editorEntryDirRef: RefObject<TestMapEntryDir>;
  setEditorMsg: (msg: string | null) => void;
  pushEditorUndo: (withPaint?: boolean) => void;
  applyDraftPreview: () => void;
  syncEditorView: () => void;
}

export function buildEditorCells({
  editorRef,
  editorCoverRef,
  editorEntryDirRef,
  setEditorMsg,
  pushEditorUndo,
  applyDraftPreview,
  syncEditorView,
}: EditorCellsDeps) {
  /** Протяжка «Земли»/«Покрытия»: насыпает клетки без снятия и без записи отмены
   *  на каждую клетку (отмена пишется один раз на росчерк — см. pointerdown).
   *  Земля и покрытие не совмещаются на одной клетке: покрытие заменяет проталину. */
  const paintEditorCellObject = (kind: 'dirt' | 'ground', c: number, r: number): boolean => {
    const d = editorRef.current;
    if (!d) return false;
    if (d.objects.some((o) => (o.kind === 'dirt' || o.kind === 'ground') && o.c === c && o.r === r)) return false;
    if (d.objects.length >= TEST_MAP_LIMITS.objectsMax) {
      setEditorMsg(`Объектов не больше ${TEST_MAP_LIMITS.objectsMax}.`);
      return false;
    }
    d.objects.push(
      kind === 'ground'
        ? { id: newObjectId(), kind: 'ground', c, r, cv: editorCoverRef.current, pos: 'center' }
        : { id: newObjectId(), kind: 'dirt', c, r, pos: 'center' },
    );
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
    return true;
  };

  /** Клетка спавна разрешена только на траве (зелёной зоне) и не на боевых
   *  клетках: новичок появляется в мирном режиме (это же проверяет сервер). */
  const editorSpawnAllowed = (d: EditorDraft, c: number, r: number): boolean => {
    const onBattle =
      d.zones.some((z) => z.kind === 'cells' && c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1) ||
      d.objects.some((o) => o.kind === 'battle' && o.c === c && o.r === r);
    if (onBattle) return false;
    // С рисунком кисти спавн — на любом закрашенном месте (не на боевых клетках);
    // без рисунка — по-старому, только в зелёной зоне.
    if (d.pcv) return paintPointOn(c + 0.5, r + 0.5);
    return d.zones.some((z) => z.kind === 'green' && c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1);
  };

  /** Поставить/снять одиночную боевую клетку (kind «battle»). Боевая клетка —
   *  область 150×100: ставится только на место, покрашенное кистью целиком;
   *  если место не соответствует размерам — клетка не ставится. Повторный клик
   *  по уже стоящей клетке снимает её. */
  const placeBattleCell = (c: number, r: number) => {
    const d = editorRef.current;
    if (!d) return;
    const existing = d.objects.some((o) => o.kind === 'battle' && o.c === c && o.r === r);
    if (!existing && !d.pcv) {
      setEditorMsg(
        'Боевая клетка ставится на закрашенное кистью место: проведите кистью (пресет «Клетка 150×100»), затем кликните по клетке.',
      );
      return;
    }
    if (!existing && paintCellCoverage(c, r) < 0.995) {
      setEditorMsg(
        `Боевая клетка ${c + 1}×${r + 1} не поставлена: место покрашено не целиком. Закрасьте область клетки пресетом кисти «Клетка 150×100».`,
      );
      return;
    }
    if (!existing && testObjectAt(c, r)) {
      setEditorMsg(`Боевая клетка ${c + 1}×${r + 1} не поставлена: на клетке уже стоит другой объект.`);
      return;
    }
    pushEditorUndo();
    if (existing) {
      d.objects = d.objects.filter((o) => !(o.kind === 'battle' && o.c === c && o.r === r));
    } else {
      d.objects.push({ id: newObjectId(), kind: 'battle', c, r, pos: 'center' });
    }
    d.dirty = true;
    setEditorMsg(existing ? `Боевая клетка ${c + 1}×${r + 1} снята.` : null);
    syncEditorView();
    applyDraftPreview();
  };

  /** Добавить клетку спавна (клик/протяжка инструмента «Спавн»): одна точка
   *  на клетку, лимит TEST_MAP_LIMITS.spawnsMax. */
  const addEditorSpawn = (c: number, r: number): boolean => {
    const d = editorRef.current;
    if (!d) return false;
    if (d.spawns.some((s) => s.c === c && s.r === r)) return true;
    if (!editorSpawnAllowed(d, c, r)) {
      setEditorMsg('Клетка спавна ставится на траве (зелёной зоне), не на боевых клетках.');
      return false;
    }
    if (d.spawns.length >= TEST_MAP_LIMITS.spawnsMax) {
      setEditorMsg(`Клеток спавна не больше ${TEST_MAP_LIMITS.spawnsMax}.`);
      return false;
    }
    d.spawns.push({ c, r });
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
    return true;
  };

  /** Клик инструментом «Спавн»: клетка со спавном — снимает, без — ставит. */
  const toggleEditorSpawn = (c: number, r: number): boolean => {
    const d = editorRef.current;
    if (!d) return false;
    const idx = d.spawns.findIndex((s) => s.c === c && s.r === r);
    if (idx < 0) return addEditorSpawn(c, r);
    d.spawns.splice(idx, 1);
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
    return true;
  };

  /** Постановка клетки захода (инструмент «Заход»): клик ставит заход с выбранным
   *  направлением, клик по тому же заходу с тем же направлением — убирает, с другим —
   *  меняет направление. На боевой клетке заход не ставится; по направлению шага
   *  обязана быть боевая клетка (это же проверяет сервер при сохранении). */
  const placeEditorEntry = (c: number, r: number): boolean => {
    const d = editorRef.current;
    if (!d) return false;
    const dir = editorEntryDirRef.current;
    const idx = d.objects.findIndex((o) => o.c === c && o.r === r);
    if (idx >= 0 && d.objects[idx].kind === 'entry') {
      pushEditorUndo();
      if (d.objects[idx].dir === dir) d.objects.splice(idx, 1);
      else d.objects[idx] = { ...d.objects[idx], dir };
      d.dirty = true;
      applyDraftPreview();
      syncEditorView();
      return true;
    }
    const isBattleAt = (cc: number, rr: number): boolean =>
      d.zones.some((z) => z.kind === 'cells' && cc >= z.c0 && cc <= z.c1 && rr >= z.r0 && rr <= z.r1) ||
      d.objects.some((o) => o.kind === 'battle' && o.c === cc && o.r === rr);
    const battleCell = isBattleAt(c, r);
    const targetBattle = isBattleAt(
      c + (dir === 'left' ? -1 : dir === 'right' ? 1 : 0),
      r + (dir === 'up' ? -1 : dir === 'down' ? 1 : 0),
    );
    if (battleCell) {
      setEditorMsg('Клетка захода ставится на траве рядом с боевой зоной, не на боевых клетках.');
      return false;
    }
    if (!targetBattle) {
      setEditorMsg('По направлению шага должна быть боевая клетка — выберите направление в сторону зоны.');
      return false;
    }
    // Логика боевых клеток — и для заходов: заход занимает клетку 150×100 и
    // ставится только на место, покрашенное кистью целиком.
    if (d.pcv && paintCellCoverage(c, r) < 0.995) {
      setEditorMsg(
        `Заход ${c + 1}×${r + 1} не поставлен: место покрашено не целиком. Закрасьте область клетки пресетом кисти «Клетка 150×100».`,
      );
      return false;
    }
    if (idx < 0 && d.objects.length >= TEST_MAP_LIMITS.objectsMax) {
      setEditorMsg(`Объектов не больше ${TEST_MAP_LIMITS.objectsMax}.`);
      return false;
    }
    pushEditorUndo();
    if (idx >= 0) d.objects.splice(idx, 1); // замена другого объекта на заход
    d.objects.push({ id: newObjectId(), kind: 'entry', c, r, pos: 'center', dir });
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
    return true;
  };

  return { paintEditorCellObject, placeBattleCell, addEditorSpawn, toggleEditorSpawn, placeEditorEntry };
}

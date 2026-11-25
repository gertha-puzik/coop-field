import type { EditorDraft } from '@/lib/sim/editor-model';
import { closestTerrainEdge, stampTriangle, triangleAt } from '@/lib/sim/terrain-forms';

export function applyLandscapeTool(ed: EditorDraft, button: number, pushEditorUndo: (withPaint: boolean, label: string) => void) {
  const point = ed.terrainCursor;
  if (!point) return false;
  if (ed.tool==='triangle' && button===0) {
    const brush=ed.elevBrush??{width:1,depth:1,level:1};
    const outline=triangleAt(ed.elev,point.x,point.y,brush.width,brush.depth,ed.triangleControls??[],ed.triangleRotation??0,ed.triangleMagnet!==false);
    const elevation={...ed.elev};
    if (stampTriangle(elevation,outline,brush.level,ed.cols,ed.rows)) {
      pushEditorUndo(false,'Треугольный блок');
      ed.elev=elevation;ed.dirty=true;
    }
    return true;
  }
  if (ed.tool==='waterfall' && (button===0 || button===2)) {
    if (button===2) {
      const found=ed.objects.find(o=>o.kind==='waterfall'&&Math.hypot((o.x??o.c)-point.x,(o.y??o.r)-point.y)<.7);
      if (found) {
        pushEditorUndo(false,'Удаление водопада');
        ed.objects=ed.objects.filter(o=>o!==found);
        ed.dirty=true;
      }
    } else {
      const edge=closestTerrainEdge(ed.elev,point.x,point.y,.8,true);
      if (edge) {
        pushEditorUndo(false,'Водопад');
        const dir=edge.axis==='x'?(edge.normal===1?'down':'up'):(edge.normal===1?'right':'left');
        ed.objects.push({id:crypto.randomUUID(),kind:'waterfall',c:Math.min(ed.cols-1,Math.floor(edge.x)),r:Math.min(ed.rows-1,Math.floor(edge.y)),x:edge.x,y:edge.y,s:edge.width,dir});
        ed.dirty=true;
      }
    }
    return true;
  }
  return false;
}

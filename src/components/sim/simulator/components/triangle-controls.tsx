import { useRef } from 'react';
import { triangleProfile, type TriangleControl } from '@/lib/sim/terrain-forms';
import styles from './editor-workspace.module.css';

export function TriangleControls({controls,onChange}: {
  controls: TriangleControl[];
  onChange: (controls: TriangleControl[]) => void;
}) {
  const drag = useRef<number | null>(null);
  return <>
    <svg viewBox="-.18 -.18 1.36 1.63" width="100%" height="150" style={{touchAction:'none'}}
      aria-label="Контур треугольника"
      onPointerMove={event=>{
        const index=drag.current, matrix=event.currentTarget.getScreenCTM();
        if (index===null || !matrix || !controls[index]) return;
        const point=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
        onChange(controls.map((control,i)=>i===index?{...control,offset:Math.round(
          Math.max(-.7*(1-control.t),Math.min(.42,point.y-(1-control.t)))*100)/100}:control));
      }}
      onPointerUp={()=>{drag.current=null;}} onLostPointerCapture={()=>{drag.current=null;}}>
      <polygon points={triangleProfile(controls).map(({x,y})=>`${x},${y}`).join(' ')} fill="#846a5375" stroke="#efd09b" strokeWidth=".025"/>
      {controls.map(({t,offset},index)=><circle key={t} cx={t} cy={1-t+offset} r=".053"
        fill="#f1b66e" stroke="#453047" strokeWidth=".012" style={{cursor:'ns-resize'}}
        onPointerDown={event=>{event.preventDefault();drag.current=index;event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);}}/>)}
    </svg>
    <div className={styles.segment}>
      <button type="button" disabled={controls.length>=5} onClick={()=>{
        const options=[.5,.25,.75,.125,.875];
        const t=options.find(value=>controls.every(control=>control.t!==value));
        if (t!==undefined) onChange([...controls,{t,offset:0}]);
      }}>Добавить точку</button>
      <button type="button" disabled={!controls.length} onClick={()=>onChange([])}>Сбросить точки</button>
    </div>
    <p className={styles.hint}>Потяните точки длинной стороны, чтобы изменить форму следующего блока.</p>
  </>;
}

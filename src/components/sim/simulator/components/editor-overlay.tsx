/** Location workspace: tool rail, contextual inspector, canvas toolbar and
 * persistent save tray. Editing data remains in the existing draft/operations.
 */
import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { Button } from '@/components/ui';
import type { EditorDraft, EditorPlace, EditorTool } from '@/lib/sim/editor-model';
import { PAINT_MATS } from '@/lib/sim/paint';
import { clampBrush, isElevationTool } from '@/lib/sim/terrain-editor';
import { TERRAIN_MAX_LEVEL, TEST_MAP_LIMITS, OBJECT_SCALE_MIN, OBJECT_SCALE_MAX, TREE_SPRITE_OPTS, ROCK_SPRITE_OPTS, type GroundCover, type TestMapEntryDir } from '@/lib/sim/test-map';
import type { EditorSaveState } from '../editor-ops';
import styles from './editor-workspace.module.css';
export interface EditorOverlayProps {
  rotateCamera: (direction: -1 | 1) => void;
  editorRef: RefObject<EditorDraft | null>;
  syncEditorView: () => void;
  editorView: EditorDraft;
  setEditorTool: (t: EditorTool) => void;
  editorEntryDir: TestMapEntryDir;
  setEditorEntryDir: (d: TestMapEntryDir) => void;
  editorPlace: EditorPlace | null;
  patchEditorPlace: (p: Partial<EditorPlace>) => void;
  confirmEditorPlace: () => void;
  cancelEditorPlace: () => void;
  resizeEditorWorld: (cols: number, rows: number) => void;
  undoEditor: (steps?:number) => void;
  redoEditor: (steps?:number) => void;
  resetEditor: () => void;
  mergeEditorZones: () => void;
  toggleEditorSel: (id: string) => void;
  renameEditorZone: (id: string, name: string) => void;
  deleteEditorZone: (id: string) => void;
  saveEditorMap: () => void;
  /** Прогресс сохранения: фазы кодирования/отправки/подтверждения с секундами. */
  editorSave: EditorSaveState | null;
  editorCover: GroundCover;
  setEditorCover: (c: GroundCover) => void;
  editorMsg: string | null;
  closeEditor: () => void;
}

type Category='surface'|'objects'|'terrain'|'zones'|'world'|'history';
const sections:{id:Category;label:string;icon:string}[]=[
  {id:'surface',label:'Поверхность',icon:'brush'},
  {id:'objects',label:'Объекты',icon:'tree'},
  {id:'terrain',label:'Высоты',icon:'layers'},
  {id:'zones',label:'Зоны',icon:'zone'},
  {id:'world',label:'Мир',icon:'settings'},
  {id:'history',label:'История',icon:'history'},
];
const tools:{id:EditorTool;label:string;icon:string;category:Category;key?:string}[]=[
  {id:'cursor',label:'Курсор',icon:'cursor',category:'objects'},
  {id:'paint',label:'Кисть',icon:'brush',category:'surface',key:'B'},
  {id:'fill',label:'Заливка',icon:'fill',category:'surface'},
  {id:'select',label:'Выделение',icon:'zone',category:'zones'},
  {id:'pan',label:'Перемещение',icon:'move',category:'world',key:'Пробел'},
  {id:'tree',label:'Дерево',icon:'tree',category:'objects'},
  {id:'stone',label:'Камень',icon:'rock',category:'objects'},
  {id:'height',label:'Блок',icon:'layers',category:'terrain'},
  {id:'raise',label:'Насыпать',icon:'up',category:'terrain'},
  {id:'lower',label:'Срыть',icon:'down',category:'terrain'},
  {id:'flat',label:'Ровно',icon:'flat',category:'terrain'},
  {id:'cells',label:'Боевая область',icon:'zone',category:'zones'},
  {id:'green',label:'Лужайка',icon:'tree',category:'zones'},
  {id:'entry',label:'Вход',icon:'enter',category:'zones'},
  {id:'spawn',label:'Точка появления',icon:'pin',category:'zones'},
];
const paths:Record<string,string>={
 cursor:'M5 3l14 10-7 1-3 7z',brush:'M15 3l6 6-10 10-6 1 1-6z M13 5l6 6',
 eraser:'M14 3l7 7-10 10H6l-4-4z M7 11l7 7 M11 20h10',fill:'M10 3l10 10-8 8-10-10z M4 10h13 M20 16q4 6 0 6q-4 0 0-6',
 move:'M12 2v20 M2 12h20 M8 6l4-4 4 4 M8 18l4 4 4-4 M6 8l-4 4 4 4 M18 8l4 4-4 4',
 zone:'M3 8V3h5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5',
 undo:'M8 4L3 9l5 5 M3 9h10a7 7 0 010 14',redo:'M16 4l5 5-5 5 M21 9H11a7 7 0 000 14',
 tree:'M12 2l7 8h-4l6 7H3l6-7H5z M12 17v5',rock:'M3 18l3-11 7-3 7 7 1 8-9 2z M6 7l6 7 8-3 M12 14v7',
 layers:'M12 2l10 6-10 6L2 8z M2 13l10 6 10-6 M2 18l10 6 10-6',
 settings:'M12 8a4 4 0 100 8 4 4 0 000-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
 history:'M3 12a9 9 0 119 9 M3 4v8h8 M12 7v6l4 2',save:'M3 3h15l3 3v15H3z M7 3v6h10V3 M7 21v-8h10v8',
 search:'M10 3a7 7 0 100 14 7 7 0 000-14 M15 15l6 6',close:'M5 5l14 14 M19 5L5 19',
 grid:'M3 3h18v18H3z M3 9h18 M3 15h18 M9 3v18 M15 3v18',
 up:'M12 21V3 M5 10l7-7 7 7',down:'M12 3v18 M5 14l7 7 7-7',flat:'M3 12h18',
 enter:'M10 3h11v18H10 M2 12h13 M10 7l5 5-5 5',pin:'M12 22S3 13 3 9a9 9 0 1118 0c0 4-9 13-9 13z M12 6v5',
};
function Icon({name}:{name:string}){return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={paths[name]??paths.zone}/></svg>;}
function NumberField({label,value,min,max,step=1,onChange}:{label:string;value:number;min:number;max:number;step?:number;onChange:(n:number)=>void}){
 return <label className={styles.field}><span>{label}</span><input type="number" aria-label={label} value={value} min={min} max={max} step={step} onChange={e=>{if(e.target.value!=='')onChange(Math.min(max,Math.max(min,Number(e.target.value))));}}/></label>;
}

export function EditorOverlay(p:EditorOverlayProps){
 const d=p.editorView;
 const [section,setSection]=useState<Category>('surface');
 const [collapsed,setCollapsed]=useState(false);
 const [query,setQuery]=useState('');
 const [filter,setFilter]=useState('all');
 const [world,setWorld]=useState({cols:d.cols,rows:d.rows});
 const [elapsed,setElapsed]=useState(0);
 useEffect(()=>{if(window.matchMedia('(max-width:800px)').matches)setCollapsed(true);},[]);
 const update=(patch:Partial<EditorDraft>)=>{if(p.editorRef.current)Object.assign(p.editorRef.current,patch);p.syncEditorView();};
 const choose=(tool:EditorTool)=>{
   p.setEditorTool(tool);
   setSection(tools.find(t=>t.id===tool)?.category??'surface');
   setCollapsed(false);
 };
 const erase=()=>{choose('paint');update({pmat:'erase'});};
 useEffect(()=>setWorld({cols:d.cols,rows:d.rows}),[d.cols,d.rows]);
 useEffect(()=>{
   if(!p.editorSave)return;
   const timer=setInterval(()=>setElapsed(Math.round((Date.now()-p.editorSave!.t0)/1000)),300);
   return ()=>clearInterval(timer);
 },[p.editorSave]);
 useEffect(()=>{
   const typing=(target:EventTarget|null)=>target instanceof HTMLElement&&!!target.closest('input,textarea,select,[contenteditable="true"]');
   const down=(event:KeyboardEvent)=>{
     if(typing(event.target)||event.altKey)return;
     if((event.ctrlKey||event.metaKey)&&event.code==='KeyZ'){
       event.preventDefault();event.stopImmediatePropagation();event.shiftKey?p.redoEditor():p.undoEditor();return;
     }
     if((event.ctrlKey||event.metaKey)&&event.code==='KeyY'){event.preventDefault();p.redoEditor();return;}
     if(event.ctrlKey||event.metaKey)return;
     if(event.code==='Space'){
       event.preventDefault();event.stopImmediatePropagation();if(p.editorRef.current)p.editorRef.current.spacePan=true;return;
     }
     if(event.repeat)return;
     if(event.code==='KeyB'){event.preventDefault();event.stopImmediatePropagation();choose('paint');if(p.editorRef.current?.pmat==='erase')update({pmat:'grass-1'});}
     if(event.code==='KeyE'){event.preventDefault();event.stopImmediatePropagation();erase();}
   };
   const up=(event:KeyboardEvent)=>{if(event.code==='Space'&&p.editorRef.current)p.editorRef.current.spacePan=false;};
   const blur=()=>{if(p.editorRef.current){p.editorRef.current.spacePan=false;p.editorRef.current.panDrag=undefined;}};
   window.addEventListener('keydown',down,true);window.addEventListener('keyup',up,true);window.addEventListener('blur',blur);
   return ()=>{window.removeEventListener('keydown',down,true);window.removeEventListener('keyup',up,true);window.removeEventListener('blur',blur);};
 });
 const current=tools.find(t=>t.id===d.tool);
 const toolButton=(tool:typeof tools[number])=><button key={tool.id} type="button" className={styles.tool} aria-label={tool.label} title={`${tool.label}${tool.key?` · ${tool.key}`:''}`} aria-pressed={d.tool===tool.id&&(tool.id!=='paint'||d.pmat!=='erase')} onClick={()=>choose(tool.id)}><Icon name={tool.icon}/><span>{tool.label}</span></button>;
 const material=(id:string,label:string)=>{choose('paint');update({pmat:id});};
 const mats=PAINT_MATS.filter(m=>m.id!=='erase').filter(m=>filter==='all'||(filter==='stone'?/stone|rock|плит|кам|скал|кирп|пес/i.test(m.id+' '+m.label):!/stone|rock|плит|кам|скал|кирп|пес/i.test(m.id+' '+m.label)));
 const q=query.trim().toLowerCase();
 const searchResults=[...tools.map(t=>({id:t.id,label:t.label,kind:'Инструмент',run:()=>choose(t.id)})),...PAINT_MATS.map(m=>({id:'mat-'+m.id,label:m.label,kind:'Материал',run:()=>material(m.id,m.label)})),...TREE_SPRITE_OPTS.map(o=>({id:o.id,label:o.label,kind:'Объект',run:()=>{choose('tree');p.patchEditorPlace({kind:'tree',spr:o.id,pickId:null,anchored:false});}})),...ROCK_SPRITE_OPTS.map(o=>({id:o.id,label:o.label,kind:'Объект',run:()=>{choose('stone');p.patchEditorPlace({kind:'stone',spr:o.id,pickId:null,anchored:false});}}))].filter(r=>r.label.toLowerCase().includes(q));
 return <div className={styles.workspace} data-collapsed={collapsed} aria-label="Редактор локации">
   <header className={styles.header}>
     <div className={styles.brand}><img className={styles.paw} src="/lapka.svg" alt=""/><strong>Редактор локации</strong><span className={styles.dimensions}>{d.cols} × {d.rows}</span><span className={styles.editorWeather} title="Ясный свет для строительства; погода комнаты сохраняется">☀ Солнечно</span></div>
     <div className={styles.headerActions}>
       <span className={styles.state} data-dirty={d.dirty}><i/>{d.dirty?'Есть изменения':'Всё сохранено'}</span>
       <button type="button" aria-label={collapsed?'Развернуть панели':'Свернуть панели'} title="Больше места для карты" onClick={()=>setCollapsed(!collapsed)}>{collapsed?'▸':'◂'}</button>
       <button type="button" aria-label="Закрыть редактор" onClick={p.closeEditor}><Icon name="close"/></button>
     </div>
   </header>
   <nav className={styles.rail} aria-label="Разделы редактора">
     {sections.map(s=><button type="button" key={s.id} aria-label={s.label} aria-pressed={section===s.id&&!collapsed} onClick={()=>{setSection(s.id);setCollapsed(false);setQuery('');}}><Icon name={s.icon}/><span>{s.label}</span></button>)}
   </nav>
   <aside className={styles.inspector} aria-label="Параметры инструмента">
     <div className={styles.inspectorHeading}><div><small>МАСТЕРСКАЯ</small><h2>{sections.find(s=>s.id===section)?.label}</h2></div><button type="button" aria-label="Свернуть параметры" onClick={()=>setCollapsed(true)}>‹</button></div>
     <label className={styles.search}><Icon name="search"/><input type="search" aria-label="Поиск инструментов" placeholder="Найти инструмент или объект" value={query} onChange={e=>setQuery(e.target.value)}/><kbd>⌕</kbd></label>
     <div className={styles.controls}>
       {q?<div className={styles.results}>{searchResults.length?searchResults.map(r=><button type="button" key={r.id} onClick={()=>{r.run();setQuery('');}}><span>{r.label}</span><small>{r.kind}</small></button>):<p className={styles.hint}>Ничего не найдено. Попробуйте «трава» или «камень».</p>}</div>:<>
       {section==='surface'&&<>
         <div className={styles.segment}>{tools.filter(t=>['paint','fill'].includes(t.id)).map(toolButton)}<button type="button" aria-label="Ластик" aria-pressed={d.tool==='paint'&&d.pmat==='erase'} onClick={erase}><Icon name="eraser"/>Ластик</button></div>
         <h3>Форма и размер</h3>
         <div className={styles.presets}>
           <button type="button" aria-pressed={d.pshape==='round'} onClick={()=>update({pshape:'round'})}><span>◯</span>Круг</button>
           {[[150,100],[300,200],[600,400]].map(([w,h])=><button type="button" key={w} aria-pressed={d.pshape==='rect'&&d.pwidth===w} onClick={()=>update({pshape:'rect',pwidth:w,pheight:h})}><Icon name="zone"/>{w}×{h}</button>)}
         </div>
         {d.pshape==='round'?<><label className={styles.range}>Диаметр <b>{d.psize} px</b><input aria-label="Размер кисти" type="range" min="4" max="600" value={d.psize} onChange={e=>update({psize:Number(e.target.value)})}/></label></>:<div className={styles.two}><NumberField label="Ширина кисти, px" value={d.pwidth??150} min={1} max={2000} onChange={pwidth=>update({pwidth,pshape:'rect'})}/><NumberField label="Высота кисти, px" value={d.pheight??100} min={1} max={2000} onChange={pheight=>update({pheight,pshape:'rect'})}/></div>}
         <h3>Материал <span>{PAINT_MATS.find(m=>m.id===d.pmat)?.label}</span></h3>
         <div className={styles.filters}>{[['all','Все'],['nature','Природа'],['stone','Камень']].map(([id,name])=><button type="button" key={id} aria-pressed={filter===id} onClick={()=>setFilter(id)}>{name}</button>)}</div>
         <div className={styles.materials}>{mats.map(m=><button type="button" key={m.id} title={m.label} aria-pressed={d.pmat===m.id} onClick={()=>material(m.id,m.label)}><span className={styles.swatch} style={{backgroundImage:m.id==='dirt'?'linear-gradient(135deg,#776044,#493a2b)':`url(/tex/${m.id}.png)`}}/><span>{m.label}</span></button>)}</div>
         <p className={styles.hint}>Свободный мазок без привязки к клеткам. ПКМ стирает. Заливка заменяет материал в связной области.</p>
       </>}
       {section==='objects'&&<>
         <div className={styles.segment}>{tools.filter(t=>['cursor','tree','stone'].includes(t.id)).map(toolButton)}</div>
         <h3>{d.tool==='tree'?'Деревья':'Камни'}</h3>
         <div className={styles.objects}>{(d.tool==='tree'?TREE_SPRITE_OPTS:ROCK_SPRITE_OPTS).map(o=><button type="button" key={o.id} aria-pressed={p.editorPlace?.spr===o.id} onClick={()=>{choose(d.tool==='tree'?'tree':'stone');p.patchEditorPlace({kind:d.tool==='tree'?'tree':'stone',spr:o.id,anchored:false,pickId:null});}}><img src={`/tex/${o.id}.png`} alt=""/><span>{o.label}</span></button>)}</div>
         {p.editorPlace&&<>
           <div className={styles.two}><NumberField label="Масштаб" min={OBJECT_SCALE_MIN} max={OBJECT_SCALE_MAX} step={.1} value={p.editorPlace.s} onChange={s=>p.patchEditorPlace({s})}/><NumberField label="Поворот, °" min={0} max={359} step={15} value={p.editorPlace.rot} onChange={rot=>p.patchEditorPlace({rot})}/></div>
           <button type="button" className={styles.wide} aria-pressed={p.editorPlace.mir===1} onClick={()=>p.patchEditorPlace({mir:p.editorPlace?.mir===1?0:1})}>⇋ Отразить по горизонтали</button>
           <Button className={styles.primary} onClick={p.confirmEditorPlace}>✓ Поставить объект</Button><button type="button" className={styles.wide} onClick={p.cancelEditorPlace}>Снять выбор</button>
         </>}
         <p className={styles.hint}>Объекты размещаются свободно. Клик фиксирует позицию, затем «Поставить объект». Курсор выбирает стоящий объект для правки.</p>
       </>}
       {section==='terrain'&&<>
         <div className={styles.toolGrid}>{tools.filter(t=>t.category==='terrain').map(toolButton)}</div>
         <h3>Размер блока</h3>
         <div className={styles.two}>{([['width','Ширина блока',.1,d.cols],['depth','Длина блока',.1,d.rows],['level','Высота блока',0,TERRAIN_MAX_LEVEL]] as const).map(([key,label,min,max])=><NumberField key={key} label={label} min={min} max={max} step={.1} value={clampBrush(d.elevBrush,d.cols,d.rows)[key]} onChange={value=>update({elevBrush:{...clampBrush(d.elevBrush,d.cols,d.rows),[key]:value}})}/>)}</div>
         <button type="button" className={styles.wide} aria-pressed={!!d.elevFree} onClick={()=>{choose('height');update({elevFree:!d.elevFree});}}>Свободная установка: {d.elevFree?'ВКЛ':'ВЫКЛ'}</button>
         {d.elevFree&&<label className={styles.field}>Привязка к блокам<select aria-label="Привязка к блокам" value={d.elevSnap??'level'} onChange={e=>update({elevSnap:e.target.value as 'off'|'level'|'all'})}><option value="off">Без магнита</option><option value="level">Такая же высота</option><option value="all">Любая высота</option></select></label>}
         <label className={styles.check}><input type="checkbox" checked={d.showGrid??false} onChange={e=>update({showGrid:e.target.checked})}/>Показывать сетку</label>
         <p className={styles.hint}>Высоты от 0 до 20, шаг 0,1. Золотой контур — точное соединение магнитом. Нулевая высота срезает блок.</p>
       </>}
       {section==='zones'&&<>
         <div className={styles.toolGrid}>{tools.filter(t=>t.category==='zones').map(toolButton)}</div>
         {d.tool==='entry'&&<label className={styles.field}>Направление входа<select aria-label="Направление входа" value={p.editorEntryDir} onChange={e=>p.setEditorEntryDir(e.target.value as TestMapEntryDir)}>{[['left','Влево'],['right','Вправо'],['up','Вверх'],['down','Вниз']].map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>}
         <h3>Зоны локации <span>{d.zones.length}</span></h3>
         <div className={styles.zoneList}>{d.zones.map(z=><div key={z.id} className={styles.zone} data-selected={d.sel.includes(z.id)}><input type="checkbox" aria-label={`Выбрать зону ${z.name}`} checked={d.sel.includes(z.id)} onChange={()=>p.toggleEditorSel(z.id)}/><i data-kind={z.kind}/><input aria-label={`Имя зоны ${z.name}`} defaultValue={z.name} key={z.id+z.name} onBlur={e=>{if(e.target.value!==z.name)p.renameEditorZone(z.id,e.target.value);}}/><small>{z.c1-z.c0+1}×{z.r1-z.r0+1}</small><button type="button" aria-label={`Удалить зону ${z.name}`} onClick={()=>p.deleteEditorZone(z.id)}>×</button></div>)}</div>
         <button type="button" className={styles.wide} disabled={d.sel.length<2} onClick={p.mergeEditorZones}>Объединить выбранные ({d.sel.length})</button>
         <p className={styles.hint}>Тяните область на карте. Выделение переносит участок вместе с рисунком, объектами и высотой.</p>
       </>}
       {section==='world'&&<>
         <h3>Размер локации</h3>
         <div className={styles.two}><NumberField label="Ширина мира" value={world.cols} min={TEST_MAP_LIMITS.colsMin} max={TEST_MAP_LIMITS.colsMax} onChange={cols=>setWorld({...world,cols})}/><NumberField label="Длина мира" value={world.rows} min={TEST_MAP_LIMITS.rowsMin} max={TEST_MAP_LIMITS.rowsMax} onChange={rows=>setWorld({...world,rows})}/></div>
         <Button variant="outline" className={styles.wide} onClick={()=>p.resizeEditorWorld(world.cols,world.rows)}>Применить размер</Button>
         <h3>Обзор</h3><div className={styles.two}><button type="button" onClick={()=>p.rotateCamera(-1)}>↶ Повернуть влево</button><button type="button" onClick={()=>p.rotateCamera(1)}>↷ Повернуть вправо</button></div>
         <label className={styles.check}><input type="checkbox" checked={d.showGrid??false} onChange={e=>update({showGrid:e.target.checked})}/>Сетка высот</label>
         <button type="button" className={styles.wide} onClick={()=>update({pan:{x:0,y:0,reset:true}})}>Вернуть карту в центр</button>
         <details className={styles.details}><summary>Восстановление</summary><p className={styles.hint}>Вернуть последнюю сохранённую карту. Действие можно отменить.</p><button type="button" onClick={p.resetEditor}>Вернуть сохранённую локацию</button></details>
         <p className={styles.hint}>Колесо — масштаб. Пробел + перетаскивание — перемещение карты. [ и ] — поворот камеры.</p>
       </>}
       {section==='history'&&<>
         <h3>История изменений <span>{d.undo.length}/40</span></h3>
         <div className={styles.history}>
           <button type="button" disabled={!d.undo.length} onClick={()=>p.undoEditor(d.undo.length)}><span>◯</span>Начальное состояние</button>
           {d.undo.map((entry,i)=><button type="button" key={i} aria-current={i===d.undo.length-1?'step':undefined} onClick={()=>p.undoEditor(d.undo.length-i-1)}><span>{i+1}</span>{entry.label??'Изменение карты'}{i===d.undo.length-1&&<small>Сейчас</small>}</button>)}
           {[...(d.redo??[])].reverse().map((entry,i)=><button type="button" className={styles.future} key={'redo'+i} onClick={()=>p.redoEditor(i+1)}><span>↷</span>{entry.label??'Изменение карты'}</button>)}
         </div>
         <p className={styles.hint}>Каждый мазок — одно действие. Новый шаг после отмены заменяет ветку повтора. Снимки рисунка хранятся в памяти текущего редактора.</p>
       </>}
       </>}
     </div>
     <div className={styles.inspectorFoot}><kbd>B</kbd> кисть <kbd>E</kbd> ластик <kbd>Ctrl Z</kbd> отмена</div>
   </aside>
   <div className={styles.toolbar} role="toolbar" aria-label="Быстрые инструменты">
     <div className={styles.segment}>{tools.filter(t=>['cursor','paint'].includes(t.id)).map(toolButton)}<button type="button" aria-label="Ластик" title="Ластик · E" aria-pressed={d.tool==='paint'&&d.pmat==='erase'} onClick={erase}><Icon name="eraser"/><span>Ластик</span></button>{tools.filter(t=>['fill','select','pan'].includes(t.id)).map(toolButton)}</div>
     <div className={styles.toolbarEnd}><button type="button" aria-label="Отменить" title="Отменить · Ctrl+Z" disabled={!d.undo.length} onClick={()=>p.undoEditor()}><Icon name="undo"/></button><button type="button" aria-label="Повторить" title="Повторить · Ctrl+Shift+Z" disabled={!d.redo?.length} onClick={()=>p.redoEditor()}><Icon name="redo"/></button><span className={styles.separator}/><button type="button" aria-label="Повернуть камеру влево" onClick={()=>p.rotateCamera(-1)}>↶</button><button type="button" aria-label="Повернуть камеру вправо" onClick={()=>p.rotateCamera(1)}>↷</button></div>
   </div>
   <footer className={styles.footer}>
     <div className={styles.selection}><small>ВЫБРАНО</small>{d.sel.length?d.zones.filter(z=>d.sel.includes(z.id)).slice(0,3).map(z=><button type="button" key={z.id} onClick={()=>{setSection('zones');setCollapsed(false);}}><i data-kind={z.kind}/>{z.name}</button>):<span>{current?.label??'Кисть'}{d.tool==='paint'?` · ${PAINT_MATS.find(m=>m.id===d.pmat)?.label??''}`:''}</span>}</div>
     <div className={styles.saveArea}><div role="status" className={styles.saveStatus}>{p.editorSave?<><span className={styles.spinner}/>{p.editorSave.phase==='encode'?'Подготовка рисунка':p.editorSave.phase==='send'?'Отправка':'Ожидание сервера'} · {elapsed} с</>:p.editorMsg??(d.dirty?'Изменения не сохранены':'Карта сохранена на сервере')}</div><Button className={styles.primary} disabled={!!p.editorSave} onClick={p.saveEditorMap}><Icon name="save"/>Сохранить локацию</Button></div>
   </footer>
 </div>;
}

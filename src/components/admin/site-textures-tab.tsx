'use client';
import { useEffect, useState, type CSSProperties } from 'react';
import { Button, Input } from '@/components/ui';
import { DEFAULT_SITE_DESIGN, designRequest, designVariables, siteAsset, uploadDesignAsset, type DesignSlot, type SiteDesign } from '@/lib/site-design';
import s from './site-textures.module.css';
const ASSETS:{key:DesignSlot;label:string;hint:string}[]=[
 {key:'frame',label:'Внешняя рамка',hint:'PNG с прозрачным центром. Углы сохраняются, края растягиваются. Настройте отступ среза ниже.'},
 {key:'divider',label:'Горизонтальный разделитель',hint:'Широкое изображение с прозрачным фоном. Пропорции сохраняются.'},
 {key:'background',label:'Фон страницы',hint:'Изображение заполняет фон страницы.'},
 {key:'button',label:'Фон кнопок',hint:'Текстура для кнопок сайта.'},
 {key:'fontFile',label:'Свой шрифт',hint:'Файл WOFF2 с поддержкой кириллицы.'},
];
const RANGES={textSize:['Основной текст',10,24],headingSize:['Заголовки блоков',14,36],titleSize:['Крупные заголовки',20,56],frameSlice:['Срез рамки (пиксели исходника)',4,150],frameWidth:['Толщина рамки',8,60],dividerHeight:['Высота разделителя',1,80],panelOpacity:['Непрозрачность блоков (%)',30,100]} as const;
const COLORS={textColor:'Основной текст',mutedColor:'Второстепенный текст',accentColor:'Акценты',panelColor:'Подложка блоков',backgroundColor:'Фон страницы'} as const;
const LABELS={userInfo:'Информация о пользователе',character:'Персонаж',statistics:'Статистика',friends:'Друзья',activity:'Последние действия'} as const;
const errorText=(error:unknown)=>{const code=error instanceof Error?error.message:'';return ({auth_required:'Войдите в аккаунт.',forbidden:'Нет права «Текстуры и оформление сайта».',invalid_settings:'Проверьте значения настроек.',invalid_file:'Файл не подходит. Для изображений используйте PNG, JPEG, WebP или GIF, для шрифта — WOFF2.',too_large:'Размер файла превышает 2 МБ.'} as Record<string,string>)[code] || 'Не удалось выполнить действие. Проверьте соединение и попробуйте снова.';};
export function SiteTexturesTab(){
 const [draft,setDraft]=useState<SiteDesign|null>(null),[saved,setSaved]=useState<SiteDesign|null>(null),[busy,setBusy]=useState(false),[note,setNote]=useState(''),[error,setError]=useState(''),[preview,setPreview]=useState(false);
 async function load(){setBusy(true);setError('');try{const value=await designRequest();setSaved(value);setDraft(value);}catch(e){setError(errorText(e));}finally{setBusy(false);}}
 useEffect(()=>{void load();return()=>{window.dispatchEvent(new CustomEvent('site-design-preview',{detail:null}));};},[]);
 useEffect(()=>{window.dispatchEvent(new CustomEvent('site-design-preview',{detail:preview?draft:null}));},[preview,draft]);
 useEffect(()=>{
  if(!draft?.fontFile)return;
  let active=true;const font=new FontFace('SiteDraft',`url("${siteAsset(draft.fontFile)}")`);
  void font.load().then(value=>{if(active)document.fonts.add(value);}).catch(()=>setError('Не удалось прочитать шрифт. Выберите корректный WOFF2.'));
  return()=>{active=false;document.fonts.delete(font);};
 },[draft?.fontFile]);
 const dirty=JSON.stringify(draft)!==JSON.stringify(saved);
 function update<K extends keyof SiteDesign>(key:K,value:SiteDesign[K]){setDraft(old=>old?{...old,[key]:value}:old);setNote('');}
 async function upload(slot:DesignSlot,file?:File){if(!file)return;if(file.size>2*1024*1024){setError('Размер файла превышает 2 МБ.');return;}setBusy(true);setError('');try{const url=await uploadDesignAsset(slot,file);update(slot,url);setNote('Файл загружен. Нажмите «Сохранить оформление», чтобы применить его на сайте.');}catch(e){setError(errorText(e));}finally{setBusy(false);}}
 async function save(){if(!draft)return;setBusy(true);setError('');try{const value=await designRequest('POST',draft);setDraft(value);setSaved(value);setPreview(false);window.dispatchEvent(new CustomEvent('site-design-saved',{detail:value}));setNote('Оформление сохранено. Оно применится у посетителей при открытии страницы или в течение минуты.');}catch(e){setError(errorText(e));}finally{setBusy(false);}}
 if(!draft)return <section className={s.panel}><p role="status">{busy?'Загружаем оформление…':error}</p>{!busy?<Button onClick={()=>void load()}>Повторить</Button>:null}</section>;
 return <div className={s.layout}>
  <form className={s.form} onSubmit={event=>{event.preventDefault();void save();}}>
   <section className={s.panel}><h2>Сайтовые текстуры</h2><p>Оформление страниц сайта. Игровые текстуры поля меняются в соседней вкладке.</p>
    <div className={s.assets}>{ASSETS.map(({key,label,hint})=><div key={key} className={s.asset}>
     <strong>{label}</strong><p>{hint}</p>
     {draft[key] && key!=='fontFile'?<img src={siteAsset(draft[key])} alt={`Текущий ресурс: ${label}`} className={key==='frame'?s.frameThumb:s.thumb}/>:<div className={s.empty}>{draft[key]?'Свой шрифт загружен':'Стандартное оформление'}</div>}
     <label className={s.file}>Заменить файл<Input type="file" accept={key==='fontFile'?'.woff2':'.png,.jpg,.jpeg,.webp,.gif'} disabled={busy} onChange={event=>{void upload(key,event.target.files?.[0]);event.target.value='';}}/></label>
     <Button type="button" variant="outline" disabled={busy || draft[key]===DEFAULT_SITE_DESIGN[key]} onClick={()=>update(key,DEFAULT_SITE_DESIGN[key])}>Вернуть исходный ресурс</Button>
    </div>)}</div>
   </section>
   <section className={s.panel}><h2>Текст и размеры</h2><label className={s.field}>Шрифт<select disabled={busy || !!draft.fontFile} value={draft.font} onChange={event=>update('font',event.target.value)}><option value="inter">Inter — основной</option><option value="serif">Georgia — с засечками</option><option value="sans">Arial — без засечек</option><option value="mono">Моноширинный</option></select></label>
    {draft.fontFile?<p>Используется загруженный шрифт. Верните исходный ресурс, чтобы выбрать системный.</p>:null}
    <div className={s.fields}>{(Object.keys(RANGES) as (keyof typeof RANGES)[]).map(key=>{const [label,min,max]=RANGES[key];return <label className={s.field} key={key}>{label}<Input type="number" min={min} max={max} step={1} required value={draft[key]} disabled={busy} onChange={event=>update(key,Number(event.target.value))}/></label>;})}</div>
   </section>
   <section className={s.panel}><h2>Цвета</h2><div className={s.fields}>{(Object.keys(COLORS) as (keyof typeof COLORS)[]).map(key=><label className={s.field} key={key}>{COLORS[key]}<Input type="color" value={draft[key]} disabled={busy} onChange={event=>update(key,event.target.value)}/></label>)}</div></section>
   <section className={s.panel}><h2>Заголовки профиля</h2><div className={s.fields}>{(Object.keys(LABELS) as (keyof typeof LABELS)[]).map(key=><label className={s.field} key={key}>{LABELS[key]}<Input required maxLength={64} value={draft.labels[key]} disabled={busy} onChange={event=>update('labels',{...draft.labels,[key]:event.target.value})}/></label>)}</div></section>
   <div className={s.actions}><Button type="submit" disabled={busy || !dirty}>{busy?'Подождите…':'Сохранить оформление'}</Button><Button type="button" variant="outline" disabled={busy || !dirty} onClick={()=>{setDraft(saved);setPreview(false);setNote('');setError('');}}>Отменить изменения</Button><Button type="button" variant="outline" disabled={busy} onClick={()=>{setDraft(structuredClone(DEFAULT_SITE_DESIGN));setNote('Исходное оформление выбрано. Для применения нажмите «Сохранить оформление».');}}>Сбросить всё к исходному</Button></div>
   <p role="status">{note || (dirty?'Есть несохранённые изменения.':'Все изменения сохранены.')}</p>{error?<p role="alert" className={s.error}>{error}</p>:null}
  </form>
  <aside className={s.preview} style={{...designVariables(draft),...(draft.fontFile?{'--site-font':'SiteDraft, sans-serif'}:{})} as CSSProperties}>
   <h2>Предпросмотр</h2><label className={s.toggle}><input type="checkbox" checked={preview} onChange={event=>setPreview(event.target.checked)}/>Показать на текущей странице</label><p>Посетители увидят изменения после сохранения.</p>
   <div className={s.sample}><h1>Элизия</h1><h2>{draft.labels.userInfo}</h2><div className={s.divider}/><p>Так выглядит основной текст сайта.</p><small>Второстепенная подпись · 7 сентября</small><div className={s.divider}/><button type="button">Пример кнопки</button></div>
  </aside>
 </div>;
}

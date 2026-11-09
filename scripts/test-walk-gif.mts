// @ts-nocheck
// Юнит-контракт GIF-анимации ходьбы (gif-walk.ts, пробная — test1):
// математика кадров без браузера (узлы-заглушки вместо канвасов) + грейсфолбэк
// декодера + целостность каталога (WALK_GIF_SRC ↔ SPRITES, test1-webp снят).
import {
  decodeGifFrames,
  loadWalkGif,
  walkFrameAt,
  walkPhaseOf,
  type WalkGif,
} from "../src/lib/sim/gif-walk.ts";
import { SPRITES, SPRITE_GROUPS, WALK_GIF_SRC } from "../src/lib/sim/settings.ts";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** Кадр-заглушка: в node канвасов нет — walkFrameAt их не трогает, только выбирает. */
function fakeFrame(tag: string): HTMLCanvasElement {
  return { __tag: tag } as unknown as HTMLCanvasElement;
}

function fakeWalk(durations: number[], tags: string[]): WalkGif {
  return {
    frames: tags.map(fakeFrame),
    durations,
    total: durations.reduce((a, b) => a + b, 0),
  };
}

// Равные кадры 3×200: границы попадают в следующий кадр ровно на тике.
{
  const walk = fakeWalk([200, 200, 200], ["f0", "f1", "f2"]);
  assert(walkFrameAt(walk, 0, 0) === walk.frames[0], "t=0 → первый кадр");
  assert(walkFrameAt(walk, 199, 0) === walk.frames[0], "t=199 → первый кадр");
  assert(walkFrameAt(walk, 200, 0) === walk.frames[1], "t=200 → второй кадр");
  assert(walkFrameAt(walk, 599, 0) === walk.frames[2], "t=599 → третий кадр");
  assert(walkFrameAt(walk, 600, 0) === walk.frames[0], "t=600 → цикл замкнулся");
  assert(walkFrameAt(walk, 1500, 0) === walk.frames[1], "t=1500 → второй кадр (1500%600=300)");
  // Отрицательное время (старые часы не бывают, но контракт — без NaN/undefined).
  assert(walkFrameAt(walk, -1, 0) === walk.frames[2], "t=-1 → последний кадр (модульная арифметика)");
}

// Неравные кадры [50, 450, 100]: границы по кумулятивным длительностям.
{
  const walk = fakeWalk([50, 450, 100], ["a", "b", "c"]);
  assert(walkFrameAt(walk, 49, 0) === walk.frames[0], "t=49 → кадр 50 мс");
  assert(walkFrameAt(walk, 50, 0) === walk.frames[1], "t=50 → длинный кадр");
  assert(walkFrameAt(walk, 499, 0) === walk.frames[1], "t=499 → всё ещё длинный кадр");
  assert(walkFrameAt(walk, 500, 0) === walk.frames[2], "t=500 → последний кадр");
}

// Фаза кота: детерминирована, различает разные id, кладёт цикл в другое место.
{
  assert(walkPhaseOf("main") === walkPhaseOf("main"), "фаза детерминирована");
  assert(walkPhaseOf("main") !== walkPhaseOf("p1"), "разные коты — разные фазы");
  const walk = fakeWalk([200, 200, 200], ["f0", "f1", "f2"]);
  const phase = walkPhaseOf("p7");
  // Фаза — чистый сдвиг таймлайна: кадр «сейчас с фазой P» = кадр «через P мс без фазы».
  assert(walkFrameAt(walk, 0, phase) === walkFrameAt(walk, phase % walk.total, 0), "фаза — сдвиг таймлайна, не отдельный кадр");
}

// Грейсфолбэк: в node нет ImageDecoder — decodeGifFrames честно бросает,
// загрузчик (useWalkGifCache) ловит и оставляет статичный PNG.
{
  let message = "";
  try {
    await decodeGifFrames(new ArrayBuffer(8));
    assert(false, "decodeGifFrames должен бросать без ImageDecoder");
  } catch (e) {
    message = String((e as Error)?.message || e);
  }
  assert(/ImageDecoder/.test(message), `отказ ссылается на ImageDecoder: ${message}`);
}

// Каталог: WALK_GIF_SRC ссылается только на живые спрайты; test1-webp снят
// отовсюду (карусель + группы), а gif-файл числится ровно за test1.
{
  const ids = new Set(SPRITES.map((s) => s.id));
  for (const [id] of Object.entries(WALK_GIF_SRC)) {
    assert(ids.has(id), `WALK_GIF_SRC: ${id} есть в SPRITES`);
  }
  assert(WALK_GIF_SRC.test1 === "/sprites/test1-walk.gif?v=walk-1", "test1 → /sprites/test1-walk.gif?v=walk-1");
  assert(WALK_GIF_SRC["test1-png"]===WALK_GIF_SRC.test1,"PNG 600 shares the test1 walk animation");
  assert(!ids.has("test1-webp"), "test1-webp снят из SPRITES");
  assert(!SPRITE_GROUPS.some((g) => g.spriteIds.includes("test1-webp")), "test1-webp снят из групп");
  const group = SPRITE_GROUPS.find((g) => g.id === "test1");
  assert(!!group && group.spriteIds.join(",") === "test1,test1-png", "группа test1: [test1, test1-png]");
}

console.log("OK test-walk-gif: кадры/фазы/фолбэк/каталог");

// No WebCodecs: builtin PNG frames retain the exact GIF timing and dimensions.
{
 const oldImage=globalThis.Image,oldDocument=globalThis.document;
 const paths=[];
 try{
  globalThis.Image=class{naturalWidth=215;naturalHeight=100;set src(path){paths.push(path);queueMicrotask(()=>this.onload());}};
  globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({drawImage(){}})})};
  const walk=await loadWalkGif(WALK_GIF_SRC['test1-png']);
  assert(walk.frames.length===11&&walk.total===2200,'compatible frames preserve all 11 GIF frames and timing');
  assert(walk.frames.every(f=>f.width===215&&f.height===100),'compatible frames keep native resolution');
  assert(new Set(paths).size===11,'each authored frame has its own source');
 }finally{globalThis.Image=oldImage;globalThis.document=oldDocument;}
}
console.log('OK builtin walk fallback without ImageDecoder');

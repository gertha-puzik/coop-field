/**
 * Client catalogue of named rooms — mirror of server/modes.js titles/access.
 * Unknown URL codes stay open (legacy ?room=).
 *
 * P3: вариантозависимость (site.ts). В grotto-варианте комнаты Элизии нет
 * ни в каталоге, ни в справочнике — публичный сайт не должен знать о ней
 * вовсе. В elyria-варианте каталог полный: комнаты гротов остаются (движок
 * общий), но предлагает их roomsForMode только на страницах гротов.
 * Отдельный режим «combat» снят (P1 на сервере алиасит код в grot-1):
 * игра гротов — режим beer.
 */

/**
 * Compile-time вариант сайта (P3): фолдится сборщиком в false/true, поэтому
 * в grotto-бандл не попадают ни литерал комнаты Элизии, ни тексты её веток.
 * Сравнение дублируем инлайном (не через site.ts) — иначе сворачивания нет.
 */
const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === "elyria";

export type RoomAccess = "open" | "registered";
export type PlayMode = "hub" | "beer" | "elision" | "hunger";

export type NamedRoom = {
  id: string;
  title: string;
  mode: PlayMode;
  access: RoomAccess;
  href?: string;
  emoji: string;
  blurb: string;
};

/** Комнаты публичного сайта: только гроты и заглушка «Голодных игр». */
const GROTTO_ROOMS: readonly NamedRoom[] = [
  {
    id: "grot-1",
    title: "Пивной грот №1",
    mode: "beer",
    access: "open",
    href: "/combat/",
    emoji: "🍺",
    blurb: "Клеточное поле 10×6, бой, манекен и мишень. Гости заходят без аккаунта.",
  },
  {
    id: "grot-2",
    title: "Пивной грот №2",
    mode: "beer",
    access: "open",
    href: "/combat/",
    emoji: "🍺",
    blurb: "Второй грот — то же поле, другая комната.",
  },
  {
    id: "grot-3",
    title: "Пивной грот №3",
    mode: "beer",
    access: "open",
    href: "/combat/",
    emoji: "🍺",
    blurb: "Третий грот — то же поле, другая комната.",
  },
  {
    id: "hunger",
    title: "Голодные игры",
    mode: "hunger",
    access: "open",
    href: "/hunger",
    emoji: "🌾",
    blurb: "Отдельная открытая комната. Правила раунда владелицы ещё не задали — сейчас каркас «раунд не начат».",
  },
];

/** Каталог варианта: grotto не знает про Элизию, elyria — полный.
 *  Запись комнаты Элизии держим литералом в тернарнике — мёртвая ветка
 *  выкидывается при сборке, артефакта «test» в grotto не остаётся. */
export const NAMED_ROOMS: readonly NamedRoom[] = IS_ELYRIA
  ? [
      ...GROTTO_ROOMS,
      {
        id: "test",
        title: "Элизия Эйдес",
        mode: "elision" as const,
        access: "registered" as const,
        href: "/elision",
        emoji: "🌿",
        blurb: "Рисованная локация, мирная ходьба, редактор. Только со входом.",
      },
    ]
  : GROTTO_ROOMS;

/**
 * Коды, доступные только зарегистрированным — в ЛЮБОМ варианте сборки.
 * Карточку «комната из ссылки» они не получают, гость их не опрашивает:
 * сервер всё равно отвечает гостю «пусто» (ghost), а публичный сайт не
 * должен даже показывать код закрытой комнаты (спек §11 room discovery).
 */
export function isRegisteredOnlyCode(id: string): boolean {
  if (id === "test") return true;
  const hit = NAMED_ROOMS.find((r) => r.id === id);
  return hit?.access === "registered";
}

/**
 * Заголовки экрана входа по режиму. Тексты Элизии живут только в elyria-ветке
 * тернарника: сборка grotto их не содержит (спек §2A — ни одного упоминания).
 * В grotto-ветке нет и обращения к ключу elision: страницы этого режима
 * вырезаются prune-ом P6, MODE_COPY["elision"] там недостижим.
 */
export const MODE_COPY: Record<PlayMode, { title: string; lead: string }> = IS_ELYRIA
  ? {
      hub: {
        title: "abnocw",
        lead: "Слева — имя и скин, справа — скрытые параметры. Подтвердите три пункта — ниже откроется выбор комнаты.",
      },
      beer: {
        title: "Пивные гроты",
        lead: "Пивной грот №1–№3: клеточное поле, бой, манекен и мишень. Гости заходят без аккаунта.",
      },
      elision: {
        title: "Элизия Эйдес",
        lead: "Закрытая локация: мирная ходьба, вход в бой по клетке, редактор карты, сутки и погода. Без аккаунта сервер не пустит — даже прямым сокетом.",
      },
      hunger: {
        title: "Голодные игры",
        lead: "Отдельная открытая комната. Раунд на сервере в состоянии «не начат»: правила победы и событий владелицы ещё не задали, выдумывать их нельзя.",
      },
    }
  : ({
      hub: {
        title: "abnocw",
        lead: "Слева — имя и скин, справа — скрытые параметры. Подтвердите три пункта — ниже откроется выбор комнаты.",
      },
      beer: {
        title: "Пивные гроты",
        lead: "Пивной грот №1–№3: клеточное поле, бой, манекен и мишень. Гости заходят без аккаунта.",
      },
      hunger: {
        title: "Голодные игры",
        lead: "Отдельная открытая комната. Раунд на сервере в состоянии «не начат»: правила победы и событий владелицы ещё не задали, выдумывать их нельзя.",
      },
      // Ключ elision в grotto недостижим (маршрут вырезан), но Record требует
      // полноты — время исполнения туда не попасть, проверять нечего.
    } as Record<PlayMode, { title: string; lead: string }>);

export function namedRoom(id: string): NamedRoom | undefined {
  return NAMED_ROOMS.find((r) => r.id === id);
}

export function roomsForMode(mode: PlayMode): NamedRoom[] {
  if (mode === "hub") return [...NAMED_ROOMS];
  // Страница /combat/ — это гроты (режим beer): комнаты с подписью «активный
  // бой» в выборе нет, отдельного режима combat больше не существует.
  if (mode === "beer") return NAMED_ROOMS.filter((r) => r.mode === "beer");
  return NAMED_ROOMS.filter((r) => r.mode === mode);
}

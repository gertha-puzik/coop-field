/**
 * Client catalogue of named rooms — mirror of server/modes.js titles/access.
 * Unknown URL codes stay open (legacy ?room=).
 */
export type RoomAccess = "open" | "registered";
export type PlayMode = "hub" | "beer" | "elision" | "combat" | "hunger";

export type NamedRoom = {
  id: string;
  title: string;
  mode: PlayMode;
  access: RoomAccess;
  href?: string;
  emoji: string;
  blurb: string;
};

export const NAMED_ROOMS: readonly NamedRoom[] = [
  {
    id: "grot-1",
    title: "Пивной грот №1",
    mode: "beer",
    access: "open",
    href: "/",
    emoji: "🍺",
    blurb: "Клеточное поле 10×6, бой, манекен и мишень. Гости заходят без аккаунта.",
  },
  {
    id: "grot-2",
    title: "Пивной грот №2",
    mode: "beer",
    access: "open",
    href: "/",
    emoji: "🍺",
    blurb: "Второй грот — то же поле, другая комната.",
  },
  {
    id: "grot-3",
    title: "Пивной грот №3",
    mode: "beer",
    access: "open",
    href: "/",
    emoji: "🍺",
    blurb: "Третий грот — то же поле, другая комната.",
  },
  {
    id: "combat",
    title: "Активный бой",
    mode: "combat",
    access: "open",
    href: "/combat",
    emoji: "💥",
    blurb: "Отдельная страница и комната с теми же ударами и шагами, что в гротах.",
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
  {
    id: "test",
    title: "Элизия Эйдес",
    mode: "elision",
    access: "registered",
    href: "/elision",
    emoji: "🌿",
    blurb: "Рисованная локация, мирная ходьба, редактор. Только со входом.",
  },
];

export const MODE_COPY: Record<PlayMode, { title: string; lead: string }> = {
  hub: {
    title: "abnocw",
    lead: "Слева — имя и скин, справа — скрытые параметры. Подтвердите три пункта — ниже откроется выбор комнаты. Пивные гроты открыты гостям. Элизия, активный бой и голодные игры — отдельные страницы.",
  },
  beer: {
    title: "Пивные гроты",
    lead: "Открытые комнаты: клеточное поле, бой, манекен. Аккаунт не нужен.",
  },
  elision: {
    title: "Элизия Эйдес",
    lead: "Закрытая локация: мирная ходьба, вход в бой по клетке, редактор карты, сутки и погода. Без аккаунта сервер не пустит — даже прямым сокетом.",
  },
  combat: {
    title: "Активный бой",
    lead: "Отдельная открытая комната с теми же шагами, ударами, блоком и бронёй, что в гротах. Новых сложных правил нет — основа, которую можно расширять.",
  },
  hunger: {
    title: "Голодные игры",
    lead: "Отдельная открытая комната. Раунд на сервере в состоянии «не начат»: правила победы и событий владелицы ещё не задали, выдумывать их нельзя.",
  },
};

export function namedRoom(id: string): NamedRoom | undefined {
  return NAMED_ROOMS.find((r) => r.id === id);
}

export function roomsForMode(mode: PlayMode): NamedRoom[] {
  if (mode === "hub") return [...NAMED_ROOMS];
  if (mode === "beer") return NAMED_ROOMS.filter((r) => r.mode === "beer");
  return NAMED_ROOMS.filter((r) => r.mode === mode);
}

export function defaultRoomOf(mode: PlayMode): string {
  if (mode === "elision") return "test";
  if (mode === "combat") return "combat";
  if (mode === "hunger") return "hunger";
  return "grot-1";
}

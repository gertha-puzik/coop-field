/**
 * Темы оформления интерфейса. Ночь — исходная тёмная, светлая — дневная,
 * «Пивная» — тёплая янтарная с пузырьками.
 *
 * Тема живёт на <html data-theme="...">: все цвета интерфейса — CSS-переменные
 * из globals.css, поэтому переключение мгновенно перекрашивает и поля ввода,
 * и панели, и кнопки. Инлайн-скрипт в layout.tsx ставит атрибут до первой
 * отрисовки, чтобы не мигало тёмным при светлой теме.
 */

export type ThemeId = 'night' | 'light' | 'beer';

export const THEME_KEY = 'catwar-battle-sim-theme';

export const THEMES: Array<{ id: ThemeId; label: string }> = [
  { id: 'night', label: 'Ночная' },
  { id: 'light', label: 'Светлая' },
  { id: 'beer', label: 'Пивная' },
];

const THEME_IDS: ThemeId[] = ['night', 'light', 'beer'];

export function loadTheme(): ThemeId {
  if (typeof window === 'undefined') return 'night';
  try {
    const t = localStorage.getItem(THEME_KEY);
    return THEME_IDS.includes(t as ThemeId) ? (t as ThemeId) : 'night';
  } catch {
    return 'night';
  }
}

export function applyTheme(t: ThemeId) {
  try {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem(THEME_KEY, t);
  } catch {}
  notifyTheme(t);
}

/**
 * Подписка на смену темы (аккумулятивное расширение, волна «elyria-admin-look»):
 * компакт-селекты страниц синхронизируются между собой и с хромом симулятора —
 * хром в своём changeTheme вызывает applyTheme, значит каждая смена темы
 * (из любого UI) уведомляет всех подписчиков. Подписка: fn → функция отписки.
 */
type ThemeListener = (t: ThemeId) => void;

const listeners = new Set<ThemeListener>();

export function subscribeTheme(fn: ThemeListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notifyTheme(t: ThemeId): void {
  for (const fn of listeners) fn(t);
}

/** Палитра самого поля (канвас): применяется при смене темы, если игрок
 *  не настроил цвета поля вручную (они совпадают с одним из пресетов). */
export const FIELD_PRESETS: Record<ThemeId, { bgColor: string; bgColorAlt: string; gridColor: string }> = {
  night: { bgColor: '#2f343a', bgColorAlt: '#343a41', gridColor: '#454c53' },
  light: { bgColor: '#e9e3d5', bgColorAlt: '#dfd8c8', gridColor: '#bdb5a3' },
  beer: { bgColor: '#d3a041', bgColorAlt: '#c69437', gridColor: '#a37622' },
};

export function fieldPaletteOf(f: { bgColor: string; bgColorAlt: string; gridColor: string }): ThemeId | null {
  for (const id of THEME_IDS) {
    const p = FIELD_PRESETS[id];
    if (f.bgColor === p.bgColor && f.bgColorAlt === p.bgColorAlt && f.gridColor === p.gridColor) return id;
  }
  return null;
}

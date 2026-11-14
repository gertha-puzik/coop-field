/**
 * Маленький набор контурных иконок карточки профиля (макет 2026-11-14).
 * currentColor + stroke — цвет задаёт CSS (золото у заголовков карточек).
 */

const PATHS = {
  paw: 'M8.5 9.5a1.75 2.25 0 1 0 0-.01M15.5 9.5a1.75 2.25 0 1 0 0-.01M5 13.5a1.5 2 0 1 0 0-.01M19 13.5a1.5 2 0 1 0 0-.01M12 13c-3 0-5 3.2-5 5 0 1.4 1.3 2 2.6 2 1 0 1.6-.5 2.4-.5s1.4.5 2.4.5c1.3 0 2.6-.6 2.6-2 0-1.8-2-5-5-5z',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  pin: 'M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14c2 .7 3 2.8 3 6',
  cat: 'M5 4l3 4h8l3-4v9a7 7 0 0 1-14 0zM9.5 13h.01M14.5 13h.01M11 16h2',
  pulse: 'M3 12h4l2-6 4 12 2-6h6',
  door: 'M6 21V4h10v17M16 6l3 1v13l-3 1M12.5 12.5h.01',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9.5h.01',
  brush: 'M14 4l6 6-8 8H6v-6zM4 20h4',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.9 15H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.2 8.3l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.7 4.4V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.2 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  plus: 'M12 5v14M5 12h14',
  leaf: 'M5 19c0-8 5-13 14-14-1 9-6 14-14 14zM5 19l7-7',
  chart: 'M5 20V10M11 20V4M17 20v-7',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

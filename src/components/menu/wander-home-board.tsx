'use client';

/**
 * Правая доска «Что нового?» на главной (макет 2026-11-14): статичные
 * записки разного размера — без сервера. Тексты ветвятся инлайном по
 * NEXT_PUBLIC_SITE, чтобы grotto не тянул тексты закрытого варианта.
 */

const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria';

type NewsNote = {
  id: string;
  title: string;
  body: string;
  tone: 'plain' | 'heart' | 'seal';
};

const GROTTO_NEWS: readonly NewsNote[] = [
  {
    id: 'n1',
    title: 'Окно миров',
    body: 'Три двери внизу слева — бой, голодные игры и мост в закрытый мир. Живой счётчик показывает, кто уже на поле.',
    tone: 'plain',
  },
  {
    id: 'n2',
    title: 'Следы лап',
    body: 'Проведи курсором по ночному полю — останутся лапки.',
    tone: 'heart',
  },
  {
    id: 'n3',
    title: 'Ночная доска',
    body: 'Здесь появляются короткие новости о поле и меню. Заглядывай, когда вернёшься домой.',
    tone: 'seal',
  },
  {
    id: 'n4',
    title: 'Мобильный бой',
    body: 'На телефоне в гроте джойстик и заряд прыжка лежат над HUD — те же WASD и пробел, только пальцем.',
    tone: 'plain',
  },
];

const ELYRIA_NEWS: readonly NewsNote[] = IS_ELYRIA
  ? [
      {
        id: 'n1',
        title: 'Игровая комната',
        body: 'Окно слева ведёт на поле. Сверху — профиль, настройки внешности и выход из аккаунта.',
        tone: 'plain',
      },
      {
        id: 'n2',
        title: 'Следы лап',
        body: 'Проведи курсором по ночному полю — останутся лапки.',
        tone: 'heart',
      },
      {
        id: 'n3',
        title: 'Ночная доска',
        body: 'Короткие новости о мире и меню. Заглядывай, когда вернёшься на главную.',
        tone: 'seal',
      },
      {
        id: 'n4',
        title: 'Каталог игроков',
        body: 'В шапке сверху открывается каталог и свой профиль — скин, день рождения, аватар.',
        tone: 'plain',
      },
    ]
  : [];

const NEWS: readonly NewsNote[] = IS_ELYRIA ? ELYRIA_NEWS : GROTTO_NEWS;

/** Доска объявлений справа на главной: заголовок + записки. */
export function WanderNewsBoard() {
  return (
    <aside className="wander-board" aria-label="Что нового">
      <h2 className="wander-board-title">Что нового?</h2>
      <ul className="wander-board-notes">
        {NEWS.map((note) => (
          <li key={note.id} className={`wander-note-card wander-note-${note.tone}`}>
            {note.tone === 'heart' ? <span className="wander-note-mark" aria-hidden>♥</span> : null}
            {note.tone === 'seal' ? <span className="wander-note-mark wander-note-seal" aria-hidden /> : null}
            <strong>{note.title}</strong>
            <p>{note.body}</p>
          </li>
        ))}
      </ul>
      <div className="wander-board-foliage" aria-hidden />
    </aside>
  );
}

/** Силуэт города, тропа и два кота — фон левой половины макета. */
export function WanderScene() {
  return (
    <svg className="wander-scene" viewBox="0 0 640 420" preserveAspectRatio="xMidYMax meet" aria-hidden>
      {/* Город слева */}
      <g fill="none" stroke="rgba(244,240,255,0.55)" strokeWidth="1.6" strokeLinejoin="round">
        <path d="M18 210 V140 H48 V210" />
        <path d="M48 210 V118 H78 V210" />
        <path d="M78 210 V150 H108 V210" />
        <path d="M108 210 V96 H148 V210" />
        <path d="M148 210 V130 H178 V210" />
        <path d="M178 210 V158 H208 V210" />
        <path d="M36 140 h12 M60 118 h12 M90 150 h12 M120 96 h18 M158 130 h12" />
        <path d="M128 96 l10 -18 10 18" />
      </g>
      {/* Тропа к горизонту */}
      <path
        d="M250 400 C 280 320, 300 250, 310 200 C 318 160, 322 130, 328 108"
        fill="none"
        stroke="rgba(244,240,255,0.42)"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M290 400 C 310 330, 325 255, 332 205 C 338 165, 342 135, 346 112"
        fill="none"
        stroke="rgba(244,240,255,0.28)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      {/* Сидящий кот вдали */}
      <g fill="rgba(244,240,255,0.82)" transform="translate(318 88)">
        <path d="M8 28 C 6 18 10 12 18 12 C 26 12 30 18 28 28 Z" />
        <circle cx="14" cy="14" r="6.5" />
        <path d="M9 10 L7 3 L12 8 M19 10 L21 3 L16 8" />
        <path d="M27 22 C 34 16 38 20 36 27 C 33 30 28 28 27 22 Z" />
      </g>
      {/* Бегущий/прыгающий кот ближе */}
      <g fill="rgba(244,240,255,0.92)" transform="translate(200 248) rotate(-12)">
        <ellipse cx="26" cy="16" rx="20" ry="11" />
        <circle cx="8" cy="12" r="8" />
        <path d="M3 7 L1 0 L8 5 M13 6 L15 -1 L9 5" />
        <path d="M42 12 C 52 4 56 12 52 18 C 48 22 42 18 42 12 Z" />
        <ellipse cx="18" cy="26" rx="3.2" ry="5" transform="rotate(25 18 26)" />
        <ellipse cx="28" cy="26" rx="3.2" ry="5" transform="rotate(-10 28 26)" />
        <ellipse cx="12" cy="24" rx="2.6" ry="4.2" transform="rotate(40 12 24)" />
      </g>
      {/* Кусты у доски / низа */}
      <g fill="none" stroke="rgba(220,235,210,0.45)" strokeWidth="1.5" strokeLinecap="round">
        <path d="M40 390 Q 48 360 56 390 Q 64 355 72 390" />
        <path d="M520 400 Q 535 365 550 400 Q 565 355 580 400" />
        <path d="M560 405 Q 575 370 590 405" />
      </g>
    </svg>
  );
}

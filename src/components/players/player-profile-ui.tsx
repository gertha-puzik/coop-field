'use client';

/**
 * Презентационные кирпичики страницы профиля (вынесены из player-profile.tsx
 * волной W1-приёмки 2026-11-08, чтобы карточка не росла в god-файл):
 * иконки и «честные достижения», портрет-арена, чип-пресеты СП, группы
 * скинов, активный персонаж и человеческие тексты ошибок сохранения.
 */

import type { ReactNode } from 'react';

import type { ProfileCard, ProfileMe, PublicProfile } from '@/lib/net/http-profiles';
import {
  MALYSHOCHKI_SET,
  SPRITES,
  SPRITE_GROUPS,
} from '@/lib/sim/settings';
import { avatarOf, moonsFromMs, spriteUrl } from './players-format';
import styles from './players-elyria.module.css';

/** Контур луны (svg-путь): иконка ACH_ICONS и бренд-строки. */
export const moonPath = 'M20.4 14.2A8.6 8.6 0 1 1 9.8 3.6a7 7 0 0 0 10.6 10.6Z';

/* заливные иконки достижений (как в референсе) */
type AchIcon = 'star' | 'moon' | 'paw' | 'leaf' | 'eye' | 'flame';

export const ACH_ICONS: Record<AchIcon, ReactNode> = {
  star: <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />,
  moon: <path d={moonPath} />,
  paw: (
    <>
      <ellipse cx="12" cy="16.4" rx="4.6" ry="3.5" />
      <circle cx="5.5" cy="12.2" r="1.9" />
      <circle cx="9.3" cy="9.3" r="2" />
      <circle cx="14.7" cy="9.3" r="2" />
      <circle cx="18.5" cy="12.2" r="1.9" />
    </>
  ),
  leaf: (
    <>
      <path d="M20.6 3.4C9.8 4.4 4.4 10.2 3.9 20.6 14.2 20.2 19.6 14.4 20.6 3.4Z" />
      <path d="M4.8 19.7C7.6 12.9 12 8.4 18.9 5.1" stroke="#070b18" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </>
  ),
  eye: (
    <>
      <path d="M12 5.4C6.6 5.4 2.7 9.8 1.5 12 2.7 14.2 6.6 18.6 12 18.6 17.4 18.6 21.3 14.2 22.5 12 21.3 9.8 17.4 5.4 12 5.4Z" />
      <circle cx="12" cy="12" r="4.1" fill="#070b18" />
    </>
  ),
  flame: (
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
  ),
};

/* ——— честные «достижения»: каждый — вычислимый факт карточки ——— */

export type AchFact = { title: string; hint: string; icon: AchIcon; earned: boolean; color: string };

export function achFacts(card: ProfileCard, now: number): AchFact[] {
  const seen = card.lastSeenAt ?? 0;
  const moons = moonsFromMs(card.createdAt, now) ?? 0;
  return [
    {
      title: 'Звёздный дебют',
      hint: 'публичная карточка в каталоге создана',
      icon: 'star',
      earned: card.createdAt > 0,
      color: '#f6d7a2',
    },
    {
      title: 'Первая луна',
      hint: '30 дней с того дня, как карточка появилась',
      icon: 'moon',
      earned: moons >= 1,
      color: '#f6d7a2',
    },
    {
      title: 'Свой облик',
      hint: 'выбран персонаж-аватар карточки',
      icon: 'paw',
      earned: card.avatarCharacterId !== null,
      color: '#efe7ff',
    },
    {
      title: 'Летописец',
      hint: 'заполнено поле «о себе»',
      icon: 'leaf',
      earned: card.bio.trim().length > 0,
      color: '#7dcaa0',
    },
    {
      title: 'Многоликий',
      hint: 'в аккаунте больше одного персонажа',
      icon: 'eye',
      earned: card.characters.length >= 2,
      color: '#efe7ff',
    },
    {
      title: 'Ночной патруль',
      hint: 'появлялась в последние три дня',
      icon: 'flame',
      earned: seen > 0 && now - seen < 3 * 24 * 60 * 60 * 1000,
      color: '#f6d7a2',
    },
  ];
}

/* ——— портрет: арена-лужайка со спрайтом выбранного персонажа ——— */

export function Portrait({ card, name }: { card: ProfileCard; name: string }) {
  const char = avatarOf(card);
  const url = spriteUrl(char);
  const scale = Math.min(120, Math.max(60, char?.size || 100));
  return (
    <figure className={styles.avatar}>
      <span className={styles.avatarArt}>
        <span className={styles.meadow} aria-hidden>
          <svg className={styles.grass} viewBox="0 0 198 74" preserveAspectRatio="none" aria-hidden>
            <g fill="#101d3c" opacity=".85">
              <path d="M8 74C10 52 14 40 12 24c5 16 7 34 8 50z" />
              <path d="M30 74c3-24-1-40 4-56 4 18 6 38 7 56z" />
              <path d="M55 74c2-20 6-32 4-46 5 16 7 32 8 46z" />
              <path d="M132 74c2-18-2-34 4-48 4 16 5 34 7 48z" />
              <path d="M158 74c2-22 6-36 3-52 6 18 8 38 9 52z" />
              <path d="M179 74c2-18-1-32 4-44 3 16 5 32 5 44z" />
            </g>
            <g fill="#060d1e" opacity=".95">
              <path d="M0 74C3 48 6 30 4 12c7 20 9 42 10 62z" />
              <path d="M22 74c4-30 2-48 8-66 4 22 5 44 6 66z" />
              <path d="M163 74c3-28 0-46 7-64 3 22 4 44 4 64z" />
              <path d="M184 74c3-24 1-40 6-54 3 18 3 38 4 54z" />
            </g>
            <g fill="#ffffff">
              <circle cx="34" cy="22" r="1.2" opacity=".55" />
              <circle cx="164" cy="14" r="1.4" opacity=".45" />
              <circle cx="99" cy="9" r="1" opacity=".5" />
            </g>
          </svg>
        </span>
        {url ? (
          <img
            className={styles.portrait}
            src={url}
            alt={`Спрайт персонажа: ${name}`}
            style={{ width: `${scale}%`, height: 'auto' }}
          />
        ) : (
          // спрайт не выбран — безликая лапа, а не выдуманный портрет
          <span className={styles.portraitPaw} aria-hidden>
            🐾
          </span>
        )}
      </span>
      <figcaption className={styles.avatarCap}>{name}</figcaption>
    </figure>
  );
}

/** Кнопка-пресет урона/брони: как чипы экрана входа, компактная. */
export function SpChip({ active, onClick, children: label }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={
        active
          ? 'h-6 shrink-0 rounded bg-[var(--sim-accent)] px-2 text-[10px] font-semibold leading-none text-black'
          : 'h-6 shrink-0 rounded border border-[var(--sim-line-strong)] px-2 text-[10px] font-semibold leading-none text-[var(--sim-text)] hover:border-[var(--sim-line-hover)]'
      }
    >
      {label}
    </button>
  );
}

/* ——— выбор скина для своей карточки: статичный каталог движка, те же
   колонки-группы, что на карусели экрана входа (compact tiles, без карусели) ——— */

const spriteById = new Map(SPRITES.map((sp) => [sp.id, sp] as const));
const metasOf = (ids: readonly string[]) =>
  ids.map((id) => spriteById.get(id)).filter((sp): sp is (typeof SPRITES)[number] => Boolean(sp));

/** Группы плиток: общие персонажи + набор «Малышочки» отдельной секцией. */
export const SKIN_GROUPS: { id: string; name: string; sprites: (typeof SPRITES)[number][] }[] = [
  ...SPRITE_GROUPS.map((g) => ({ id: g.id, name: g.name, sprites: metasOf(g.spriteIds) })),
  { id: MALYSHOCHKI_SET.id ?? 'malyshochki', name: MALYSHOCHKI_SET.name, sprites: metasOf(MALYSHOCHKI_SET.spriteIds) },
].filter((g) => g.sprites.length > 0);

/** Активный персонаж карточки: тот же выбор, что делает сервер при входе
 *  (activeCharacterId, иначе первый) — поле/аватар/профиль показывают его. */
export function activeCharOf(profile: ProfileMe | PublicProfile) {
  return (
    profile.characters.find((c) => c.id === profile.activeCharacterId) ??
    profile.characters[0] ??
    null
  );
}

export function humanEditError(reason: string | undefined): string {
  switch (reason) {
    case 'auth_required':
      return 'Нужен вход в аккаунт.';
    case 'csrf':
      return 'Запрос отклонён защитой CSRF.';
    case 'invalid_body':
      return 'Запрос не читается как корректный JSON.';
    case 'empty_patch':
      return 'Нет полей для сохранения.';
    case 'invalid':
      return 'Проверьте поля карточки — что-то заполнено неверно.';
    case 'offline':
      return 'Сервер недоступен.';
    default:
      return 'Не получилось сохранить.';
  }
}

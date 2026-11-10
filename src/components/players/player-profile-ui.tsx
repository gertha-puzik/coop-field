'use client';

/**
 * Презентационные кирпичики страницы профиля (вынесены из player-profile.tsx
 * волной W1-приёмки 2026-11-08, чтобы карточка не росла в god-файл):
 * иконки и «честные достижения», портрет-арена, чип-пресеты СП, группы
 * скинов, активный персонаж и человеческие тексты ошибок сохранения.
 * #83: + зона «Свой окрас» (MineSpritesSection) — загрузка/удаление личных
 * PNG через /sprites/mine, счётчик лимита, подтверждение вторым кликом.
 * #84/в3: + второй вход той же зоны (CatwarCodeEntry) — окрас по КОДУ
 * CatWar (конструктор kns.miew.ru): клиентский рендер M2-котика без
 * загрузки картинки, сохранение тем же POST /sprites/mine.
 * Контент-волна профиля: Portrait рисует свою картинку (DTO avatar) вместо
 * спрайта; AvatarField — блок «Аватар» редактора (сетевой клиент аватаров —
 * отдельный модуль lib/net, сюда его не импортируем).
 */

import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, Chip, Input } from '@/components/ui';
import { httpPatchProfile, type ProfileCard, type ProfileMe, type PublicProfile } from '@/lib/net/http-profiles';
import {
  httpDeleteMineSprite,
  httpMineSprites,
  httpUploadMineSprite,
  humanMineError,
  type MineError,
  type MineSprite,
} from '@/lib/net/http-my-sprites';
import type { CatwarFailReason } from '@/lib/paint/catwar-coat';
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
  // своя картинка профиля (DTO-поле avatar) заменяет спрайт персонажа:
  // рамка и размер портрета прежние, object-fit: contain несёт .portrait
  const ownAvatar = typeof card.avatar === 'string' && card.avatar ? card.avatar : null;
  return (
    <figure className={styles.avatar}>
      <span className={styles.avatarArt}>
        {ownAvatar ? (
          <img className={styles.portrait} src={ownAvatar} alt={name} draggable={false} />
        ) : (
          <>
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
          </>
        )}
      </span>
      <figcaption className={styles.avatarCap}>{name}</figcaption>
    </figure>
  );
}

/** Кнопка-пресет урона/брони: ui-kit Chip (документация — docs/UI-KIT.md),
 *  активный — акцентная пара --uk-accent-*, неактивный — тихая обводка.
 *  Публичная сигнатура W1 не меняется — потребитель один и тот же. */
export function SpChip({ active, onClick, children: label }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <Chip type="button" size="sm" tone={active ? 'active' : 'default'} onClick={onClick} title={label}>
      {label}
    </Chip>
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

/* ——— «Аватар» (контент-волна профиля): своя картинка игрока. Блок чисто
   презентационный — сетевыми ходоками владеет player-profile.tsx, здесь
   только состояние-props: превью, скрытый файл-инпут, подтверждение
   удаления вторым кликом (канон MineSpritesSection) ——— */

export function AvatarField({
  avatarUrl,
  busy,
  armed,
  onFile,
  onRemoveClick,
}: {
  /** DTO-URL своей картинки ('' — картинки нет: превью и «убрать» скрыты). */
  avatarUrl: string;
  busy: boolean;
  /** «Убрать картинку» вооружена: следующий клик удаляет (5 сек назад). */
  armed: boolean;
  onFile: (file: File) => void;
  onRemoveClick: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className={styles.edField}>
      <span className={styles.edLabel}>Аватар</span>
      <div className="mt-1.5 flex flex-wrap items-center gap-2.5 rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-inset-strong)] p-2">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt="Своя картинка профиля"
            className="h-16 w-16 shrink-0 rounded-md border border-[var(--sim-line)] bg-black/20 object-contain"
            draggable={false}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-[10px] text-[var(--sim-text-faint)]">
            Своя картинка (PNG или JPEG, сторона 64–1500 px, до 2 МБ)
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files && e.target.files[0] ? e.target.files[0] : null;
                e.target.value = '';
                if (file) onFile(file);
              }}
            />
            <Button
              type="button"
              size="sm"
              className="h-8 bg-[var(--sim-accent)] text-xs text-black hover:bg-[var(--sim-accent-hover)]"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {busy ? 'Загружаем…' : 'Загрузить картинку'}
            </Button>
            {avatarUrl ? (
              <button
                type="button"
                disabled={busy}
                onClick={onRemoveClick}
                className={`rounded border px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-50 ${
                  armed
                    ? 'border-red-500 bg-red-950 font-bold text-red-300'
                    : 'border-[var(--sim-line)] text-[var(--sim-text-soft)] hover:border-[var(--sim-line-hover)]'
                }`}
                title={armed ? 'Ещё раз — и картинки не будет' : 'Убрать свою картинку'}
              >
                {armed ? 'Точно убрать?' : 'Убрать картинку'}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ——— «Свой окрас» (#83): загрузка личного PNG, список своих (надеть /
   удалить), счётчик лимита 3, подтверждение удаления вторым кликом ——— */

const MINE_LIMIT_HINT = 'PNG до 1 МБ · сторона 100–1000 px · имя 2–24 символа · мест на аккаунт — 3.';

export function MineSpritesSection({
  accountName,
  draftSprite,
  wornSprite,
  onPick,
  mineHighlight = null,
  selfAccountId = null,
  coatLink = null,
}: {
  /** Ник карточки — для префилла имени окраса («Окрас от <ник> <дата>»). */
  accountName: string;
  /** Скин, выбранный в черновике формы (ещё не сохранён). */
  draftSprite: string;
  /** Скин, реально надетый персонажем прямо сейчас. */
  wornSprite: string;
  /** Черновой выбор скина активного персонажа (тот же state редактора). */
  onPick: (id: string) => void;
  /** #84 ч.2: id свежего окраса из редактора (?back=profile возврат) —
   *  плитка подсвечивается, тост успеха; одноразовый. */
  mineHighlight?: string | null;
  /** #84/в3: accountId своей карточки — deep-link «?id&mine=#settings» после
   *  «Сохранить и надеть» по коду CatWar (подсветка/тост — механизм ч.2). */
  selfAccountId?: string | null;
  /** #84/в3: код CatWar из ссылки ?coat= (конструктор KNS) — второй вход
   *  заполняет поле кода и сам собирает превью; стора нет. */
  coatLink?: string | null;
}) {
  const [items, setItems] = useState<MineSprite[]>([]);
  const [limit, setLimit] = useState(3);
  const [loaded, setLoaded] = useState(false);
  const [upName, setUpName] = useState(() => {
    /* Тот же префилл, что у моста редактора (game-bridge.js): год — двумя
     *  цифрами, чтобы «Окрас от <имя> <дата>» влезал в лимит имени 2–24
     *  ДО ручной правки (длинный ник не ломает отправку). */
    const d = new Date();
    const two = (x: number) => (x < 10 ? `0${x}` : `${x}`);
    const base = `Окрас от ${accountName} ${two(d.getDate())}.${two(d.getMonth() + 1)}.${String(d.getFullYear()).slice(-2)}`;
    return base.length > 24 ? base.slice(0, 24) : base;
  });
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Вооружённое удаление: второй клик подтверждает (как в админ-вкладке). */
  const [armedId, setArmedId] = useState<string | null>(null);
  const armTimer = useRef<number | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string; details?: string } | null>(null);
  /** #84 ч.2: подсветка плитки свежего окраса из редактора (гаснет сама). */
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  const flashDoneRef = useRef(false);

  useEffect(
    () => () => {
      if (armTimer.current) window.clearTimeout(armTimer.current);
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  const flashStatus = useCallback((next: { kind: 'ok' | 'err'; text: string; details?: string } | null) => {
    setStatus(next);
    if (next) window.setTimeout(() => setStatus((cur) => (cur === next ? null : cur)), 6000);
  }, []);

  /** #84 ч.2: возврат из редактора (?back=profile → ?mine=<id>): список
   *  долетел — плитка свежего окраса подсвечивается, успех виден явно
   *  (контракт: «возврат — подсветить новый окрас», тост при успехе).
   *  Один раз на параметр (гость/чужая карточка просто не совпадёт). */
  useEffect(() => {
    if (!mineHighlight || flashDoneRef.current || !loaded) return;
    if (!items.some((it) => it.id === mineHighlight)) return;
    flashDoneRef.current = true;
    setFlashId(mineHighlight);
    flashTimer.current = window.setTimeout(() => setFlashId(null), 6000);
    flashStatus({ kind: 'ok', text: 'Новый окрас сохранён — он в «Мои окрасы».' });
    // легкий подскролл к блоку «Свой окрас» без дёргания страницы
    document.getElementById('settings')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [mineHighlight, loaded, items, flashStatus]);

  const reload = useCallback(async () => {
    const res = await httpMineSprites();
    if (res.ok) {
      setItems(res.items);
      setLimit(res.limit);
      setLoaded(true);
      return;
    }
    const err = res as MineError;
    flashStatus({ kind: 'err', text: humanMineError(err.reason, 'Список своих окрасов не загрузился.') });
  }, [flashStatus]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const upload = useCallback(async () => {
    if (!file) {
      flashStatus({ kind: 'err', text: 'Сначала выберите PNG-файл.' });
      return;
    }
    const name = upName.replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 24) {
      flashStatus({ kind: 'err', text: 'Имя окраса: 2–24 символа.' });
      return;
    }
    if (file.size > 1024 * 1024) {
      flashStatus({ kind: 'err', text: 'Файл больше 1 МБ не принимается — уменьшите картинку.' });
      return;
    }
    setUploading(true);
    const res = await httpUploadMineSprite(file, name);
    setUploading(false);
    setFile(null);
    if (fileRef.current) fileRef.current.value = '';
    if (!res.ok) {
      const err = res as MineError;
      const worn = err.wornBy || [];
      flashStatus({
        kind: 'err',
        text: humanMineError(err.reason, 'Загрузить не удалось.'),
        details:
          err.message ||
          (worn.length ? `Одет у: ${worn.map((w) => `${w.login} (${w.character})`).join(', ')}` : undefined),
      });
      await reload();
      return;
    }
    flashStatus({
      kind: 'ok',
      text: res.dedup ? 'Такая картинка уже была загружена — показываем существующий окрас.' : 'Окрас загружен.',
    });
    await reload();
  }, [file, upName, flashStatus, reload]);

  const remove = useCallback(
    async (id: string) => {
      setBusyId(id);
      const res = await httpDeleteMineSprite(id);
      setBusyId(null);
      setArmedId(null);
      if (!res.ok) {
        const err = res as MineError;
        const worn = err.wornBy || [];
        flashStatus({
          kind: 'err',
          text: humanMineError(err.reason, 'Удалить не удалось.'),
          details:
            err.message ||
            (worn.length ? `Одет у: ${worn.map((w) => `${w.login} (${w.character})`).join(', ')}` : undefined),
        });
        await reload();
        return;
      }
      // удалённое не может остаться выбранным в черновике — возвращаем текущий скин
      if (draftSprite === id) onPick(wornSprite);
      flashStatus({ kind: 'ok', text: 'Окрас удалён.' });
      await reload();
    },
    [flashStatus, reload, draftSprite, onPick, wornSprite],
  );

  const armRemove = useCallback((id: string) => {
    setArmedId(id);
    if (armTimer.current) window.clearTimeout(armTimer.current);
    armTimer.current = window.setTimeout(() => setArmedId(null), 5000);
  }, []);

  /** Ошибки второго входа (по коду CatWar) — тем же тостом зоны. */
  const flashFail = useCallback(
    (text: string, details?: string) => flashStatus({ kind: 'err', text, details }),
    [flashStatus],
  );

  /** #84/в3: второй вход зоны сохранил окрас по коду CatWar — подсветить
   *  новую плитку тем же механизмом, что возврат из редактора, и обновить список. */
  const markFreshCoat = useCallback(
    (id: string, text: string) => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      setFlashId(id);
      flashTimer.current = window.setTimeout(() => setFlashId(null), 6000);
      flashStatus({ kind: 'ok', text });
      void reload();
    },
    [flashStatus, reload],
  );

  /** #84/в3: окрас из ссылки конструктора (?coat=) отрисован в превью —
   *  человеческий тост и лёгкий подскролл к блоку «Свой окрас» (механизм
   *  тот же, что у подсветки возврата из редактора). Никаких сохранений. */
  const linkCoatApplied = useCallback(() => {
    flashStatus({ kind: 'ok', text: 'Окрас из конструктора KNS загружен — посмотрите и сохраните.' });
    document.getElementById('settings')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [flashStatus]);

  return (
    <div className={styles.edField}>
      <span className={styles.edLabel}>
        Свой окрас{' '}
        <span className="ml-1 text-[var(--sim-text-faint)]">
          {items.length} из {limit}
        </span>
        {/* #84 ч.2: редактор окрасов сайта — рисуем окрас, не выходя из игры */}
        <a
          className="ml-2 rounded border border-[var(--sim-line)] px-1.5 py-0.5 text-[10px] text-[var(--sim-text-soft)] transition-colors hover:border-[var(--sim-line-hover)] hover:text-[var(--sim-text)]"
          href="/paint-demo/?back=profile"
          title="Открыть редактор окрасов: нарисованный кот сохранится в «Мои окрасы»"
        >
          Нарисовать окрас
        </a>
      </span>
      <div className="mt-1.5 rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-inset-strong)] p-2">
        {status ? (
          <div
            className={`mb-2 rounded-lg border p-2 ${
              status.kind === 'ok' ? 'border-emerald-900/60 bg-emerald-950/40' : 'border-red-900/60 bg-red-950/40'
            }`}
          >
            <p className={`text-[11px] font-semibold ${status.kind === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>
              {status.text}
            </p>
            {status.details ? <p className="mt-1 text-[11px] text-red-200">{status.details}</p> : null}
          </div>
        ) : null}
        <p className="mb-1.5 text-[10px] text-[var(--sim-text-faint)]">{MINE_LIMIT_HINT}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            ref={fileRef}
            type="file"
            accept="image/png"
            className="h-8 max-w-full rounded-md border border-[var(--sim-line)] bg-black/20 px-2 text-xs text-[var(--sim-text-soft)] file:mr-2 file:rounded file:border-0 file:bg-black/40 file:px-2 file:py-1 file:text-xs file:text-[var(--sim-text-soft)]"
            onChange={(e) => setFile(e.target.files ? e.target.files[0] : null)}
          />
          <Input
            className="h-8 w-44 text-xs"
            value={upName}
            maxLength={24}
            placeholder="Имя окраса (2–24)"
            onChange={(e) => setUpName(e.target.value)}
          />
          <Button
            type="button"
            size="sm"
            className="h-8 bg-[var(--sim-accent)] text-xs text-black hover:bg-[var(--sim-accent-hover)]"
            disabled={uploading || !file}
            onClick={() => void upload()}
          >
            {uploading ? 'Загружаем…' : 'Загрузить'}
          </Button>
        </div>
        {/* #84/в3: второй вход зоны — окрас по КОДУ CatWar (без загрузки
            картинки): рендер движком из конструктора kns.miew.ru; код может
            прийти из одноразовой ссылки ?coat= (поле+превью сами, без POST). */}
        <CatwarCodeEntry
          selfAccountId={selfAccountId}
          onSaved={markFreshCoat}
          onFail={flashFail}
          coatLink={coatLink}
          onLinkApplied={linkCoatApplied}
        />
        {loaded && items.length === 0 ? (
          <p className="mt-2 text-[11px] text-[var(--sim-text-soft)]">
            Своих окрасов пока нет — загрузите PNG из редактора окрасов.
          </p>
        ) : null}
        {items.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {items.map((it) => {
              const worn = wornSprite === it.id;
              const picked = draftSprite === it.id && !worn;
              const flashed = flashId === it.id;
              return (
                <div
                  key={it.id}
                  className={`flex w-24 flex-col items-center rounded-lg border p-1 transition-colors ${
                    worn || picked
                      ? 'border-[var(--sim-accent-hover)] bg-[var(--sim-accent-tint)]'
                      : flashed
                        ? 'border-[var(--sim-accent-hover)] bg-[var(--sim-accent-tint)] shadow-[0_0_0_2px_var(--sim-accent)]'
                        : 'border-transparent hover:border-[var(--sim-line-hover)]'
                  }`}
                >
                  <img src={it.src} alt={it.name} className="h-10 w-auto object-contain" draggable={false} />
                  <span className="w-full truncate text-center text-[10px] font-medium text-[var(--sim-text-soft)]">
                    {it.name}
                  </span>
                  {worn ? (
                    <span className="mt-0.5 rounded bg-[var(--sim-accent)] px-1 text-[9px] font-bold text-black">
                      Сейчас на вас
                    </span>
                  ) : null}
                  {it.hidden ? (
                    <span className="mt-0.5 rounded bg-red-950 px-1 text-[9px] font-bold text-red-300">
                      Скрыт администратором
                    </span>
                  ) : null}
                  <div className="mt-1 flex items-center gap-1">
                    <button
                      type="button"
                      aria-pressed={picked}
                      disabled={worn || busyId === it.id}
                      title={worn ? 'Окрас уже надет' : 'Выбрать окрас для активного персонажа'}
                      onClick={() => onPick(it.id)}
                      className="rounded border border-[var(--sim-line)] px-1.5 py-0.5 text-[10px] text-[var(--sim-text-soft)] transition-colors hover:border-[var(--sim-line-hover)] disabled:opacity-50"
                    >
                      {worn ? 'Надет' : picked ? 'Выбран' : 'Надеть'}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === it.id}
                      onClick={() => {
                        if (armedId === it.id) void remove(it.id);
                        else armRemove(it.id);
                      }}
                      className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors disabled:opacity-50 ${
                        armedId === it.id
                          ? 'border-red-500 bg-red-950 font-bold text-red-300'
                          : 'border-[var(--sim-line)] text-[var(--sim-text-soft)] hover:border-[var(--sim-line-hover)]'
                      }`}
                    >
                      {armedId === it.id ? 'Точно удалить?' : 'Удалить'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ——— второй вход «Свой окрас» (#84/в3): окрас по КОДУ CatWar ——— */

/** Живой код окраса (конструктор kns.miew.ru, 24 блока грамматики CatWar) —
 *  поле: так выглядит настоящий окрас для копирования. */
const CATWAR_EXAMPLE = '1/18 17|5-16 14/2-8/18-9/2|4-13/14 18/15-8/18-9/2|4-13/14 31/18-41/14|2-19/18 31/12|6-64/1|2-51/12|1-42/2|0-45/17|7-38/2 9/2|9-4/12|7-13/14 2/11|0 2/12|0 9/2|7 1/12-2/12 0 3/2|5 33/17-34/2|5-39/18-15/2-20/14 37/18-17/2|5-22/14 6/18 3/18 3/17 3/18 16|0 11/16|0-3/18-6/12|0 2/2 3/1 0';

/** Отказы конвейера кода → человеческий русский без жаргона. */
function catwarFailText(reason: CatwarFailReason): string {
  switch (reason) {
    case 'bad_syntax':
      return 'Код не похож на окрас CatWar — проверьте, что скопировали целиком.';
    case 'no_coat_zones':
      return 'В коде не нашлось основных зон окраса — проверьте, что скопировали код целиком.';
    default:
      return 'Не получилось собрать окрас из кода — обновите страницу и попробуйте ещё раз.';
  }
}

/** Размер превью-канвы: котик 1:1 (кроп до ~100–150 px) с воздухом вокруг. */
const PREVIEW_W = 220;
const PREVIEW_H = 170;

/**
 * Поле «код окраса CatWar» + живое превью + сохранение в существующий
 * /sprites/mine (тот же лимит/дедуп/rate). «Сохранить и надеть» дополнительно
 * шлёт PATCH /profiles/me и уходит deep-link'ом ?id&mine=#settings —
 * подсветку/тост после возврата даёт существующий механизм (#84 ч.2).
 * Рендер-модуль подтягивается ДИНАМИЧЕСКИ (import по клику) — движок
 * tint.js и маски не живут в общих бандлах других страниц (§10.4).
 * #84/в3+: код может прийти из одноразовой ссылки ?coat= (конструктор KNS
 * на kns.miew.ru): поле заполняется и превью собирается САМО тем же
 * конвейером, что кнопка «Создать окрас», — но сохранение остаётся
 * только кнопкой: открытие ссылки не тратит лимит загрузок (5/час).
 */
export function CatwarCodeEntry({
  selfAccountId,
  onSaved,
  onFail,
  coatLink = null,
  onLinkApplied,
}: {
  /** Свой accountId (deep-link «надеть») — null только у вырожденного случая. */
  selfAccountId: string | null;
  /** Успех сохранения: подсветка новой плитки + тост (текст здесь же). */
  onSaved: (id: string, okText: string) => void;
  /** Ошибки поля тем же тостом зоны «Свой окрас». */
  onFail: (text: string, details?: string) => void;
  /** #84/в3: код CatWar из ссылки ?coat= — автозаполнение + автопревью
   *  (одноразово; битый код даёт тост ручной вставки). */
  coatLink?: string | null;
  /** Превью по коду из ссылки собралось — тост зоны + подскролл (родитель). */
  onLinkApplied?: () => void;
}) {
  const [code, setCode] = useState('');
  /** Префилл имени тот же стиль, что у файлового входа (влезает в лимит 24). */
  const [coatName, setCoatName] = useState(() => {
    const d = new Date();
    const two = (x: number) => (x < 10 ? `0${x}` : `${x}`);
    const base = `CatWar-окрас ${two(d.getDate())}.${two(d.getMonth() + 1)}.${String(d.getFullYear()).slice(-2)}`;
    return base.length > 24 ? base.slice(0, 24) : base;
  });
  const [rendering, setRendering] = useState(false);
  const [payload, setPayload] = useState<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Подсветка блока «по коду» после ?coat=-ссылки (гаснет сама, как у плиток). */
  const [linkFlash, setLinkFlash] = useState(false);
  const linkFlashTimer = useRef<number | null>(null);
  /** Одноразовость ?coat=: ре-раны эффекта (StrictMode) не пересобирают. */
  const linkAppliedRef = useRef(false);

  // подсветка ссылки гаснет сама — таймер чистим на выходе
  useEffect(
    () => () => {
      if (linkFlashTimer.current) window.clearTimeout(linkFlashTimer.current);
    },
    [],
  );

  /** #84/в3: код из одноразовой ссылки ?coat= (конструктор KNS): поле
   *  заполняется, превью собирается САМО тем же конвейером, что и кнопка
   *  «Создать окрас» (валидация — движком parseCatwarCode после ленивой
   *  загрузки; до неё ничего не рисуем). Битый код → тост как при ручной
   *  вставке. Сохранения НЕТ: только кнопка — лимит 5/час не выжигается
   *  фактом открытия ссылки. Ссылка одноразовая: адрес вычищен раньше. */
  useEffect(() => {
    if (!coatLink || linkAppliedRef.current) return;
    linkAppliedRef.current = true;
    (async () => {
      setCode(coatLink);
      setRendering(true);
      try {
        const mod = await import('@/lib/paint/catwar-coat');
        const cv = canvasRef.current;
        if (!cv) throw new Error('engine_unavailable');
        const res = await mod.drawCatwarPreview(cv, coatLink);
        if (!res.ok) {
          onFail(catwarFailText(res.reason));
          return;
        }
        setPayload({ w: res.width, h: res.height });
        onLinkApplied?.();
        setLinkFlash(true);
        if (linkFlashTimer.current) window.clearTimeout(linkFlashTimer.current);
        linkFlashTimer.current = window.setTimeout(() => setLinkFlash(false), 6000);
      } catch {
        onFail(catwarFailText('engine_unavailable'));
      } finally {
        setRendering(false);
      }
    })();
  }, [coatLink, onFail, onLinkApplied]);

  /** Превью устаревает при любой правке кода — собираем заново по кнопке. */
  const onCodeChange = useCallback((next: string) => {
    setCode(next);
    setPayload(null);
  }, []);

  /** «Создать окрас»: код → движок → канва-превью (якорь низ-центр). */
  const makeCoat = useCallback(async () => {
    if (rendering || busy) return;
    if (!code.trim()) return;
    setRendering(true);
    try {
      const mod = await import('@/lib/paint/catwar-coat');
      const cv = canvasRef.current;
      if (!cv) throw new Error('engine_unavailable');
      const res = await mod.drawCatwarPreview(cv, code);
      if (!res.ok) {
        onFail(catwarFailText(res.reason));
        return;
      }
      setPayload({ w: res.width, h: res.height });
    } catch {
      onFail(catwarFailText('engine_unavailable'));
    } finally {
      setRendering(false);
    }
  }, [code, rendering, busy, onFail]);

  /** Сохранение: тот же POST /sprites/mine (серверные лимиты не дублируем);
   *  «надеть» — плюс PATCH /profiles/me и переход по deep-link. */
  const save = useCallback(
    async (mode: 'mine' | 'wear') => {
      if (!payload || busy || rendering) return;
      const name = coatName.replace(/\s+/g, ' ').trim();
      if (name.length < 2 || name.length > 24) {
        onFail('Имя окраса: 2–24 символа.');
        return;
      }
      setBusy(true);
      try {
        const mod = await import('@/lib/paint/catwar-coat');
        const png = await mod.catwarCoatPng(code);
        const file = new File([png.blob], 'catwar-coat.png', { type: 'image/png' });
        const up = await httpUploadMineSprite(file, name);
        if (!up.ok) {
          const err = up as MineError;
          const worn = err.wornBy || [];
          onFail(
            humanMineError(err.reason, 'Сохранить не удалось.'),
            err.message ||
              (worn.length ? `Одет у: ${worn.map((w) => `${w.login} (${w.character})`).join(', ')}` : undefined),
          );
          return;
        }
        const spriteId = up.sprite?.id ?? '';
        const okText = up.dedup
          ? 'Такая картинка уже была загружена — показываем существующий окрас.'
          : 'Окрас из кода собран и сохранён — он в «Мои окрасы».';
        if (mode === 'mine' || !spriteId) {
          if (!spriteId) {
            onFail('Окрас сохранился, но не читается из списка — обновите страницу.');
            return;
          }
          onSaved(spriteId, okText);
          return;
        }
        // «Сохранить и надеть»: внешность активного персонажа — PATCH /profiles/me
        const patch = await httpPatchProfile({ sprite: spriteId });
        if (!patch.ok) {
          onSaved(spriteId, 'Окрас сохранён в «Мои окрасы», но надеть не вышло — надеть можно плиткой в профиле.');
          return;
        }
        const idPart = selfAccountId ? `id=${encodeURIComponent(selfAccountId)}&` : '';
        window.location.assign(`/players/?${idPart}mine=${encodeURIComponent(spriteId)}#settings`);
      } catch {
        onFail('Не получилось сохранить окрас — обновите страницу и попробуйте ещё раз.');
      } finally {
        setBusy(false);
      }
    },
    [payload, busy, rendering, coatName, code, onSaved, onFail, selfAccountId],
  );

  return (
    // ?coat=-ссылка на несколько секунд подсвечивает весь блок «по коду» —
    // тем же акцентом, что плитка свежего окраса (видно, куда смотреть)
    <div
      className={`mt-3 rounded-md border bg-[var(--sim-inset-strong)] p-2 transition-shadow ${
        linkFlash
          ? 'border-[var(--sim-accent-hover)] shadow-[0_0_0_2px_var(--sim-accent)]'
          : 'border-[var(--sim-line-strong)]'
      }`}
    >
      <p className="text-[11px] font-semibold text-[var(--sim-text-soft)]">Или собрать окрас по коду CatWar</p>
      <p className="mt-0.5 text-[10px] text-[var(--sim-text-faint)]">
        Скопируйте код окраса из конструктора на kns.miew.ru — покрасятся основные зоны окраса (шёрстка, хвост, уши).
      </p>
      <textarea
        className="mt-1.5 w-full resize-y rounded-md border border-[var(--sim-line)] bg-black/20 p-2 font-mono text-[11px] leading-4 text-[var(--sim-text)] outline-none focus-visible:border-[var(--sim-line-hover)]"
        rows={2}
        value={code}
        spellCheck={false}
        placeholder={CATWAR_EXAMPLE}
        onChange={(e) => onCodeChange(e.target.value)}
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          className="h-8 bg-[var(--sim-accent)] text-xs text-black hover:bg-[var(--sim-accent-hover)]"
          disabled={rendering || busy || !code.trim()}
          onClick={() => void makeCoat()}
        >
          {rendering ? 'Собираем котика…' : 'Создать окрас'}
        </Button>
        {payload ? (
          <span className="text-[10px] text-[var(--sim-text-faint)]">
            Готово: {payload.w}×{payload.h} px — сохраните, как вам нужно.
          </span>
        ) : null}
      </div>
      {/* канва монтируется заранее (реф нужен первому клику), до
          готового превью вся секция скрыта классом 'hidden' ниже */}
      <div className={payload ? 'mt-2 flex flex-wrap items-end gap-3' : 'hidden'}>
        <canvas
          ref={canvasRef}
          width={PREVIEW_W}
          height={PREVIEW_H}
          className="h-auto w-full max-w-[220px] rounded-md border border-[var(--sim-line)] bg-black/25"
        />
        <div className="flex min-w-[180px] flex-1 flex-col gap-1.5">
          <Input
            className="h-8 text-xs"
            value={coatName}
            maxLength={24}
            placeholder="Имя окраса (2–24)"
            onChange={(e) => setCoatName(e.target.value)}
          />
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              className="h-8 bg-[var(--sim-accent)] text-xs text-black hover:bg-[var(--sim-accent-hover)]"
              disabled={busy || rendering}
              onClick={() => void save('mine')}
            >
              {busy ? 'Сохраняем…' : 'Сохранить в Мои'}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 bg-[var(--sim-accent)] text-xs text-black hover:bg-[var(--sim-accent-hover)]"
              disabled={busy || rendering}
              onClick={() => void save('wear')}
            >
              Сохранить и надеть
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

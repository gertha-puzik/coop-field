'use client';

/**
 * Каталог игроков (/players) — P4, только elyria-вариант. Маршрут вырезается
 * prune-export-ом из grotto-сборки, а на случай случайной сборки гейтимся
 * инлайном (const IS_ELYRIA — спек §2A: свёртка ветки сборщиком).
 *
 * Данные — публичные HTTP-профили (server/profiles.js):
 *   GET /profiles — карточки каталога; deep-link /players?id=<accountId>
 *   открывает карточку напрямую (GET /profiles/:id, если её нет в списке).
 * Своя карточка при активной сессии — инлайн-редактирование displayName/bio/
 * avatarCharacterId через PATCH /profiles/me с перечиткой GET /profiles/me;
 * ошибки сервера показываются целиком, без молчаливых no-op.
 */

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  httpMe,
  httpMyProfile,
  httpPatchProfile,
  httpProfileById,
  httpProfileCatalog,
  type ProfileCard,
  type ProfileCharacter,
  type PublicProfile,
} from '@/lib/net/http-auth';
import type { CoopWhoami } from '@/lib/net/protocol';

const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria';

const NAME_MAX = 24;
const BIO_MAX = 280;

/** Человекочитаемое пояснение к reason из ответа сервера. */
function humanError(reason: string | undefined, fallback: string): string {
  switch (reason) {
    case 'auth_required':
      return 'Нужен вход в аккаунт.';
    case 'unknown':
      return 'Игрок не найден.';
    case 'csrf':
      return 'Запрос отклонён защитой CSRF.';
    case 'invalid_body':
      return 'Запрос не читается как корректный JSON.';
    case 'empty_patch':
      return 'Нет полей для сохранения.';
    case 'offline':
      return 'Сервер недоступен.';
    default:
      return fallback;
  }
}

/** Персонаж-аватар карточки: явный avatarCharacterId → активный → первый. */
function avatarOf(card: { avatarCharacterId: string | null; characters: ProfileCharacter[]; activeCharacterId: string | null }): ProfileCharacter | null {
  if (card.avatarCharacterId) {
    const hit = card.characters.find((c) => c.id === card.avatarCharacterId);
    if (hit) return hit;
  }
  return card.characters.find((c) => c.id === card.activeCharacterId) || card.characters[0] || null;
}

function spriteUrl(char: ProfileCharacter | null): string | null {
  return char && char.sprite ? `/sprites/${char.sprite}.png` : null;
}

function joinedAt(ts: number): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleDateString('ru-RU');
  } catch {
    return '';
  }
}

/** Спрайт-аватар карточки: картинка персонажа или безликий placeholder. */
function Avatar({ card, big }: { card: ProfileCard; big?: boolean }) {
  const char = avatarOf(card);
  const url = spriteUrl(char);
  const size = big ? 120 : 72;
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] ${
        big ? 'h-[120px] w-[120px] text-4xl' : 'h-[72px] w-[72px] text-2xl'
      }`}
      aria-hidden
    >
      {url ? (
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          style={{ width: `${Math.min(120, Math.max(60, char?.size || 100))}%`, height: 'auto', imageRendering: 'pixelated' }}
        />
      ) : (
        <span>{(card.displayName || '?').slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}

/** Текст ошибки сервера, какой пришёл — таким и покажем (без раскройки). */
function ServerError({ title, details }: { title: string; details?: string }) {
  return (
    <div className="rounded-lg border border-red-900/60 bg-red-950/40 p-3">
      <p className="text-sm font-semibold text-red-300">{title}</p>
      {details ? (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2 text-[11px] text-red-200">
          {details}
        </pre>
      ) : null}
    </div>
  );
}

/* ============================ инлайн-редактор ============================ */

/** Форма правки своей карточки: displayName/bio/avatar. Сохранение — PATCH
 * /profiles/me, после него — обязательная перечитка GET /profiles/me. */
function OwnProfileEditor({
  profile,
  onSaved,
}: {
  profile: PublicProfile;
  onSaved: (fresh: PublicProfile) => void;
}) {
  const [draftName, setDraftName] = useState(profile.displayName);
  const [draftBio, setDraftBio] = useState(profile.bio);
  const [draftAvatar, setDraftAvatar] = useState<string>(profile.avatarCharacterId || '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [fail, setFail] = useState<{ title: string; details?: string } | null>(null);

  useEffect(() => {
    setDraftName(profile.displayName);
    setDraftBio(profile.bio);
    setDraftAvatar(profile.avatarCharacterId || '');
  }, [profile]);

  const save = async () => {
    setFail(null);
    const name = draftName.replace(/\s+/g, ' ').trim();
    if (!name) {
      setFail({ title: 'Имя не может быть пустым (1–24 символа).' });
      return;
    }
    setBusy(true);
    const res = await httpPatchProfile({
      displayName: name,
      bio: draftBio.trim(),
      avatarCharacterId: draftAvatar || null,
    });
    if (!res.ok) {
      setFail({ title: humanError(res.reason, 'Не получилось сохранить.'), details: res.details || undefined });
      setBusy(false);
      return;
    }
    // Перечитка своим GET /profiles/me: свежий источник правды после PATCH.
    const fresh = await httpMyProfile();
    setBusy(false);
    if (fresh.ok && fresh.profile) {
      onSaved(fresh.profile);
      setNote('Сохранено.');
      window.setTimeout(() => setNote(null), 2500);
    } else {
      setFail({
        title: humanError(fresh.reason, 'Изменения сохранились, но свежий профиль не прочитался — обновите страницу.'),
      });
    }
  };

  return (
    <form
      className="mt-3 space-y-3 border-t border-[var(--sim-line)] pt-3"
      onSubmit={(ev) => {
        ev.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap gap-3">
        <label className="block min-w-56 flex-1">
          <span className="block text-[11px] text-[var(--sim-text-faint)]">Имя (до {NAME_MAX} символов)</span>
          <Input
            className="mt-1 h-8 text-sm"
            value={draftName}
            maxLength={NAME_MAX}
            onChange={(e) => setDraftName(e.target.value)}
          />
        </label>
        <label className="block min-w-44 flex-1">
          <span className="block text-[11px] text-[var(--sim-text-faint)]">Аватар (персонаж)</span>
          <select
            className="mt-1 h-8 w-full rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] px-2 text-sm text-[var(--sim-text)]"
            value={draftAvatar}
            onChange={(e) => setDraftAvatar(e.target.value)}
          >
            <option value="">Без аватара</option>
            {profile.characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block">
        <span className="block text-[11px] text-[var(--sim-text-faint)]">О себе (до {BIO_MAX} символов)</span>
        <textarea
          className="mt-1 min-h-20 w-full rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-2 text-sm text-[var(--sim-text)] outline-none focus-visible:border-[var(--sim-line-hover)]"
          value={draftBio}
          maxLength={BIO_MAX}
          onChange={(e) => setDraftBio(e.target.value)}
        />
      </label>
      <div className="flex items-center gap-3">
        <Button
          type="submit"
          size="sm"
          className="h-8 bg-[var(--sim-accent)] text-xs text-black hover:bg-[var(--sim-accent-hover)]"
          disabled={busy}
        >
          {busy ? 'Сохраняем…' : 'Сохранить'}
        </Button>
        {note ? <span className="text-xs font-semibold text-emerald-400">{note}</span> : null}
      </div>
      {fail ? <ServerError title={fail.title} details={fail.details} /> : null}
    </form>
  );
}

/* ============================ карточка/фокус ============================ */

/** Карточка каталога (компакт): аватар, имя, кусок bio. */
function CatalogCardView({ card, selected, onOpen }: { card: ProfileCard; selected: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
        selected
          ? 'border-[var(--sim-accent)] bg-[var(--sim-panel)]'
          : 'border-[var(--sim-line-strong)] bg-[var(--sim-panel)] hover:border-[var(--sim-line-hover)]'
      }`}
    >
      <Avatar card={card} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold text-[var(--sim-text)]">{card.displayName || 'Безымянный'}</span>
        <span className="mt-0.5 block truncate text-xs text-[var(--sim-text-soft)]">
          {card.bio ? card.bio : 'Пока ничего не рассказал о себе.'}
        </span>
        <span className="mt-0.5 block text-[11px] text-[var(--sim-text-faint)]">
          {card.characters.length > 0 ? `Персонажей: ${card.characters.length}` : 'Без персонажей'}
        </span>
      </span>
    </button>
  );
}

/** Развёрнутая карточка: публичные поля, своё — с редактором. */
function FocusCardView({
  card,
  mine,
  myProfile,
  onSaved,
  onClose,
}: {
  card: ProfileCard;
  mine: boolean;
  myProfile: PublicProfile | null;
  onSaved: (fresh: PublicProfile) => void;
  onClose: () => void;
}) {
  const when = joinedAt(card.createdAt);
  return (
    <section className="rounded-xl border border-[var(--sim-accent)] bg-[var(--sim-panel)] p-4">
      <div className="flex items-start gap-4">
        <Avatar card={card} big />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-[var(--sim-text)]">{card.displayName || 'Безымянный'}</h2>
          {when ? <p className="text-xs text-[var(--sim-text-faint)]">Здесь с {when}</p> : null}
          <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--sim-text-soft)]">
            {card.bio || 'Пока ничего не рассказал о себе.'}
          </p>
          {card.characters.length ? (
            <p className="mt-2 text-xs text-[var(--sim-text-faint)]">
              Персонажи: {card.characters.map((c) => c.name).join(', ')}
            </p>
          ) : null}
        </div>
        <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={onClose}>
          К списку
        </Button>
      </div>
      {mine && myProfile ? (
        <OwnProfileEditor profile={myProfile} onSaved={onSaved} />
      ) : null}
    </section>
  );
}

/* ================================ страница ================================ */

export default function PlayersCatalog() {
  const [session, setSession] = useState<CoopWhoami | null>(null);
  const [cards, setCards] = useState<ProfileCard[] | null>(null);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [focused, setFocused] = useState<ProfileCard | null>(null);
  const [focusMissing, setFocusMissing] = useState<string | null>(null);
  const [myProfile, setMyProfile] = useState<PublicProfile | null>(null);

  /** Глубокая ссылка ?id=<accountId>: карточку ищем в каталоге, иначе тянем
   *  поштучно GET /profiles/:id (в т.ч. когда каталог не догрузился). */
  useEffect(() => {
    if (!IS_ELYRIA) return;
    let dead = false;
    (async () => {
      let wantId: string | null = null;
      try {
        wantId = new URLSearchParams(window.location.search).get('id') || null;
      } catch {
        wantId = null;
      }
      const list = await httpProfileCatalog();
      if (dead) return;
      if (!list.ok) {
        setCardsError(humanError(list.reason, 'Каталог не загрузился.'));
      } else {
        setCards(list.items);
        const hit = wantId ? list.items.find((c) => c.accountId === wantId) : null;
        if (wantId) {
          if (hit) {
            setFocused(hit);
          } else {
            const one = await httpProfileById(wantId);
            if (dead) return;
            if (one.ok && one.card) setFocused(one.card);
            else setFocusMissing(humanError(one.reason, 'Игрок не найден.'));
          }
        }
      }
      const me = await httpMe();
      if (dead) return;
      setSession(me);
      if (me.ok && me.accountId) {
        const mine = await httpMyProfile();
        if (dead) return;
        if (mine.ok && mine.profile) setMyProfile(mine.profile);
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

  const openCard = useCallback((card: ProfileCard) => {
    setFocused(card);
    setFocusMissing(null);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('id', card.accountId);
      window.history.replaceState(null, '', url);
    } catch {
      /* deep-link в адресе — удобство, не критерий */
    }
  }, []);

  const closeCard = useCallback(() => {
    setFocused(null);
    setFocusMissing(null);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('id');
      window.history.replaceState(null, '', url);
    } catch {
      /* без адреса — просто закрываем */
    }
  }, []);

  /** PATCH прошёл: свежий /profiles/me + перерисовка карточки в каталоге. */
  const handleSaved = useCallback(
    (fresh: PublicProfile) => {
      setMyProfile(fresh);
      setCards((prev) => {
        if (!prev) return prev;
        const me = session?.accountId;
        return prev.map((c) =>
          me && c.accountId === me ? { ...c, displayName: fresh.displayName, bio: fresh.bio, avatarCharacterId: fresh.avatarCharacterId } : c,
        );
      });
      setFocused((prev) =>
        prev && session?.accountId && prev.accountId === session.accountId
          ? { ...prev, displayName: fresh.displayName, bio: fresh.bio, avatarCharacterId: fresh.avatarCharacterId }
          : prev,
      );
    },
    [session],
  );

  if (!IS_ELYRIA) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-6 text-[var(--sim-text-soft)]">
        <p>Страница недоступна в этом варианте сайта.</p>
      </main>
    );
  }

  const me = session?.ok ? session : null;
  const focusedMine = !!(me?.accountId && focused?.accountId === me.accountId);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex items-baseline justify-between gap-3">
        <h1 className="text-xl font-bold text-[var(--sim-text)]">Игроки</h1>
        <a className="text-sm text-[var(--sim-text-soft)] underline-offset-2 hover:underline" href="/">
          ← Главное меню
        </a>
      </header>

      {cardsError ? <ServerError title={cardsError} /> : null}
      {focusMissing ? <ServerError title={focusMissing} /> : null}

      {focused ? (
        <FocusCardView
          card={focused}
          mine={focusedMine}
          myProfile={myProfile}
          onSaved={handleSaved}
          onClose={closeCard}
        />
      ) : null}

      {cards === null && !cardsError ? (
        <p className="text-sm text-[var(--sim-text-soft)]">Загружаем каталог…</p>
      ) : null}
      {cards && cards.length === 0 && !cardsError ? (
        <p className="text-sm text-[var(--sim-text-soft)]">
          Пока ни одной публичной карточки. Зарегистрируйся и расскажи о себе — карточка появится здесь.
        </p>
      ) : null}
      {cards && cards.length ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {cards.map((card) => (
            <CatalogCardView
              key={card.accountId}
              card={card}
              selected={focused?.accountId === card.accountId}
              onOpen={() => openCard(card)}
            />
          ))}
        </div>
      ) : null}
    </main>
  );
}

'use client';

/**
 * Кликабельная зона доски на фоне главной + модалка «Что нового?».
 * Записки грузятся с GET /cfg/news (общий room-сервер); при офлайне —
 * короткий локальный фолбэк без маркеров закрытой зоны.
 */

import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';

import { httpHomeNews, type HomeNewsItem } from '@/lib/net/http-home-news';

const FALLBACK: readonly HomeNewsItem[] = [
  {
    id: 'local-1',
    title: 'Добро пожаловать',
    body: 'На доске появляются короткие новости о поле и меню.',
    pinned: false,
  },
  {
    id: 'local-2',
    title: 'Следы лап',
    body: 'Проведи курсором по ночному полю — останутся лапки.',
    pinned: false,
  },
];

/** Hotspot доски + модалка новостей (стиль ночной доски). */
export function WanderNewsHotspot() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<HomeNewsItem[]>([...FALLBACK]);
  const titleId = useId();

  useEffect(() => {
    let dead = false;
    void httpHomeNews().then((res) => {
      if (dead || !res.ok || !res.items.length) return;
      setItems(res.items);
    });
    return () => {
      dead = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Модалка через portal на body: hotspot живёт в .wander-home-art (z=0),
  // а окна миров — в .wander-stage (z=2); без portal диалог оказывается под карточками.
  const modal =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="wander-news-scrim"
            role="presentation"
            onClick={() => setOpen(false)}
          >
            <div
              className="wander-news-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              onClick={(ev) => ev.stopPropagation()}
            >
              <header className="wander-news-head">
                <h2 id={titleId}>Что нового?</h2>
                <button
                  type="button"
                  className="wander-news-close"
                  aria-label="Закрыть"
                  onClick={() => setOpen(false)}
                >
                  ×
                </button>
              </header>
              <ul className="wander-news-list">
                {items.map((note) => (
                  <li
                    key={note.id}
                    className={note.pinned ? 'wander-news-card wander-news-card-pinned' : 'wander-news-card'}
                  >
                    <strong>
                      {note.pinned ? <span className="wander-news-pin">Закреплено</span> : null}
                      {note.title}
                    </strong>
                    {/* body уже санитизирован сервером (b/i/u/br/span.news-size-*). */}
                    <div
                      className="wander-news-body"
                      dangerouslySetInnerHTML={{ __html: note.body }}
                    />
                  </li>
                ))}
              </ul>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        type="button"
        className="wander-board-hotspot"
        aria-label="Что нового? Открыть новости"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      />
      {modal}
    </>
  );
}

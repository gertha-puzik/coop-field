'use client';

import { useEffect, useState, type ReactNode } from 'react';

import { StarBackdrop } from '@/components/menu/star-backdrop';

import styles from './game-boot.module.css';

/**
 * Первый кадр /game/: ночной каркас на весь вьюпорт, пока страница, шрифты
 * и канвас поля не встали. Под лоадером симулятор уже монтируется, поэтому
 * смена входа на поле не мелькает. Экран выбора комнаты открывается, только
 * если стадия так и осталась входом.
 */
export function GameBoot({ children }: { children: ReactNode }) {
  const [hold, setHold] = useState(true);
  useEffect(() => {
    let gone = false;
    let entryTimer = 0;
    const finish = () => {
      if (gone) return;
      gone = true;
      setHold(false);
    };
    const onBoot = (ev: Event) => {
      const detail = (ev as CustomEvent<string>).detail;
      void document.fonts.ready.then(() => {
        if (gone) return;
        if (detail === 'field') {
          window.clearTimeout(entryTimer);
          finish();
          return;
        }
        window.clearTimeout(entryTimer);
        entryTimer = window.setTimeout(() => {
          if (document.documentElement.dataset.coopBoot === 'entry') finish();
        }, 700);
      });
    };
    window.addEventListener('coop:boot', onBoot);
    return () => {
      gone = true;
      window.clearTimeout(entryTimer);
      window.removeEventListener('coop:boot', onBoot);
    };
  }, []);
  return (
    <>
      {children}
      {hold ? (
        <div className={styles.cover} role="status" aria-live="polite" aria-label="Собираем поле">
          <StarBackdrop />
          <div className={styles.panel}>
            <span className={styles.bar} />
            <span className={styles.field} />
            <span className={styles.barShort} />
          </div>
          <p className={styles.caption}>Поле собирается</p>
        </div>
      ) : null}
    </>
  );
}

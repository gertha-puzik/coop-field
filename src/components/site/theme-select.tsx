'use client';

import { useEffect, useState } from 'react';

import { Dropdown } from '@/components/ui';

import { applyTheme, loadTheme, subscribeTheme, THEMES, type ThemeId } from '@/lib/sim/theme';
import styles from './theme-select.module.css';

/**
 * Компакт-селект темы оформления (переиспользуемый, паттерн селекта из хрома
 * симулятора chrome.tsx:163-180): label «тема» + select по THEMES.
 *
 * Логика НЕ дублируется: чтение — loadTheme(), запись — applyTheme() из
 * src/lib/sim/theme.ts (смена уведомляет всех подписчиков subscribeTheme,
 * поэтому все смонтированные компакт-селекты синхронны между собой и с
 * любым изменением темы из хрома симулятора). Анти-фликер layout.tsx не
 * тронут: атрибут на <html> до гидрации ставит он, здесь — только селект.
 *
 * Только вариант elyria (инлайн P3): в grotto-сборке условие сворачивается
 * и селект не рендерится вовсе — проверяется гейтом check:variants.
 */
const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria';

export function ThemeSelect() {
  // 'night' на первом кадре одинаково на сервере и клиенте (иначе hydration
  // mismatch): реальное значение подтягивается подпиской после монтажа.
  const [theme, setTheme] = useState<ThemeId>('night');

  useEffect(() => {
    setTheme(loadTheme());
    return subscribeTheme(setTheme);
  }, []);

  if (!IS_ELYRIA) return null;

  const change = (t: ThemeId) => {
    setTheme(t);
    applyTheme(t);
  };

  return (
    <label className={styles.themeCompact} title="Оформление интерфейса (действует на весь сайт)">
      <span>тема</span>
      <Dropdown
        value={theme}
        onChange={(v) => change(v as ThemeId)}
        options={THEMES.map((t) => ({ value: t.id, label: t.label }))}
        size="sm"
        className="w-auto"
        aria-label="Тема оформления"
      />
    </label>
  );
}

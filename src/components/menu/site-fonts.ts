import { Lilita_One } from 'next/font/google';

/**
 * Фирменный шрифт для латинских логотипов Wanderpaws/Elysiae. Подключается
 * только latin-глифами (кириллицы в нём нет): русские заголовки обязаны идти
 * системным шрифтом с весом 600. Отдельный модуль, а не повтор next/font в
 * каждом компоненте, чтобы настройки шрифта жили в одном месте.
 */
export const display = Lilita_One({ weight: '400', subsets: ['latin'], display: 'swap' });

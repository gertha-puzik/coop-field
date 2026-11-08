/**
 * Вариант сайта (P3, спек §2): вшивается при сборке через NEXT_PUBLIC_SITE
 * (build:grotto / build:elyria из P6). Дефолт — grotto: пустой/иной env =
 * публичный сайт, fail-safe — случайная сборка никогда не показывает Элизию.
 *
 * ВАЖНО (установлено при сборке): межмодульный импорт константы/функции отсюда
 * НЕ сворачивается минифаером — мёртвые ветки с текстами Элизии оставались
 * в grotto-бандле. Поэтому вариантозависимый UI-код сверяет env инлайном
 * (const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria' в самом
 * модуле) — так сборщик фолдит условие и выкидывает мёртвую ветку целиком
 * (спек §2A: ни одного упоминания Элизии в артефактах grotto).
 *
 * Этот модуль — каноническое имя варианта и хелперы для кода, которому
 * runtime-значение нужно ВНЕ React-компонентов (скрипты, сервер Node).
 */
export type SiteVariant = 'grotto' | 'elyria';

export const SITE: SiteVariant = process.env.NEXT_PUBLIC_SITE === 'elyria' ? 'elyria' : 'grotto';

/** Публичный сайт «Пивные гроты»: нет Элизии, аккаунтов и админ-вкладок. */
export function isGrotto(): boolean {
  return SITE === 'grotto';
}

/** Элизия (phainonsmilk.ru): аккаунты, вход, справочник Элизии. */
export function isElyria(): boolean {
  return SITE === 'elyria';
}

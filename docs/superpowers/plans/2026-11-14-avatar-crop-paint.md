# Аватарка: кадр + пиксели 64×64 — Implementation Plan

> Inline execution (superpowers:executing-plans). Spec: `docs/superpowers/specs/2026-11-14-avatar-crop-paint-design.md`.

**Global constraints:** только Элизии; файлы ≤ 800 строк; сервер не меняется; результат аватарки 512×512;
сетка дорисовки 64×64, масштаб ×8; гейты AGENTS.md зелёные.

**Review focus:** (1) аватарка недоступна для чтения в canvas → редактор открывается чистым листом с подсказкой, не падает;
(2) прозрачный ластик сохраняется PNG с альфой; (3) мобильная ширина — меню аватарки доступно тачем;
(4) старые unit-тесты шапки 120×40 не ломаются.

### Task 1: операции редактора под любую сетку
- `banner-paint-ops.ts`: `stamp/strokeLine/floodFill/pick` получают необязательные `w=120, h=40` последними аргументами.
- Тест `scripts/test-banner-paint.mts`: + заливка сетки 64×64 красит 4096; кисть 3 в углу (63,63) сетки 64 — 4 пикселя.

### Task 2: обобщить кадр и редактор
- `BannerCropper` → пропсы `frameW=1200, frameH=400, round=false, title='Шапка профиля'`; экспорт frameW×frameH.
- `BannerPainter` → пропсы `width=120, height=40, scale=10, initial?: () => Promise<Uint8ClampedArray|null>, eraseColor, blankColor, title, hint, baseLabel`.
- `src/components/players/avatar-pixels.ts`: `imageToPixels(url, w, h): Promise<Uint8ClampedArray|null>` (canvas, cover-кроп по центру; ошибка/taint → null).

### Task 3: меню на аватарке, убрать поле из настроек
- `profile-hero.tsx`: аватарка владельца — кнопка с меню; загрузка → кадр 512×512 round → `httpUploadAvatar(File)`; дорисовать → редактор 64×64; убрать → `httpDeleteAvatar` (второй клик).
  Колбэк `onAvatarChanged` (как `onBannerChanged`) → карточка + лента.
- `player-profile.tsx`: убрать `AvatarField` и его стейт/функции; `player-profile-ui.tsx`: удалить `AvatarField`, если больше не используется.

### Task 4: гейты, браузер, PR
- Все гейты; `build:variants` + `check:variants`; вручную на локальной Элизии: кадр, дорисовка, убрать, мобильная ширина. PR по шаблону.

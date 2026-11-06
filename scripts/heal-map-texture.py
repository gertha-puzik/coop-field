#!/usr/bin/env python3
"""
Лечение карты от «пропавших текстур»: перезаливка грунта текстурным травяным
паттерном (public/tex/grass-ground.png) вместо плоской заливки grass-1
(#72751B), оставшейся от старой миграции кисти. Фикс самой миграции уже в
клиенте (PR #29, ensureDraftPaint льёт grassPattern); этот скрипт чинит уже
испорченные карты — снимок сливают scripts/dump-vps-map.mjs и лечат им.

Что делает с map.paint (PNG base64, альфа = рисунок/берег):
  * альфа-канал не трогает — форма островка и проходимость те же;
  * alpha=255 — RGB из тайла grass-ground, оттайленного от (0,0) в натуральную
    величину (ровно так поле рисует grassPattern в src/lib/sim/textures.ts);
  * 0<alpha<255 — кромка берега, RGB = round(тайл * alpha / 255)
    (премультиплицированная кромка — при отрисовке даёт тёмный край берега);
  * alpha=0 — пиксель не трогает.

Использование:
  python3 scripts/heal-map-texture.py backups/prod-elysia-map-2026-11-06-3.json [выход.json]
  выход по умолчанию — <имя-входа без .json>-textured.json рядом с входом.

Дальше вылеченую карту ставят в комнату «тест»:
  локально:  npm start && node scripts/set-local-map.mjs вылеченая.json
  на прод:   node scripts/set-vps-map.mjs вылеченая.json
"""
import base64
import io
import json
import sys
from os import path

from PIL import Image

REPO = path.dirname(path.dirname(path.abspath(__file__)))
TILE = path.join(REPO, 'public', 'tex', 'grass-ground.png')


def heal_paint(png_b64: str) -> tuple[str, dict]:
    src = Image.open(io.BytesIO(base64.b64decode(png_b64))).convert('RGBA')
    tile = Image.open(TILE).convert('RGBA')
    tw, th = tile.size
    tp = tile.load()
    W, H = src.size
    sp = src.load()
    out_im = Image.new('RGBA', (W, H))
    dp = out_im.load()
    stats = {'opaque': 0, 'edge': 0, 'transparent': 0}
    for y in range(H):
        for x in range(W):
            r, g, b, a = sp[x, y]
            if a == 0:
                dp[x, y] = (r, g, b, 0)
                stats['transparent'] += 1
                continue
            t = tp[x % tw, y % th]
            if a == 255:
                dp[x, y] = (t[0], t[1], t[2], 255)
                stats['opaque'] += 1
            else:
                dp[x, y] = (
                    round(t[0] * a / 255),
                    round(t[1] * a / 255),
                    round(t[2] * a / 255),
                    a,
                )
                stats['edge'] += 1
    out = io.BytesIO()
    out_im.save(out, format='PNG', optimize=True)
    return base64.b64encode(out.getvalue()).decode('ascii'), stats


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit('использование: heal-map-texture.py карта.json [выход.json]')
    src_file = sys.argv[1]
    dst_file = (
        sys.argv[2]
        if len(sys.argv) > 2
        else src_file[:-5] + '-textured.json' if src_file.endswith('.json') else src_file + '-textured.json'
    )
    with open(src_file, 'r', encoding='utf-8') as f:
        m = json.load(f)
    if not m.get('paint'):
        sys.exit('в карте нет map.paint — лечить нечего (карта без кисти)')
    old_len = len(m['paint'])
    m['paint'], stats = heal_paint(m['paint'])
    with open(dst_file, 'w', encoding='utf-8') as f:
        json.dump(m, f, ensure_ascii=False, separators=(',', ':'))
    print(
        f"paint: {old_len} → {len(m['paint'])} b64-символов; "
        f"пиксели: грунт {stats['opaque']}, кромка {stats['edge']}, прозрачь {stats['transparent']}"
    )
    print('saved →', dst_file)


if __name__ == '__main__':
    main()

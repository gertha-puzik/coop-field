#!/usr/bin/env python3
"""Обработка сгенерированных котов (Громорёв, Гремучник) в игровые спрайты
100×150: кею зелёный фон, обрезаю по контенту, вписываю низ-центром
(как у остальных спрайтов котов)."""
from PIL import Image, ImageFilter
import colorsys

def key_green(im: Image.Image) -> Image.Image:
    """Убираю зелёный фон: прозрачность там, где зелень явно доминирует."""
    im = im.convert('RGBA')
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            hh, ll, ss = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            # зелёный фон: тон 70–170°, насыщенность заметная
            if 0.19 <= hh <= 0.48 and ss > 0.18 and ll > 0.12:
                px[x, y] = (r, g, b, 0)
            elif 0.19 <= hh <= 0.48 and ss > 0.10:
                # полупрозрачная кромка (зелёный отсвет на шерсти) — гасим альфу мягко
                px[x, y] = (r, g, b, max(0, 255 - int((ss - 0.10) * 1400)))
    # сглаживание кромки: лёгкий альфа-блюр, обратно только альфа
    alpha = im.getchannel('A').filter(ImageFilter.GaussianBlur(0.6))
    im.putalpha(alpha)
    return im

def fit_bottom_center(im: Image.Image, box=(100, 150)) -> Image.Image:
    bbox = im.getchannel('A').getbbox()
    im = im.crop(bbox)
    w, h = im.size
    k = min(box[0] / w, box[1] / h)
    w2, h2 = max(1, int(w * k)), max(1, int(h * k))
    im = im.resize((w2, h2), Image.LANCZOS)
    out = Image.new('RGBA', box, (0, 0, 0, 0))
    out.paste(im, ((box[0] - w2) // 2, box[1] - h2), im)
    return out

for src, dst in [('/tmp/gen_gromoryov.png', 'public/sprites/gromoryov.png'),
                 ('/tmp/gen_gremuchnik.png', 'public/sprites/gremuchnik.png')]:
    im = Image.open(src)
    sp = fit_bottom_center(key_green(im))
    sp.save(dst)
    print(dst, sp.size, 'content bbox:', sp.getchannel('A').getbbox())

#!/usr/bin/env python3
"""Новый спрайт группы «Пузик» — Пухляшшшшшшшш (готовый пиксель-арт автора).
Фон в файле уже прозрачный: кроп по контенту, вписка в 100×150 низ-центром
(LANCZOS — арт 363×229 ужимается вдвое сильнее, NEAREST рвал бы пиксели)."""
from PIL import Image
import os

UP = '/home/z/my-project/upload'
SP = os.path.join(os.path.dirname(__file__), '..', 'public', 'sprites')

im = Image.open(f'{UP}/PUKhLYaShShShShShShShSh.png').convert('RGBA')
bbox = im.getchannel('A').getbbox()
im = im.crop(bbox)
w, h = im.size
k = min(100 / w, 150 / h)
w2, h2 = max(1, round(w * k)), max(1, round(h * k))
im = im.resize((w2, h2), Image.LANCZOS)
out = Image.new('RGBA', (100, 150), (0, 0, 0, 0))
out.paste(im, ((100 - w2) // 2, 150 - h2), im)
out.save(f'{SP}/puhlyashshshshshshshsh.png')
print('content', (w, h), 'k =', round(k, 4), '-> sprite bbox:', out.getchannel('A').getbbox())

# контрольный превью на зелёном
prev = Image.new('RGBA', (110, 160), (70, 110, 70, 255))
prev.paste(out, (5, 5), out)
prev.save('/tmp/puhlyash_preview.png')

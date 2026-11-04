#!/usr/bin/env python3
"""Готовые спрайты от автора:
- Гремучник/Громорёв: картинки уже 100×150 с прозрачным фоном, контент не
  доходит до низа (низ на y=131) — опускаю до y=150 без масштабирования.
- Малышочки (Рванитсе, Пухляшик-кит, Блестяшка-кит, Чистолапик-кит):
  пиксель-спрайты ~64 px высотой — кроп по контенту, низ-центр в 100×150
  в родном пиксельном размере (как Камешечек: без рескала)."""
from PIL import Image
import os

UP = '/home/z/my-project/upload'
SP = os.path.join(os.path.dirname(__file__), '..', 'public', 'sprites')

def shift_to_bottom(src: str, dst: str) -> None:
    im = Image.open(src).convert('RGBA')
    w, h = im.size
    bbox = im.getchannel('A').getbbox()
    bottom = 150 - bbox[3]
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    out.paste(im, (0, bottom), im)
    out.save(dst)
    print(dst, out.size, 'shifted down by', bottom, 'new bbox:', out.getchannel('A').getbbox())

def fit_bottom_center(src: str, dst: str) -> None:
    im = Image.open(src).convert('RGBA')
    bbox = im.getchannel('A').getbbox()
    im = im.crop(bbox)
    w, h = im.size
    assert w <= 100 and h <= 150, (src, w, h)
    out = Image.new('RGBA', (100, 150), (0, 0, 0, 0))
    out.paste(im, ((100 - w) // 2, 150 - h), im)
    out.save(dst)
    print(dst, out.size, 'content', (w, h), 'bbox:', out.getchannel('A').getbbox())

# Ряща: готовые коты (Громорёв — чёрно-белый «смокинг», Гремучник — второй).
# Имена поменяны по просьбе автора: сначала файлы были назначены наоборот.
shift_to_bottom(f'{UP}/zagruzheno_1.png', f'{SP}/gromoryov.png')
shift_to_bottom(f'{UP}/6ac8fcabf0cb2111.png', f'{SP}/gremuchnik.png')

# Малышочки: готовые пиксель-спрайты (родной размер, низ-центр)
fit_bottom_center(f'{UP}/Rvanitse.png', f'{SP}/rvanitse.png')
fit_bottom_center(f'{UP}/Pukhlyashik.png', f'{SP}/puhlyashik-kit.png')
fit_bottom_center(f'{UP}/Blestyashka.png', f'{SP}/blestyashka-kit.png')
fit_bottom_center(f'{UP}/Chistolapik-kit.png', f'{SP}/chistolapik-kit.png')

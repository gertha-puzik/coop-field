#!/usr/bin/env python3
"""Нарезка спрайтов пака «Pixel Art Top Down - Basic v1.2.3» (Cainos, CC0)
в public/tex репозитория coop-field.

Нарезает:
  - 3 дерева из TX Plant.png (tree-1..tree-3, нативный размер, как старый tree.png);
  - 10 камней из TX Props.png (валун, ряд по возрастанию, 3 плоских камня);
  - покрытия земли 16×16 из тайлсетов травы и каменного пола, ×3 NEAREST (48 px,
    как grass-ground.png) с автоотбором тайлов по содержимому (цветы/плитка/трава).

После нарезки собирает contact-sheet с подписями для визуальной проверки.
"""
from PIL import Image, ImageDraw
import os

PACK = '/home/z/my-project/upload/pack/Texture'
OUT = '/home/z/my-project/coop-field/public/tex'
os.makedirs(OUT, exist_ok=True)

# ---------- деревья ----------
plant = Image.open(f'{PACK}/TX Plant.png').convert('RGBA')
TREES = {
    'tree-1': (24, 12, 138, 156),
    'tree-2': (156, 12, 258, 156),
    'tree-3': (294, 30, 378, 156),
}

# ---------- камни ----------
props = Image.open(f'{PACK}/TX Props.png').convert('RGBA')
ROCKS = {
    'rock-1': (3, 430, 60, 472),    # валун (как старый rock.png)
    'rock-2': (10, 492, 21, 502),   # булышка
    'rock-3': (40, 489, 56, 504),
    'rock-4': (68, 486, 92, 506),
    'rock-5': (100, 486, 124, 506),
    'rock-6': (130, 483, 157, 506),
    'rock-7': (162, 481, 189, 509),
    'rock-8': (231, 489, 249, 505),  # плоские камни-ступени
    'rock-9': (263, 488, 282, 504),
    'rock-10': (289, 486, 320, 505),
}

# ---------- автоотбор тайлов покрытий ----------
def tile_at(im, tx, ty, ts=16):
    return im.crop((tx * ts, ty * ts, (tx + 1) * ts, (ty + 1) * ts))

def classify(tile):
    px = tile.load()
    flower = slab = 0
    for y in range(tile.height):
        for x in range(tile.width):
            r, g, b, a = px[x, y]
            if a < 200:
                continue
            if r > 215 and g > 205 and b > 165 and not (abs(r-g) < 10 and abs(g-b) < 10):
                flower += 1
            elif r > 190 and 110 < g < 195 and b < 120:
                flower += 1
            mx, mn = max(r, g, b), min(r, g, b)
            if mx - mn < 26 and 105 < r < 215:
                slab += 1
    return flower, slab

grass = Image.open(f'{PACK}/TX Tileset Grass.png').convert('RGBA')
stats = []
for ty in range(16):
    for tx in range(16):
        f, s = classify(tile_at(grass, tx, ty))
        stats.append((tx, ty, f, s))
flowers = sorted([t for t in stats if t[2] >= 14], key=lambda t: (-t[2], t[0], t[1]))
slabs = sorted([t for t in stats if t[3] >= 40 and t[2] < 10], key=lambda t: (t[3], t[0], t[1]))
plains = sorted([t for t in stats if t[2] < 3 and t[3] < 8], key=lambda t: (t[0], t[1]))
# разносим выбранные тайлы по листу (не соседние)
def spread(cands, n):
    out = []
    for t in cands:
        if all(abs(t[0]-u[0]) + abs(t[1]-u[1]) >= 2 for u in out):
            out.append(t)
        if len(out) == n:
            break
    for t in cands:  # добор без разноса
        if len(out) == n:
            break
        if t not in out:
            out.append(t)
    return out

COVERS = {}
sel_plains = spread(plains, 2)
for i, (tx, ty, *_ ) in enumerate(sel_plains):
    COVERS[f'grass-{i+1}'] = (tx, ty)
sel_flowers = spread(flowers, 4)
for i, (tx, ty, *_ ) in enumerate(sel_flowers):
    COVERS[f'flower-{i+1}'] = (tx, ty)
sel_slabs = spread(slabs, 4)
for i, (tx, ty, *_ ) in enumerate(sel_slabs):
    COVERS[f'slab-{i+1}'] = (tx, ty)

stone = Image.open(f'{PACK}/TX Tileset Stone Ground.png').convert('RGBA')
# сплошной каменный пол: три чистых квадрата 32×32 без переходных кромок
# (проверено сканером коричневых линий; floor-3 — плита с «заклёпками»)
FLOORS = {'floor-1': (8, 8), 'floor-2': (56, 24), 'floor-3': (184, 8)}

# ---------- нарезка ----------
def trim(im):
    bbox = im.getchannel('A').getbbox()
    return im.crop(bbox) if bbox else im

saved = []
for name, box in TREES.items():
    trim(plant.crop(box)).save(f'{OUT}/{name}.png')
    saved.append(name)
for name, box in ROCKS.items():
    trim(props.crop(box)).save(f'{OUT}/{name}.png')
    saved.append(name)

SC = 3  # тайлы ×3 NEAREST → 48 px мира
for name, (tx, ty) in COVERS.items():
    t = tile_at(grass, tx, ty).resize((16*SC, 16*SC), Image.NEAREST)
    t.save(f'{OUT}/{name}.png')
    saved.append(name)
for name, (tx, ty) in FLOORS.items():
    t = stone.crop((tx*16, ty*16, tx*16+32, ty*16+32)).resize((32*SC, 32*SC), Image.NEAREST)
    t.save(f'{OUT}/{name}.png')
    saved.append(name)

print('saved:', len(saved), 'files')
for n in saved:
    im = Image.open(f'{OUT}/{n}.png')
    print(f'  {n}.png {im.size}')

# ---------- контактный лист ----------
cols = 8
cell = 150
rows = (len(saved) + cols - 1) // cols
sheet = Image.new('RGBA', (cols*cell, rows*(cell+16)), (40, 44, 38, 255))
dr = ImageDraw.Draw(sheet)
for i, n in enumerate(saved):
    im = Image.open(f'{OUT}/{n}.png')
    k = min((cell-10)/im.width, (cell-10)/im.height, 3.0)
    im2 = im.resize((max(1,int(im.width*k)), max(1,int(im.height*k))), Image.NEAREST if k >= 2 else Image.LANCZOS)
    cx, cy = (i % cols)*cell, (i // cols)*(cell+16)
    sheet.paste(im2, (cx + (cell-im2.width)//2, cy + (cell-im2.height)//2), im2)
    dr.text((cx+4, cy+cell+2), n, fill=(240, 240, 220, 255))
sheet.convert('RGB').save('/home/z/my-project/scripts/pack_sheet.png')
print('sheet -> scripts/pack_sheet.png')

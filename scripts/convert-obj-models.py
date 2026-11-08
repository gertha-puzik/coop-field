#!/usr/bin/env python3
"""Convert the two supplied OBJ sources to self-contained, Y-up, flat-shaded GLB assets.

No MTL files were supplied. Colors below are explicit fallback materials, not the
original author's missing texture. Each numbered tree is centered independently;
models are normalized to height 1, with their original relative size in catalog.json.
Run from the repository root: python scripts/convert-obj-models.py
"""
import hashlib
import json
import math
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/models/source'
OUTPUT = ROOT / 'public/models'


def read_obj(file):
    vertices, groups, current = [], {}, 'default'
    for line in file.read_text().splitlines():
        words = line.split()
        if not words:
            continue
        if words[0] == 'v':
            vertices.append(tuple(map(float, words[1:4])))
        elif words[0] == 'o':
            current = words[1]
        elif words[0] == 'f':
            polygon = []
            for word in words[1:]:
                index = int(word.split('/')[0])
                polygon.append(index - 1 if index > 0 else len(vertices) + index)
            faces = groups.setdefault(current, [])
            for i in range(1, len(polygon) - 1):
                faces.append((polygon[0], polygon[i], polygon[i + 1]))
    return vertices, groups


def glb(file, points, faces, tree, seed):
    used = [points[i] for face in faces for i in face]
    low = [min(p[i] for p in used) for i in range(3)]
    high = [max(p[i] for p in used) for i in range(3)]
    height = high[1] - low[1]
    if height <= 0:
        raise ValueError(f'No vertical extent: {file}')
    origin = [(low[0] + high[0]) / 2, low[1], (low[2] + high[2]) / 2]
    if tree:
        base = [p for p in used if p[1] <= low[1] + height * 0.035]
        origin[0] = (min(p[0] for p in base) + max(p[0] for p in base)) / 2
        origin[2] = (min(p[2] for p in base) + max(p[2] for p in base)) / 2
    positions, normals, colors = [], [], []
    for face in faces:
        triangle = [tuple((points[i][j] - origin[j]) / height for j in range(3)) for i in face]
        a, b, c = triangle
        ab = [b[j] - a[j] for j in range(3)]
        ac = [c[j] - a[j] for j in range(3)]
        normal = [ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]]
        length = math.sqrt(sum(n*n for n in normal))
        if length < 1e-10:
            continue
        normal = [n / length for n in normal]
        mid = [sum(p[j] for p in triangle) / 3 for j in range(3)]
        color = [0.72, 0.77, 0.82, 1.0]
        if tree:
            trunk = mid[1] < 0.18 or (math.hypot(mid[0], mid[2]) < 0.045 and mid[1] < 0.7)
            color = [0.31, 0.16, 0.065, 1] if trunk else [0.12 + (seed % 5)*0.013, 0.35 + (seed % 7)*0.018, 0.09 + (seed % 3)*0.015, 1]
        for p in triangle:
            positions.extend(p)
            normals.extend(normal)
            colors.extend(color)
    count = len(positions) // 3
    data = bytearray()
    views, accessors = [], []
    for values, components in [(positions, 3), (normals, 3), (colors, 4)]:
        offset = len(data)
        data.extend(struct.pack('<' + 'f'*len(values), *values))
        views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(data)-offset, 'target': 34962})
        accessor = {'bufferView': len(views)-1, 'componentType': 5126, 'count': count, 'type': f'VEC{components}'}
        if len(accessors) == 0:
            accessor['min'] = [min(positions[i::3]) for i in range(3)]
            accessor['max'] = [max(positions[i::3]) for i in range(3)]
        accessors.append(accessor)
    document = {
        'asset': {'version': '2.0', 'generator': 'coop-field OBJ importer'},
        'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0, 'name': file.stem}],
        'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'NORMAL': 1, 'COLOR_0': 2}, 'material': 0}]}],
        'materials': [{'name': 'Fallback palette (MTL not supplied)', 'doubleSided': True,
                       'pbrMetallicRoughness': {'baseColorFactor': [1,1,1,1], 'metallicFactor': 0, 'roughnessFactor': 1}}],
        'buffers': [{'byteLength': len(data)}], 'bufferViews': views, 'accessors': accessors,
    }
    encoded = json.dumps(document, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    data += b'\0' * (-len(data) % 4)
    total = 12 + 8 + len(encoded) + 8 + len(data)
    file.write_bytes(struct.pack('<III', 0x46546c67, 2, total) + struct.pack('<II', len(encoded), 0x4e4f534a)
                     + encoded + struct.pack('<II', len(data), 0x004e4942) + data)
    screen_y = [positions[i+2] - positions[i+1] for i in range(0, len(positions), 3)]
    screen_size = [(high[0]-low[0])/height, max(screen_y)-min(screen_y)]
    return height, count // 3, [(high[i]-low[i])/height for i in range(3)], screen_size


def main():
    OUTPUT.mkdir(exist_ok=True)
    catalog = []
    for source_name, tree in [('ORIGAMI_Chat_Free.obj', False), ('LowPoly_Tree_Collection_01_obj.obj', True)]:
        source = SOURCE / source_name
        vertices, groups = read_obj(source)
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        for name, faces in groups.items():
            number = int(name.split('_')[0]) if tree else 0
            model_id = f'tree3d-{number:03}' if tree else 'origami-cat'
            height, triangles, size, screen_size = glb(OUTPUT / f'{model_id}.glb', vertices, faces, tree, number)
            catalog.append({'id': model_id, 'label': f'Дерево {number:03}' if tree else 'Оригами-кот',
                            'kind': 'tree' if tree else 'player', 'url': f'/models/{model_id}.glb',
                            'preview': f'/models/previews/{model_id}.png',
                            'worldHeight': round(height * 20, 2) if tree else 77,
                            'size': [round(v, 5) for v in size], 'screenSize': [round(v, 5) for v in screen_size], 'triangles': triangles,
                            'source': source_name, 'object': name, 'sourceSha256': digest})
    catalog.sort(key=lambda m: m['id'])
    (OUTPUT / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n')
    fields = ['id', 'label', 'kind', 'url', 'preview', 'worldHeight', 'size', 'screenSize']
    rows = [json.dumps({k: item[k] for k in fields}, ensure_ascii=False, separators=(',', ':')) for item in catalog]
    typescript = "/** Generated by scripts/convert-obj-models.py; geometry lives in public/models. */\n"
    typescript += "export type ModelInfo = { id: string; label: string; kind: 'tree' | 'player'; url: string; preview: string; worldHeight: number; size: number[]; screenSize: number[] };\n"
    typescript += "export const MODEL_CATALOG: ModelInfo[] = [\n  " + ",\n  ".join(rows) + "\n];\n"
    typescript += "export const PLAYER_MODEL_ID = 'origami-cat';\nexport const TREE_MODELS = MODEL_CATALOG.filter((model) => model.kind === 'tree');\nexport const TREE_MODEL_OPTS = TREE_MODELS.map((model) => ({ id: model.id, label: model.label }));\nexport const MODEL_BY_ID = new Map(MODEL_CATALOG.map((model) => [model.id, model]));\n"
    (ROOT / 'src/lib/sim/model-catalog.ts').write_text(typescript)
    print(f'Converted {len(catalog)} models; {sum(m["triangles"] for m in catalog)} triangles')


if __name__ == '__main__':
    main()

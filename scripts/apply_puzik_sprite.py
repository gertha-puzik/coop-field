#!/usr/bin/env python3
"""Спрайт группы «Пузик» — Пухляшшшшшшшш: файл автора используется как есть,
оригинальный размер 363×229 (по решению автора НЕ вписывается в холст
100×150). Фон в файле уже прозрачный; рендер поля рисует спрайт по пропорциям
файла, так что кот на поле крупнее и шире обычных «стоячих» котов."""
import os
import shutil

UP = '/home/z/my-project/upload/PUKhLYaShShShShShShShSh.png'
SP = os.path.join(os.path.dirname(__file__), '..', 'public', 'sprites', 'puhlyashshshshshshshsh.png')
shutil.copyfile(UP, SP)
print('copied as-is:', UP, '->', SP)

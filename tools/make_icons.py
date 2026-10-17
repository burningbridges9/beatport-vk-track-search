# -*- coding: utf-8 -*-
"""Генерация иконок расширения 16/32/48/128 px.

Рисуем в 8x размере и уменьшаем — так края остаются гладкими.
Запуск:
    python tools/make_icons.py
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "extension", "icons")
SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 8
BASE = 128 * SUPERSAMPLE

MINT_TOP = (60, 255, 170)
MINT_BOTTOM = (1, 210, 120)
DARK = (4, 24, 16)


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def vertical_gradient(size, top, bottom):
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        grad.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return grad.resize((size, size))


def draw_icon():
    size = BASE
    background = vertical_gradient(size, MINT_TOP, MINT_BOTTOM)
    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = rounded_mask(size, int(size * 0.22))
    icon.paste(background, (0, 0), mask)

    draw = ImageDraw.Draw(icon)
    stroke = int(size * 0.085)
    radius = int(size * 0.215)
    cx, cy = int(size * 0.435), int(size * 0.415)

    # Лупа: кольцо + ручка.
    draw.ellipse(
        (cx - radius, cy - radius, cx + radius, cy + radius),
        outline=DARK,
        width=stroke,
    )

    handle_start = (int(cx + radius * 0.72), int(cy + radius * 0.72))
    handle_end = (int(size * 0.775), int(size * 0.775))
    draw.line([handle_start, handle_end], fill=DARK, width=stroke)
    r = stroke // 2
    for point in (handle_start, handle_end):
        draw.ellipse((point[0] - r, point[1] - r, point[0] + r, point[1] + r), fill=DARK)

    return icon


def main():
    os.makedirs(OUT, exist_ok=True)
    icon = draw_icon()
    for size in SIZES:
        resized = icon.resize((size, size), Image.LANCZOS)
        path = os.path.join(OUT, "icon%d.png" % size)
        resized.save(path, "PNG", optimize=True)
        print("written", path, resized.size)


if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""
App 图标生成（简单方案）：icon_src.png 去除黑色背景后，白底居中生成各尺寸 mipmap。
- 背景移除：从边界洪泛标记黑色背景区域（内部深色线条被白色包住，不受影响）
- 贴纸按非背景包围盒裁剪，缩放至图标边长 88%，居中放置在白色方形画布上
"""
import os
from collections import deque

from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "icon_src.png")
RES = os.path.join(ROOT, "android", "res")

SIZES = {"mipmap-mdpi": 48, "mipmap-hdpi": 72, "mipmap-xhdpi": 96,
         "mipmap-xxhdpi": 144, "mipmap-xxxhdpi": 192}

WHITE_TH = 128   # 亮度 <= 该值且与边界连通 => 背景
FIT = 0.88       # 贴纸占图标边长比例
SS = 4           # 超采样倍数


def log(*a):
    print(*a, flush=True)


def extract_sticker():
    im = Image.open(SRC).convert("RGBA")
    base = Image.new("RGBA", im.size, (0, 0, 0, 255))
    im = Image.alpha_composite(base, im)
    gray = im.convert("L")
    W, H = im.size
    lum = bytearray(gray.tobytes())

    # 洪泛：从四条边界标记背景（深色连通区）
    bg = bytearray(W * H)
    dq = deque()
    for x in range(W):
        for y in (0, H - 1):
            i = y * W + x
            if lum[i] <= WHITE_TH and not bg[i]:
                bg[i] = 1; dq.append(i)
    for y in range(H):
        for x in (0, W - 1):
            i = y * W + x
            if lum[i] <= WHITE_TH and not bg[i]:
                bg[i] = 1; dq.append(i)
    while dq:
        i = dq.popleft()
        x = i % W; y = i // W
        if x > 0:
            j = i - 1
            if not bg[j] and lum[j] <= WHITE_TH: bg[j] = 1; dq.append(j)
        if x < W - 1:
            j = i + 1
            if not bg[j] and lum[j] <= WHITE_TH: bg[j] = 1; dq.append(j)
        if y > 0:
            j = i - W
            if not bg[j] and lum[j] <= WHITE_TH: bg[j] = 1; dq.append(j)
        if y < H - 1:
            j = i + W
            if not bg[j] and lum[j] <= WHITE_TH: bg[j] = 1; dq.append(j)

    rgba = im.load()
    sticker = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    spx = sticker.load()
    minx, miny, maxx, maxy = W, H, -1, -1
    for y in range(H):
        row = y * W
        for x in range(W):
            if not bg[row + x]:
                r, g, b, _ = rgba[x, y]
                spx[x, y] = (r, g, b, 255)
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
    if maxx < 0:
        raise RuntimeError("未找到贴纸区域")
    sticker = sticker.crop((minx, miny, maxx + 1, maxy + 1))
    log("贴纸裁剪: %dx%d -> %dx%d" % (W, H, sticker.width, sticker.height))
    return sticker


def make_icon(sticker, size):
    S = size * SS
    canvas = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    k = (S * FIT) / max(sticker.width, sticker.height)
    nw = max(1, round(sticker.width * k))
    nh = max(1, round(sticker.height * k))
    st = sticker.resize((nw, nh), Image.LANCZOS)
    canvas.alpha_composite(st, ((S - nw) // 2, (S - nh) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def main():
    sticker = extract_sticker()
    for folder, size in SIZES.items():
        out_dir = os.path.join(RES, folder)
        os.makedirs(out_dir, exist_ok=True)
        make_icon(sticker, size).save(os.path.join(out_dir, "ic_launcher.png"))
        log("icon -> %s %d" % (out_dir, size))
    log("DONE")


if __name__ == "__main__":
    main()

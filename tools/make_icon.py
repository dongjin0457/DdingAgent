# -*- coding: utf-8 -*-
"""
앱 아이콘(assets/icon.ico) 생성 스크립트 (Pillow 사용)

디자인: 둥근 사각형 주황 배경 + 요리 냄비 + 냄비 위로 떨어지는 금화
작은 크기(32px 이하)에서는 뭉개지지 않도록 금화만 크게 그린 단순 버전을 사용.

사용법:
    python tools/make_icon.py          -> assets/icon.ico 생성(덮어쓰기)
"""

import os

from PIL import Image, ImageDraw

# ---------------------------------------------------------------------------
# 설정값 (색/크기를 바꾸고 싶으면 여기만 수정)
# ---------------------------------------------------------------------------

# ico 안에 넣을 크기들 (윈도우 탐색기/작업표시줄이 알아서 골라 씀)
ICON_SIZES = [16, 24, 32, 48, 64, 128, 256]

# 이 크기 이하에서는 단순 버전(금화만) 사용
SIMPLE_MAX_SIZE = 32

# 크게 그린 다음 줄여서 가장자리를 부드럽게 (안티앨리어싱 배율)
SUPERSAMPLE = 4

# 색상 (R, G, B)
BG_TOP = (255, 150, 60)      # 배경 위쪽 (밝은 주황)
BG_BOTTOM = (226, 88, 34)    # 배경 아래쪽 (진한 주황)
POT_BODY = (58, 64, 80)      # 냄비 몸통 (짙은 남색 회색)
POT_RIM = (92, 100, 122)     # 냄비 입구 테두리
POT_SHINE = (120, 130, 155)  # 냄비 하이라이트
COIN_FACE = (255, 214, 64)   # 금화 면
COIN_EDGE = (196, 138, 20)   # 금화 테두리
COIN_MARK = (170, 112, 10)   # 금화 가운데 무늬

# 결과 파일 경로 (프로젝트 루트 기준)
OUTPUT_RELATIVE = os.path.join("assets", "icon.ico")


def _background(img: Image.Image, s: int) -> None:
    """세로 그라데이션 둥근 사각형 배경."""
    radius = int(s * 0.22)
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255)
    grad = Image.new("RGBA", (s, s))
    gd = ImageDraw.Draw(grad)
    for y in range(s):
        t = y / max(1, s - 1)
        c = tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))
        gd.line([(0, y), (s, y)], fill=c + (255,))
    img.paste(grad, (0, 0), mask)


def _coin(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float) -> None:
    """금화: 테두리 원 + 면 + 가운데 세로 막대(동전 무늬)."""
    edge = max(1, int(r * 0.16))
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=COIN_EDGE)
    draw.ellipse([cx - r + edge, cy - r + edge, cx + r - edge, cy + r - edge], fill=COIN_FACE)
    # 가운데 무늬 (둥근 세로 막대)
    w = r * 0.22
    h = r * 0.95
    draw.rounded_rectangle([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], radius=w / 2, fill=COIN_MARK)


def draw_full(s: int) -> Image.Image:
    """큰 아이콘: 배경 + 냄비 + 금화."""
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    _background(img, s)

    # 냄비 손잡이 (양옆)
    hw, hh = s * 0.10, s * 0.07
    hy = s * 0.56
    d.rounded_rectangle([s * 0.12, hy, s * 0.12 + hw, hy + hh], radius=hh / 2, fill=POT_BODY)
    d.rounded_rectangle([s * 0.88 - hw, hy, s * 0.88, hy + hh], radius=hh / 2, fill=POT_BODY)

    # 냄비 몸통
    d.rounded_rectangle([s * 0.20, s * 0.50, s * 0.80, s * 0.84], radius=s * 0.09, fill=POT_BODY)
    # 냄비 입구 테두리
    d.rounded_rectangle([s * 0.16, s * 0.47, s * 0.84, s * 0.56], radius=s * 0.045, fill=POT_RIM)
    # 하이라이트
    d.rounded_rectangle([s * 0.27, s * 0.61, s * 0.33, s * 0.76], radius=s * 0.03, fill=POT_SHINE)

    # 냄비로 떨어지는 금화
    _coin(d, s * 0.50, s * 0.30, s * 0.18)
    return img


def draw_simple(s: int) -> Image.Image:
    """작은 아이콘: 배경 + 큰 금화만."""
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    _background(img, s)
    _coin(d, s * 0.5, s * 0.5, s * 0.34)
    return img


def render(size: int) -> Image.Image:
    big = size * SUPERSAMPLE
    img = draw_simple(big) if size <= SIMPLE_MAX_SIZE else draw_full(big)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, OUTPUT_RELATIVE)
    os.makedirs(os.path.dirname(out), exist_ok=True)

    frames = [render(s) for s in ICON_SIZES]
    largest = frames[-1]
    # 크기별로 따로 그린 이미지를 그대로 넣음 (append_images)
    largest.save(
        out,
        format="ICO",
        sizes=[(s, s) for s in ICON_SIZES],
        append_images=frames[:-1],
    )
    # 확인용 미리보기 PNG (빌드에는 안 쓰임)
    largest.save(os.path.join(os.path.dirname(out), "icon_preview.png"))
    print("OK:", out)


if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""
툴팁 검출 (색상 무관 / 구조 기반)

띵타이쿤 툴팁 모양 (바깥 -> 안쪽, 1칸 = GUI 픽셀 1개 = 물리 픽셀 s 개)
    [어두운 외곽선 1칸][밝은 색 테두리 1칸][어두운 선 1칸][거의 검정 반투명 판]
테두리 색은 희귀도(NORMAL=초록, COMMON=주황, ...)마다 다르고 위->아래로 그라데이션이 있으므로
특정 색을 찾지 않고 "양옆보다 확실히 밝은 얇은 세로선 2개 + 같은 색 가로선 2개로 닫힌 사각형 +
안쪽이 어두움" 이라는 구조로 찾는다.

numpy 만 사용. 2560x1600 프레임 기준 수 ms.
"""

import numpy as np

# ============================================================================
# 튜닝 상수 (바꿔도 되는 값)
# ============================================================================

# 테두리 선으로 인정할 최소 밝기 (RGB 채널 최댓값, 0~255).
# 어두운 희귀도 색이 나오면 낮추면 됨 (너무 낮추면 배경 잡음이 늘어남)
BORDER_BRIGHT_MIN = 100

# 테두리 선 양옆(외곽선/안쪽 선) 밝기가 선 밝기의 이 비율 이하여야 "얇은 밝은 선" 으로 인정
# (실측: 선 236, 양옆 79 -> 0.33)
BORDER_SIDE_RATIO = 0.6

# 테두리 선 두께(물리 픽셀)의 최대값 = 지원하는 최대 GUI 배율.
# 4K 모니터 + GUI 배율 8 이상을 쓰면 늘릴 것
BORDER_MAX_THICK = 10

# 세로 방향 샘플링 간격을 정하는 목표 행 수. 프레임 높이 / 이 값 = 간격(최소 2)
# (클수록 정확하지만 느림. 200 이면 1600px 화면에서 8px 간격)
DETECT_TARGET_ROWS = 200

# 툴팁 최소 크기 (물리 픽셀). 이보다 작은 사각형은 툴팁이 아님
TOOLTIP_MIN_W = 100
TOOLTIP_MIN_H = 70

# 좌/우 세로선의 위/아래 끝이 이 샘플 칸 수 이내로 맞아야 같은 사각형으로 봄
EDGE_ALIGN_TOL = 2

# 세로선 하나로 인정하려면 샘플 행 중 이 비율 이상이 연속으로 선이어야 함 (최장 연속 구간 기준)
# (툴팁 높이 대비가 아니라 최소 높이 TOOLTIP_MIN_H 기준으로 판정)

# 좌/우 세로선의 같은 높이 색 차이(채널 평균 절대차) 허용치. 같은 툴팁이면 거의 0
PAIR_COLOR_TOL = 30

# 위/아래 가로선: 해당 줄에서 "세로선과 같은 색" 픽셀이 차지해야 하는 비율
HEDGE_FILL_MIN = 0.90
# 가로선 색 비교 허용치 (채널별 최대 절대차)
HEDGE_COLOR_TOL = 40

# 툴팁 안쪽(테두리 제외) 평균 밝기 상한. 툴팁 배경은 거의 검정(약 15)이라 글자가 많아도 낮음
INNER_MEAN_MAX = 80
# 안쪽 픽셀 중 "어두운 배경" (밝기 < INNER_DARK_V) 비율 하한
INNER_DARK_V = 45
INNER_DARK_RATIO = 0.55


class Tooltip:
    """검출 결과.

    box   : (x0, y0, x1, y1) 색 테두리 바깥쪽 기준 박스 (x1, y1 은 미포함)
    scale : 테두리 선 두께 = GUI 배율 (물리 픽셀)
    color : 테두리 색 (위쪽 가로선의 RGB)
    """

    __slots__ = ("box", "scale", "color")

    def __init__(self, box, scale, color):
        self.box = box
        self.scale = scale
        self.color = color

    def inner_box(self):
        """테두리/안쪽 어두운 선을 제외한 내용 영역 (x0, y0, x1, y1)."""
        x0, y0, x1, y1 = self.box
        k = 2 * self.scale
        return x0 + k, y0 + k, x1 - k, y1 - k

    def to_dict(self):
        return {"box": list(self.box), "scale": self.scale, "color": list(self.color)}

    def __repr__(self):
        return "Tooltip(box=%r, scale=%d, color=%r)" % (self.box, self.scale, self.color)


def rgb_view(frame):
    """HxWx3 RGB 또는 HxWx4 BGRA 에서 (R, G, B) 채널 뷰."""
    if frame.shape[2] == 4:
        return frame[..., 2], frame[..., 1], frame[..., 0]
    return frame[..., 0], frame[..., 1], frame[..., 2]


def to_rgb(frame):
    """BGRA -> RGB 복사 (이미 RGB 면 그대로)."""
    if frame.shape[2] == 4:
        return np.ascontiguousarray(frame[..., 2::-1])
    return frame


def _value(img):
    """채널 최댓값 (밝기 근사) int16."""
    if img.shape[2] == 4:
        v = np.maximum(np.maximum(img[..., 0], img[..., 1]), img[..., 2])
    else:
        v = np.maximum(np.maximum(img[..., 0], img[..., 1]), img[..., 2])
    return v.astype(np.int16)


def _thin_runs_mask(V, max_thick):
    """각 행에서 '양옆보다 확실히 밝은, 두께 max_thick 이하의 밝은 구간' 을 True 로 표시.

    반환: (mask bool[H, W], thick int16[H, W] 구간 길이)
    """
    H, W = V.shape
    b = V >= BORDER_BRIGHT_MIN
    z = np.zeros((H, 1), np.int8)
    d = np.diff(np.concatenate([z, b.view(np.int8), z], axis=1), axis=1)
    ys, xs = np.nonzero(d == 1)          # 구간 시작 (행 우선 순서)
    _, xe = np.nonzero(d == -1)          # 구간 끝 (같은 순서로 짝지어짐)
    L = xe - xs
    ok = (L <= max_thick) & (xs > 0) & (xe < W)
    ys, xs, xe, L = ys[ok], xs[ok], xe[ok], L[ok]
    if ys.size == 0:
        return np.zeros((H, W), bool), None
    # 구간 안 최솟값 대신 시작/끝 픽셀 밝기의 작은 값 사용 (그라데이션 없는 얇은 선이라 충분)
    vin = np.minimum(V[ys, xs], V[ys, xe - 1]).astype(np.int32)
    lim = (vin * int(BORDER_SIDE_RATIO * 256)) >> 8
    ok = (V[ys, xs - 1] <= lim) & (V[ys, xe] <= lim)
    ys, xs, xe, L = ys[ok], xs[ok], xe[ok], L[ok]
    # 누적합으로 구간 채우기 (파이썬 루프 없음)
    acc = np.zeros((H, W + 1), np.int16)
    np.add.at(acc, (ys, xs), 1)
    np.add.at(acc, (ys, xe), -1)
    mask = np.cumsum(acc[:, :W], axis=1) > 0
    return mask, (ys, xs, L)


def _longest_run(col):
    """1차원 bool 배열의 가장 긴 True 연속 구간 (start, end, len)."""
    if not col.any():
        return 0, 0, 0
    d = np.diff(np.concatenate(([0], col.view(np.int8), [0])))
    s = np.flatnonzero(d == 1)
    e = np.flatnonzero(d == -1)
    i = int((e - s).argmax())
    return int(s[i]), int(e[i]), int(e[i] - s[i])


def _hedge_row(frame, V, xa, xb, ya, yb, ref_color, from_top):
    """[ya, yb) 행 중 x 구간 [xa, xb) 가 ref_color 로 가득 찬 줄을 찾는다.

    반환: 가로선 바깥쪽 y (위쪽이면 첫 줄, 아래쪽이면 마지막 줄 + 1) 또는 None
    """
    ya = max(0, ya)
    yb = min(frame.shape[0], yb)
    if yb <= ya or xb <= xa:
        return None
    R, G, B = rgb_view(frame[ya:yb, xa:xb])
    cr, cg, cb = (int(c) for c in ref_color)
    # uint8 -> int16 차이 (채널별 절대차 최댓값)
    diff = np.maximum(np.maximum(np.abs(R.astype(np.int16) - cr), np.abs(G.astype(np.int16) - cg)),
                      np.abs(B.astype(np.int16) - cb))
    fill = (diff <= HEDGE_COLOR_TOL).mean(axis=1)
    rows = np.flatnonzero(fill >= HEDGE_FILL_MIN)
    if rows.size == 0:
        return None
    if from_top:
        return ya + int(rows[0])
    return ya + int(rows[-1]) + 1


def _pixel(frame, y, x):
    R, G, B = rgb_view(frame[y:y + 1, x:x + 1])
    return int(R[0, 0]), int(G[0, 0]), int(B[0, 0])


def detect_tooltip(frame):
    """프레임(HxWx3 RGB 또는 HxWx4 BGRA, uint8)에서 툴팁을 찾아 Tooltip 또는 None 반환.

    알고리즘
      1) 세로로 sy 간격 행만 뽑아 '얇은 밝은 선' 마스크 계산 (가로 방향은 원본 해상도)
      2) 열마다 최장 연속 구간이 최소 높이 이상인 열 -> 인접 열을 묶어 세로선 후보 (두께 = 배율)
      3) 두께/위아래 끝/색이 맞는 좌우 세로선 쌍 -> 원본 해상도에서 위/아래 가로선 확인
      4) 안쪽이 어두운지 확인. 조건을 만족하는 가장 큰 사각형 반환
    """
    H, W = frame.shape[:2]
    sy = max(2, H // DETECT_TARGET_ROWS)
    small = frame[::sy]
    V = _value(small)
    mask, _ = _thin_runs_mask(V, BORDER_MAX_THICK)
    min_h = max(3, TOOLTIP_MIN_H // sy)
    counts = np.count_nonzero(mask, axis=0)
    cand = np.flatnonzero(counts >= min_h)
    if cand.size < 2:
        return None

    # 인접한 후보 열을 하나의 세로선으로 묶기 (선 두께 = 묶음 폭)
    lines = []  # (x0, x1_exclusive, y0s, y1s)  y 는 샘플 좌표
    groups = np.split(cand, np.flatnonzero(np.diff(cand) > 1) + 1)
    for g in groups:
        x0, x1 = int(g[0]), int(g[-1]) + 1
        if x1 - x0 > BORDER_MAX_THICK:
            continue
        # 묶음 가운데 열 기준 최장 연속 구간 (묶음 모든 열이 동시에 선이어야 함)
        col = mask[:, x0:x1].all(axis=1)
        y0, y1, ln = _longest_run(col)
        if ln >= min_h:
            lines.append((x0, x1, y0, y1))
    if len(lines) < 2:
        return None

    best = None
    min_w = TOOLTIP_MIN_W
    for i, (lx0, lx1, ly0, ly1) in enumerate(lines):
        thick = lx1 - lx0
        for rx0, rx1, ry0, ry1 in reversed(lines[i + 1:]):
            if rx1 - lx0 < min_w:
                break
            if abs((rx1 - rx0) - thick) > 1:
                continue
            if abs(ly0 - ry0) > EDGE_ALIGN_TOL or abs(ly1 - ry1) > EDGE_ALIGN_TOL:
                continue
            ya, yb = max(ly0, ry0), min(ly1, ry1)
            if yb - ya < min_h:
                continue
            # 좌우 세로선 색 비교 (같은 높이면 같은 색이어야 함)
            lc = small[ya:yb, lx0].astype(np.int16)
            rc = small[ya:yb, rx0].astype(np.int16)
            if np.abs(lc - rc).mean() > PAIR_COLOR_TOL:
                continue
            Y0, Y1 = min(ly0, ry0) * sy, max(ly1, ry1) * sy
            pad = sy + 2
            # 위쪽 가로선: 세로선 맨 위 샘플 색과 같은 색으로 채워진 줄 (그라데이션 대비 가까운 행 색 사용)
            # 기준 색은 좌우 세로선이 '둘 다' 선인 샘플 행에서 가져옴 (한쪽 끝이 배경 잡음일 수 있어서)
            top_ref = _pixel(frame, min(H - 1, ya * sy), lx0)
            ty = _hedge_row(frame, None, lx0, rx1, Y0 - pad, max(ly0, ry0) * sy + pad, top_ref, True)
            bot_ref = _pixel(frame, max(0, min(H - 1, (yb - 1) * sy)), lx0)
            by = _hedge_row(frame, None, lx0, rx1, min(ly1, ry1) * sy - pad, Y1 + pad, bot_ref, False)
            if ty is None or by is None or by - ty < TOOLTIP_MIN_H:
                continue
            # 안쪽 어두움 검사 (테두리+안쪽선 2칸 + 여유 제외, 듬성듬성 샘플)
            k = 3 * thick
            iy0, iy1 = (ty + k) // sy + 1, (by - k) // sy
            if iy1 <= iy0:
                continue
            inner = V[iy0:iy1, lx0 + k:rx1 - k:2]
            if inner.size == 0:
                continue
            if inner.mean() > INNER_MEAN_MAX or (inner < INNER_DARK_V).mean() < INNER_DARK_RATIO:
                continue
            area = (rx1 - lx0) * (by - ty)
            if best is None or area > best[0]:
                best = (area, (lx0, ty, rx1, by), thick, top_ref)
            break
    if best is None:
        return None
    _, box, thick, color = best
    x0, y0, x1, y1 = box
    color = _pixel(frame, y0, (x0 + x1) // 2)
    return Tooltip(box, thick, color)

# -*- coding: utf-8 -*-
"""
픽셀 폰트 숫자 판독 (템플릿 매칭)

띵타이쿤 툴팁 글꼴은 '픽셀 폰트' 라서 숫자 모양이 항상 같다. 다만 화면에 그릴 때
폰트 텍셀 1칸이 물리 픽셀 정수배가 아니다 (GUI 배율 4 에서 약 3.29px: 3/4px 이 섞이고
경계에 반쯤 칠해진 열이 생김). 그래서 글자마다
    1) 줄의 '숫자 띠'(숫자 윗줄~아랫줄 = 폰트 7칸) 를 구하고
    2) 글자 박스를 (7행 x 폭/피치 열) 격자로 박스 평균 재샘플링 -> 0/1 비트맵
    3) 등록된 템플릿과 해밍 거리 비교
를 한다. 격자 크기(피치)는 테두리 두께(GUI 배율)로 1차 추정 후 실제 숫자 높이로 보정하므로
GUI 배율/해상도와 무관하게 동작한다.

쉼표(,)는 템플릿 대신 위치/크기 규칙으로 판정 (숫자 띠 아래쪽에 붙은 작은 글자).
"""

import functools
import json
import os

import numpy as np

# ============================================================================
# 튜닝 상수
# ============================================================================

# 숫자 글자의 세로 폰트 칸 수 (띵타이쿤 툴팁 숫자 = 7칸)
FONT_ROWS = 7

# GUI 픽셀 1칸 당 폰트 텍셀 크기 비율 (실측: GUI 배율 4 -> 숫자 높이 23px = 7칸 -> 23/7/4 = 0.8214).
# 피치(텍셀 크기, 물리 px) 1차 추정 = 테두리 두께 x 이 값. 이후 실제 숫자 높이로 다시 보정함
FONT_TEXEL_PER_GUI_PX = 23.0 / 28.0

# 글자(잉크) 판정 밝기 (RGB 최댓값). 툴팁 배경은 약 15~30, 글자 경계의 반쯤 칠해진 열은 약 60
INK_V = 45

# 배경 밝기 기준값 (재샘플링할 때 0 으로 보는 밝기)
BG_V = 22

# 격자 칸 평균 농도(0~1)가 이 값 이상이면 '켜진 칸'
CELL_ON = 0.5

# 같은 글자 안의 빈 열을 합치는 기준: 틈이 (피치 x 이 값) 미만이면 합침.
# 반쯤 칠해진 경계 열도 INK_V 이상이라 숫자 안에는 빈 열이 생기지 않음. 반면 '(' 와 숫자 사이는
# 물리 픽셀 1개 틈밖에 없는 경우가 있어서 합치면 안 됨 -> 0 (합치지 않음)
GLYPH_MERGE_GAP = 0.0

# 단어 경계(공백) 판정: 글자 사이 틈이 (피치 x 이 값) 이상이면 다른 단어.
# 실측: 글자 사이 약 1텍셀, 쉼표 뒤 최대 약 2.1텍셀, 공백(단어 사이) 4~4.9텍셀
WORD_GAP = 3.0

# 숫자 후보 글자 높이 허용 오차 (비율). 글자 높이가 7칸 x 피치 추정값의 +-20% 이내면 숫자 후보
DIGIT_H_TOL = 0.2
# 숫자 후보 글자 폭 상한 (높이 대비 비율). 숫자는 5/7=0.71 이하, 한글 음절은 약 1.1
DIGIT_MAX_ASPECT = 0.93

# 템플릿과 다른 칸 수가 이 값 이하일 때만 숫자로 인정 (7 x 5 = 35칸 중).
# 실제 게임 화면에서는 보통 0. 숫자 쌍 중 가장 가까운 것(6/8, 8/9)이 2칸 차이라서 1 보다 크게 하면 오인식 위험
MAX_HAMMING = 1
# 1등과 (다른 글자인) 2등의 거리 차이가 이 값 미만이면 애매 -> 인정 안 함
MIN_HAMMING_MARGIN = 1

# 쉼표(,) 모양 기준 (피치 단위, 숫자 띠 아래끝 = 0, 아래쪽이 +).
# 쉼표는 텍셀 2개짜리라 격자 비트맵이 위상에 따라 흔들리므로 비트맵 대신 '크기/위치' 로 판정.
# digit_templates.json 의 "comma" 항목(실측값 + 여유)이 있으면 그 값을 우선 사용
COMMA_DEFAULT = {
    "max_w": 2.6,       # 최대 폭
    "max_h": 3.2,       # 최대 높이
    "min_top": -1.6,    # 윗끝이 숫자 띠 아래끝보다 이 값 이상 (= 숫자 띠 아랫부분에서 시작)
    "min_bottom": 0.5,  # 아랫끝이 숫자 띠 아래로 이 값 이상 내려와야 함 (마침표/점과 구분)
    "max_bottom": 3.0,  # 아랫끝이 숫자 띠 아래로 이 값 이하
}

# 글자 가장자리의 흐린 행/열 제거 기준 (0~1 농도). 이보다 옅은 가장자리 열은 글자 폭에서 뺌
EDGE_TRIM = 0.5

# 저해상도(텍셀 1칸 = 1~2px) 대비: 단순 격자 평균으로 템플릿이 안 맞으면 '최근접 샘플링 위상' 을
# 바꿔가며 다시 맞춰 봄. 위상 탐색 간격(물리 픽셀)과 피치 흔들림 비율 후보
PHASE_STEP = 0.25
PITCH_JITTER = (0.97, 1.0, 1.03)

# 붙어버린 글자 쪼개기: '(' 와 숫자처럼 1px 이하 틈으로 붙은 덩어리에서 오른쪽/왼쪽 끝 숫자를 찾아봄.
# 덩어리 폭이 (숫자 최대 폭 x 이 값) 이상일 때만 시도
SPLIT_MIN_W_RATIO = 1.3

# 줄 분리: 이 피치 수 이하의 빈 행은 같은 줄로 합침 (한글 받침/부호 사이 틈)
LINE_GAP_MERGE = 1.0
# 너무 얇은 줄(구분선 등) 무시: 줄 높이 최소 (피치 단위)
LINE_MIN_ROWS = 4.0

# 템플릿 파일 (이 파일과 같은 폴더)
TEMPLATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "digit_templates.json")


# ============================================================================
# 기본 도구
# ============================================================================

def value_channel(rgb):
    """RGB(또는 BGRA) uint8 -> 채널 최댓값 int16 (색 글자도 밝게 유지)."""
    c = rgb[..., :3]
    return np.maximum(np.maximum(c[..., 0], c[..., 1]), c[..., 2]).astype(np.int16)


def _runs(bool_1d):
    """1차원 bool 배열의 True 구간 [(start, end_exclusive), ...]."""
    d = np.diff(np.concatenate(([0], bool_1d.astype(np.int8), [0])))
    return list(zip(np.flatnonzero(d == 1).tolist(), np.flatnonzero(d == -1).tolist()))


def segment_lines(V, pitch):
    """툴팁 안쪽 밝기(V)에서 글자 줄 (y0, y1) 목록 (행 투영)."""
    rows = (V >= INK_V).any(axis=1)
    merge = LINE_GAP_MERGE * pitch
    segs = []
    for y0, y1 in _runs(rows):
        if segs and y0 - segs[-1][1] <= merge:
            segs[-1] = (segs[-1][0], y1)
        else:
            segs.append((y0, y1))
    return [s for s in segs if s[1] - s[0] >= LINE_MIN_ROWS * pitch]


def segment_glyphs(Vrow, pitch):
    """한 줄의 밝기(V)에서 글자 박스 [(x0, x1, y0, y1)] (열 투영 + 작은 틈 합치기)."""
    ink = Vrow >= INK_V
    merged = []
    for x0, x1 in _runs(ink.any(axis=0)):
        if merged and (x0 - merged[-1][1]) < GLYPH_MERGE_GAP * pitch:
            merged[-1] = (merged[-1][0], x1)
        else:
            merged.append((x0, x1))
    out = []
    for x0, x1 in merged:
        rows = np.flatnonzero(ink[:, x0:x1].any(axis=1))
        out.append((x0, x1, int(rows[0]), int(rows[-1]) + 1))
    return out


def resample(intensity, rows, cols):
    """2차원 float(0~1) 배열을 (rows x cols) 격자로 박스 평균 (비정수 경계는 면적 가중)."""
    h, w = intensity.shape

    def weights(n_in, n_out):
        # n_out x n_in 가중치 행렬: 각 출력 칸이 입력 픽셀과 겹치는 길이
        edges = np.linspace(0, n_in, n_out + 1)
        lo = edges[:-1, None]
        hi = edges[1:, None]
        px = np.arange(n_in)[None, :]
        ov = np.clip(np.minimum(hi, px + 1) - np.maximum(lo, px), 0, None)
        return ov / ov.sum(axis=1, keepdims=True)

    return weights(h, rows) @ intensity @ weights(w, cols).T


def bitmap_to_rows(bmp):
    return ["".join("#" if v else "." for v in r) for r in bmp]


def rows_to_bitmap(rows):
    return np.array([[c == "#" for c in r] for r in rows], dtype=bool)


# ============================================================================
# 템플릿
# ============================================================================

class DigitTemplates:
    """숫자 템플릿 모음 (라벨별 여러 변형 허용)."""

    def __init__(self, entries=None, comma=None):
        self.entries = []  # [(label, bool[7, w])]
        self.comma = comma  # 쉼표 크기/위치 기준 dict (COMMA_DEFAULT 와 같은 키) 또는 None
        for lab, bmp in entries or []:
            self.add(lab, bmp)

    def add(self, label, bmp):
        self.entries.append((label, np.asarray(bmp, dtype=bool)))

    @classmethod
    def load(cls, path=TEMPLATE_FILE):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return cls([(g["label"], rows_to_bitmap(g["rows"])) for g in data["glyphs"]],
                   comma=data.get("comma"))

    def save(self, path=TEMPLATE_FILE, meta=None):
        data = {
            "_comment": "띵타이쿤 툴팁 숫자 픽셀 폰트 템플릿 (7행, '#'=켜진 칸)",
            "font_rows": FONT_ROWS,
            "meta": meta or {},
            "comma": self.comma,
            "glyphs": [{"label": lab, "w": int(b.shape[1]), "rows": bitmap_to_rows(b)}
                       for lab, b in self.entries],
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)

    def widths(self):
        return sorted({b.shape[1] for _, b in self.entries})

    def match(self, bmp):
        """(라벨 또는 None, 최소 거리, 다른 라벨과의 거리 차이). 숫자(0~9)만 비교."""
        best = {}
        for lab, t in self.entries:
            if t.shape != bmp.shape:
                continue
            d = int((t != bmp).sum())
            if lab not in best or d < best[lab]:
                best[lab] = d
        if not best:
            return None, 99, 0
        ranked = sorted(best.items(), key=lambda kv: kv[1])
        lab, d = ranked[0]
        second = ranked[1][1] if len(ranked) > 1 else 99
        margin = second - d
        if d <= MAX_HAMMING and margin >= MIN_HAMMING_MARGIN:
            return lab, d, margin
        return None, d, margin


# ============================================================================
# 줄 판독
# ============================================================================

class Glyph:
    __slots__ = ("x0", "x1", "y0", "y1", "kind", "label", "dist", "bmp", "color")

    def __init__(self, x0, x1, y0, y1):
        self.x0, self.x1, self.y0, self.y1 = x0, x1, y0, y1
        self.kind = "other"   # 'digit' | 'comma' | 'other'
        self.label = None
        self.dist = None
        self.bmp = None
        self.color = None

    def __repr__(self):
        return "Glyph(%d-%d, %s:%s)" % (self.x0, self.x1, self.kind, self.label)


def find_digit_band(glyphs, pitch_est):
    """숫자 높이(7칸)에 맞는 글자들로 줄의 숫자 띠 (top, bottom, pitch) 추정. 없으면 None."""
    target = FONT_ROWS * pitch_est
    cands = [g for g in glyphs
             if abs((g.y1 - g.y0) - target) <= 0.2 * target and (g.x1 - g.x0) <= 6.5 * pitch_est]
    if not cands:
        return None
    tops = np.array([g.y0 for g in cands])
    bots = np.array([g.y1 for g in cands])
    # 가장 흔한 (위, 아래) 값 = 숫자 띠 (한글/괄호는 제각각이라 다수결에서 밀림)
    top = int(np.median(tops))
    bot = int(np.median(bots))
    pitch = (bot - top) / float(FONT_ROWS)
    if pitch <= 0:
        return None
    return top, bot, pitch


def trim_weak_edges(inten):
    """가장자리의 '반쯤 칠해진' 행/열(최대 농도 < EDGE_TRIM) 을 잘라냄.

    텍셀 경계가 픽셀 중간에 걸리면 글자 가장자리에 흐린 열이 생기는데, 이 열까지 폭에 넣으면
    격자 칸 수가 틀어진다 (특히 GUI 배율이 비정수배로 늘어난 화면).
    """
    cols = inten.max(axis=0)
    rows = inten.max(axis=1)
    c = np.flatnonzero(cols >= EDGE_TRIM)
    r = np.flatnonzero(rows >= EDGE_TRIM)
    if c.size == 0 or r.size == 0:
        return inten
    return inten[r[0]:r[-1] + 1, c[0]:c[-1] + 1]


def glyph_bitmap(Vrow, g, top, bot, pitch):
    """글자 g 를 숫자 띠 [top, bot) 기준 (7 x 열) 비트맵으로.

    열 개수는 '농도 가중 폭' 으로 계산 (가장자리의 흐린 열은 농도만큼만 폭에 셈).
    """
    inten = _intensity(Vrow[top:bot, g.x0:g.x1])
    eff_w = float(np.clip(inten.max(axis=0), 0.0, 1.0).sum())
    cols = max(1, int(round(eff_w / pitch)))
    return resample(inten, FONT_ROWS, cols) >= CELL_ON


def _intensity(patch):
    patch = patch.astype(np.float32)
    ink = patch >= INK_V
    fg = float(np.percentile(patch[ink], 90)) if ink.any() else 255.0
    return np.clip((patch - BG_V) / max(1.0, fg - BG_V), 0.0, 1.0)


@functools.lru_cache(maxsize=4096)
def _phase_maps_cached(n, pitch_milli, k):
    return tuple(_phase_maps_raw(n, pitch_milli / 1000.0, k))


def _phase_maps(n, pitch, k):
    return _phase_maps_cached(int(n), int(round(pitch * 1000)), int(k))


def _phase_maps_raw(n, pitch, k):
    """길이 n 픽셀을 k 텍셀로 나누는 '최근접 샘플링' 대응표 후보들 (픽셀 -> 텍셀 번호).

    게임은 텍셀을 최근접 샘플링으로 그리므로 픽셀 중심 u 는 텍셀 floor((u + 0.5 + 위상) / 피치).
    첫 픽셀 = 텍셀 0, 마지막 픽셀 = 텍셀 k-1 이고 모든 텍셀이 1픽셀 이상 차지하는 경우만 유효.
    """
    maps = {}
    u = np.arange(n) + 0.5
    for pj in PITCH_JITTER:
        p = pitch * pj
        if p < 1.0:
            continue
        for ph in np.arange(-0.5, p - 0.5, PHASE_STEP):
            idx = np.floor((u + ph) / p).astype(np.int64)
            if idx[0] != 0 or idx[-1] != k - 1 or np.unique(idx).size != k:
                continue
            maps[idx.tobytes()] = idx
    return list(maps.values())


def phase_bitmaps(patch_v, pitch, widths):
    """글자 밝기 조각 -> 가능한 (7 x c) 비트맵 후보들 (c in widths)."""
    inten = trim_weak_edges(_intensity(patch_v))
    h, w = inten.shape
    out = {}
    for rm in _phase_maps(h, pitch, FONT_ROWS):
        rs = np.zeros((FONT_ROWS, w), np.float32)
        np.add.at(rs, rm, inten)
        rs /= np.bincount(rm, minlength=FONT_ROWS)[:, None]
        for c in widths:
            for cm in _phase_maps(w, pitch, c):
                cs = np.zeros((FONT_ROWS, c), np.float32)
                np.add.at(cs.T, cm, rs.T)
                cs /= np.bincount(cm, minlength=c)[None, :]
                b = cs >= CELL_ON
                out[b.tobytes() + bytes([c])] = b
    return list(out.values())


def match_with_phase(patch_v, pitch, templates):
    """위상 탐색으로 가장 잘 맞는 숫자. (라벨 또는 None, 거리)

    서로 다른 숫자가 같은 최소 거리로 맞으면 애매 -> None.
    """
    best = {}
    for b in phase_bitmaps(patch_v, pitch, templates.widths()):
        for lab, t in templates.entries:
            if t.shape == b.shape:
                d = int((t != b).sum())
                if lab not in best or d < best[lab]:
                    best[lab] = d
    if not best:
        return None, 99
    ranked = sorted(best.items(), key=lambda kv: kv[1])
    lab, d = ranked[0]
    second = ranked[1][1] if len(ranked) > 1 else 99
    if d <= MAX_HAMMING and second - d >= MIN_HAMMING_MARGIN:
        return lab, d
    return None, d


def comma_geometry(g, bot, pitch):
    """쉼표 판정용 (폭, 높이, 윗끝, 아랫끝) - 피치 단위, 숫자 띠 아래끝 기준."""
    return ((g.x1 - g.x0) / pitch, (g.y1 - g.y0) / pitch, (g.y0 - bot) / pitch, (g.y1 - bot) / pitch)


def is_comma_shape(g, bot, pitch, spec=None):
    c = spec or COMMA_DEFAULT
    w, h, top, bottom = comma_geometry(g, bot, pitch)
    # 저해상도에서는 물리 픽셀 1개 반올림 오차가 피치 단위로 커지므로 그만큼 여유를 더 줌
    e = 1.0 / pitch
    return (w <= c["max_w"] + e and h <= c["max_h"] + e and top >= c["min_top"] - e
            and c["min_bottom"] - e <= bottom <= c["max_bottom"] + e)


# 단순 격자 평균으로 안 맞을 때 '위상 탐색' 을 할 최대 피치(물리 px). 텍셀이 1~2.5px 인 저해상도에서만
# 필요하고(1280x800, 1920x1200), 3px 이상에서는 격자 평균 + 폭 재시도로 충분함. 높이면 느려짐
PHASE_SEARCH_MAX_PITCH = 3.0


def _split_merged(Vrow, glyphs, matched, templates):
    """숫자 띠에 걸친 미판독 넓은 덩어리의 오른쪽/왼쪽 끝에서 숫자를 떼어낸다."""
    top = int(np.median([g.y0 for g in matched]))
    bot = int(np.median([g.y1 for g in matched]))
    p = (bot - top) / float(FONT_ROWS)
    max_w = max(templates.widths()) * p
    out = []
    gap = WORD_GAP * p
    for i, g in enumerate(glyphs):
        # 판독된 숫자 바로 옆(단어 틈 미만)에 붙은 덩어리만 시도 (예: '(2' + '1', '2' + '1일')
        near_digit = ((i > 0 and glyphs[i - 1].kind == "digit" and g.x0 - glyphs[i - 1].x1 < gap)
                      or (i + 1 < len(glyphs) and glyphs[i + 1].kind == "digit"
                          and glyphs[i + 1].x0 - g.x1 < gap))
        if g.kind != "other" or not near_digit or (g.x1 - g.x0) < SPLIT_MIN_W_RATIO * max_w                 or g.y1 < top + p or g.y0 > bot - p:
            out.append(g)
            continue
        pieces = _split_one(Vrow, g, top, bot, p, templates, depth=0)
        out.extend(pieces)
    return out


def _split_one(Vrow, g, top, bot, p, templates, depth):
    if depth > 3 or (g.x1 - g.x0) < 2 * p:
        return [g]
    for c in sorted(templates.widths(), reverse=True):
        base = c * p
        for W in sorted({int(np.floor(base)), int(np.ceil(base)), int(np.ceil(base)) + 1}):
            if W <= 0 or W >= g.x1 - g.x0:
                continue
            for side in ("right", "left"):
                xa, xb = (g.x1 - W, g.x1) if side == "right" else (g.x0, g.x0 + W)
                patch = Vrow[top:bot, xa:xb]
                # 숫자 창 바로 바깥 열(= 남은 덩어리 쪽)은 숫자에 속하면 안 되므로 가장자리 열에 잉크가 있어야 함
                if not (patch[:, 0] >= INK_V).any() or not (patch[:, -1] >= INK_V).any():
                    continue
                lab, d = match_with_phase(patch, p, templates)
                if lab is None:
                    continue
                dg = Glyph(xa, xb, top, bot)
                dg.kind, dg.label, dg.dist = "digit", lab, d
                if side == "right":
                    rest = _trim(Vrow, g.x0, xa, g)
                    left = _split_one(Vrow, rest, top, bot, p, templates, depth + 1) if rest else []
                    return left + [dg]
                rest = _trim(Vrow, xb, g.x1, g)
                right = _split_one(Vrow, rest, top, bot, p, templates, depth + 1) if rest else []
                return [dg] + right
    return [g]


def _trim(Vrow, xa, xb, g):
    """[xa, xb) 구간의 잉크 박스로 새 글자 (빈 구간이면 None)."""
    ink = Vrow[:, xa:xb] >= INK_V
    cols = np.flatnonzero(ink.any(axis=0))
    if cols.size == 0:
        return None
    rows = np.flatnonzero(ink[:, cols[0]:cols[-1] + 1].any(axis=1))
    return Glyph(xa + int(cols[0]), xa + int(cols[-1]) + 1, int(rows[0]), int(rows[-1]) + 1)


# 폭 재시도 허용 범위: (농도 가중 폭 / 피치) 가 템플릿 폭과 이 값 이내로 차이 나면 그 폭으로도 맞춰 봄
WIDTH_RETRY_TOL = 0.8


def _match_widths(Vrow, g, gp, templates, d0):
    inten = _intensity(Vrow[g.y0:g.y1, g.x0:g.x1])
    eff = float(np.clip(inten.max(axis=0), 0.0, 1.0).sum()) / gp
    best = (None, d0, None)
    for c in templates.widths():
        if abs(eff - c) > WIDTH_RETRY_TOL:
            continue
        b = resample(inten, FONT_ROWS, c) >= CELL_ON
        lab, d, _ = templates.match(b)
        if lab is not None and (best[0] is None or d < best[1]):
            best = (lab, d, b)
    return best


def read_row(rgb_row, pitch_est, templates):
    """한 줄(RGB, 줄 높이만큼 잘린 이미지) -> (글자 목록, 숫자 토큰 목록, 숫자 띠).

    숫자 토큰 = {"text": "1,282", "value": 1282, "x0", "x1", "embedded": bool}
      embedded=True 이면 괄호/한글 등 다른 글자에 붙어 있는 숫자 (예: '(21일)' 의 21, '(↑191)' 의 191)
      embedded=False 이면 공백으로 떨어진 독립 숫자 단어 (= 가격)
    """
    Vrow = value_channel(rgb_row)
    glyphs = [Glyph(*b) for b in segment_glyphs(Vrow, pitch_est)]
    target = FONT_ROWS * pitch_est
    matched = []
    for g in glyphs:
        w = g.x1 - g.x0
        h = g.y1 - g.y0
        # 숫자는 모든 모양이 맨 윗칸/맨 아랫칸에 잉크가 있으므로 글자 박스 높이 = 숫자 7칸.
        # 그래서 줄 공통 띠 대신 글자 자신의 박스로 격자를 잡는다 (한글/괄호가 1px 어긋나 있어도 무관)
        if abs(h - target) <= DIGIT_H_TOL * target and w <= DIGIT_MAX_ASPECT * h:
            gp = h / float(FONT_ROWS)
            g.bmp = glyph_bitmap(Vrow, g, g.y0, g.y1, gp)
            lab, d, _ = templates.match(g.bmp) if templates is not None else (None, 99, 0)
            if lab is None and templates is not None:
                # 가로/세로 텍셀 크기가 조금 다른 화면(비정수배 확대 등): 폭을 템플릿 폭들로 바꿔서 재시도
                lab, d, bmp = _match_widths(Vrow, g, gp, templates, d)
                if bmp is not None:
                    g.bmp = bmp
            if lab is None and templates is not None and pitch_est < PHASE_SEARCH_MAX_PITCH:
                lab, d = match_with_phase(Vrow[g.y0:g.y1, g.x0:g.x1], gp, templates)
            g.dist = d
            if lab is not None:
                g.kind, g.label = "digit", lab
                matched.append(g)
    if matched and templates is not None:
        # 붙어버린 '(2' 같은 덩어리를 숫자 띠 기준으로 쪼개 보기
        glyphs = _split_merged(Vrow, glyphs, matched, templates)
        matched = [g for g in glyphs if g.kind == "digit"]
    if matched:
        top = int(np.median([g.y0 for g in matched]))
        bot = int(np.median([g.y1 for g in matched]))
        band = (top, bot, (bot - top) / float(FONT_ROWS))
    else:
        band = find_digit_band(glyphs, pitch_est)  # 템플릿 없이(템플릿 제작용) 부를 때
    if band is None:
        return glyphs, [], None
    top, bot, pitch = band
    for g in glyphs:
        if g.kind == "other" and is_comma_shape(g, bot, pitch,
                                                templates.comma if templates is not None else None):
            # 숫자 띠 아랫부분에 붙어 아래로 조금 내려오는 작은 글자 = 쉼표
            g.kind, g.label = "comma", ","
    return glyphs, group_numbers(glyphs, pitch), band


def group_numbers(glyphs, pitch):
    """글자 목록 -> 숫자 토큰 목록 (연속된 숫자/쉼표 묶음)."""
    tokens = []
    i = 0
    n = len(glyphs)
    while i < n:
        g = glyphs[i]
        if g.kind != "digit":
            i += 1
            continue
        j = i
        text = g.label
        while j + 1 < n:
            nx = glyphs[j + 1]
            if nx.x0 - glyphs[j].x1 >= WORD_GAP * pitch:
                break
            if nx.kind == "digit":
                text += nx.label
            elif nx.kind == "comma":
                # 쉼표 뒤에 숫자가 이어져야 숫자의 일부
                if j + 2 < n and glyphs[j + 2].kind == "digit" and \
                        glyphs[j + 2].x0 - nx.x1 < WORD_GAP * pitch:
                    text += ","
                else:
                    break
            else:
                break
            j += 1
        left_attached = i > 0 and glyphs[i].x0 - glyphs[i - 1].x1 < WORD_GAP * pitch
        right_attached = j + 1 < n and glyphs[j + 1].x0 - glyphs[j].x1 < WORD_GAP * pitch
        digits = text.replace(",", "")
        # 쉼표 위치 검사: 쉼표가 있으면 오른쪽부터 3자리마다여야 함 (아니면 잘못 읽은 것)
        ok_commas = True
        if "," in text:
            parts = text.split(",")
            ok_commas = all(len(p) == 3 for p in parts[1:]) and 1 <= len(parts[0]) <= 3
        tokens.append({
            "text": text,
            "value": int(digits) if digits and ok_commas else None,
            "x0": glyphs[i].x0,
            "x1": glyphs[j].x1,
            "embedded": bool(left_attached or right_attached),
            "dist": max(glyphs[k].dist or 0 for k in range(i, j + 1) if glyphs[k].kind == "digit"),
        })
        i = j + 1
    return tokens

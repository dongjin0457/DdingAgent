# -*- coding: utf-8 -*-
"""
툴팁 판독 파이프라인: 프레임 -> (검출) -> 줄 분리 -> 이름(OCR+퍼지) / 가격(숫자 템플릿) -> 이벤트

툴팁 줄 구조 (요리 아이템 기준. 공예품도 같은 형식일 것으로 예상하지만 실제 샘플로는 미확인)
    [희귀도 배지] 아이템 이름
    설명 줄들
    요리 아이템 판매 정보
    - 판매가 : 751 골드 (↓535)          <- 라벨 단어 1개  -> sell
    - 나의 판매가 : 766 골드             <- 라벨 단어 2개  -> my
    - (21일) 1,286 골드 (↑720)          <- 괄호 안 숫자(날짜) 가 가격 앞에 있음 -> history
    ...
    (우) 판매 (쉬프트) 모두 판매 ...

줄 종류는 픽셀 구조로 판정한다 (Windows OCR 이 픽셀 폰트의 '나의 판매가' 줄을 자주 놓치기 때문).
  - 가격 = 공백으로 떨어진 첫 '독립 숫자 단어'
  - 가격 앞에 괄호/한글에 붙은 숫자가 있으면 = 과거 시세 줄 (그 숫자 = 날짜)
  - 아니면 라벨 줄: 라벨 단어가 1개면 판매가, 2개 이상이면 나의 판매가
    (판정이 애매하면 그 줄 라벨 부분만 OCR 해서 '나' 가 있는지로 결정)
"""

import hashlib
import time

import numpy as np

from . import glyphs as G
from .detect import detect_tooltip, to_rgb
from .names import NameMatcher

# ============================================================================
# 튜닝 상수
# ============================================================================

# 희귀도별 테두리 색 (위쪽 가로선 가운데 RGB 실측값). 새 희귀도가 나오면 여기에 추가.
# 색이 목록과 RARITY_COLOR_TOL 이상 다르면 rarity = None (알 수 없음) 으로 보냄
RARITY_COLORS = {
    "NORMAL": (170, 223, 86),    # 초록
    "COMMON": (251, 217, 97),    # 노랑/주황
    "RARE": (96, 202, 235),      # 하늘색
    "EPIC": (245, 84, 43),       # 빨강
}
# 희귀도 색 매칭 허용 거리 (RGB 유클리드 거리)
RARITY_COLOR_TOL = 60

# 한글 음절 1개의 폭(폰트 텍셀). 단어 폭 = 음절 수 x SYLLABLE_ADVANCE - SYLLABLE_GAP 로 실측됨
SYLLABLE_ADVANCE = 9.1
SYLLABLE_GAP = 0.9

# 이름 줄 앞의 희귀도 배지 판정: 폭이 이 텍셀 수 이상이고 잉크 채움 비율이 이 값 이상인 첫 덩어리
BADGE_MIN_W = 12
BADGE_MIN_FILL = 0.45

# 라벨 단어로 셀 최소 폭 (텍셀). '-' 와 ':' 는 이보다 좁아서 제외됨
LABEL_WORD_MIN_W = 5.0

# 가격 상식 검사: 알려진 범위 [min, max] 가 있을 때 max x HI 초과 또는 min x LO 미만이면 그 가격을 버림
PRICE_SANITY_HI = 5.0
PRICE_SANITY_LO = 0.2

# 중복 판독 방지 해시: 툴팁 안쪽을 이 밝기 이상이면 글자(1)로 이진화한 뒤 해시
HASH_TEXT_V = 100
# 해시 계산 전 샘플링 간격 (픽셀) - 글자 모양만 구별되면 되므로 듬성듬성
HASH_STRIDE = 2

# 과거 시세 날짜로 인정할 범위 (일)
DAY_MIN = 1
DAY_MAX = 99


def _color_dist(a, b):
    return float(np.sqrt(sum((float(x) - float(y)) ** 2 for x, y in zip(a, b))))


def rarity_from_color(color):
    best, bd = None, 1e9
    for name, c in RARITY_COLORS.items():
        d = _color_dist(color, c)
        if d < bd:
            best, bd = name, d
    return best if bd <= RARITY_COLOR_TOL else None


def text_hash(inner_rgb):
    """툴팁 내용(글자 모양) 해시. 위치가 바뀌어도 같은 내용이면 같은 해시."""
    c = inner_rgb[::HASH_STRIDE, ::HASH_STRIDE]
    bits = G.value_channel(c) >= HASH_TEXT_V
    # 글자가 있는 행/열만 남겨서 툴팁 가장자리 1~2px 차이에 흔들리지 않게
    rows = np.flatnonzero(bits.any(axis=1))
    cols = np.flatnonzero(bits.any(axis=0))
    if rows.size == 0:
        return "empty"
    bits = bits[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]
    return hashlib.blake2b(np.packbits(bits).tobytes() + str(bits.shape).encode("ascii"),
                           digest_size=8).hexdigest()


def split_words(glyphs, pitch):
    """글자 목록 -> 단어 목록 (틈이 WORD_GAP 피치 이상이면 새 단어)."""
    words = []
    for g in glyphs:
        if words and g.x0 - words[-1][-1].x1 < G.WORD_GAP * pitch:
            words[-1].append(g)
        else:
            words.append([g])
    return words


def syllables_from_width(w_texels):
    return max(1, int(round((w_texels + SYLLABLE_GAP) / SYLLABLE_ADVANCE)))


class TooltipReader:
    """툴팁 판독기. read(frame) -> (event dict 또는 None, info dict)

    한 인스턴스는 한 스레드에서만 사용 (OCR 엔진이 스레드 전용).
    """

    def __init__(self, templates=None, ocr=None):
        self.templates = templates if templates is not None else G.DigitTemplates.load()
        self._ocr = ocr
        self._ocr_error = None
        self.names = NameMatcher()

    # --- OCR ---------------------------------------------------------------
    def get_ocr(self):
        if self._ocr is None and self._ocr_error is None:
            try:
                from .ocr import WinOcr
                self._ocr = WinOcr()
            except Exception as e:  # noqa: BLE001
                self._ocr_error = str(e)
        return self._ocr

    @property
    def ocr_error(self):
        return self._ocr_error

    def set_known_items(self, items):
        self.names.set_items(items or [])

    # --- 메인 ---------------------------------------------------------------
    def read(self, frame, tooltip=None, ts=None):
        info = {"timings": {}}
        t0 = time.perf_counter()
        if tooltip is None:
            tooltip = detect_tooltip(frame)
            info["timings"]["detect"] = (time.perf_counter() - t0) * 1000
        if tooltip is None:
            info["reason"] = "no-tooltip"
            return None, info
        info["tooltip"] = tooltip.to_dict()
        x0, y0, x1, y1 = tooltip.inner_box()
        inner = to_rgb(np.ascontiguousarray(frame[y0:y1, x0:x1]))
        return self.read_inner(inner, tooltip, info, ts)

    def read_inner(self, inner, tooltip, info=None, ts=None):
        info = info if info is not None else {"timings": {}}
        pitch_est = tooltip.scale * G.FONT_TEXEL_PER_GUI_PX
        V = G.value_channel(inner)
        lines = G.segment_lines(V, pitch_est)
        info["lines"] = len(lines)
        info["hash"] = text_hash(inner)
        if len(lines) < 3:
            info["reason"] = "too-few-lines"
            return None, info

        # ---- 가격 줄 (숫자 템플릿) ----
        t1 = time.perf_counter()
        rows = self._parse_price_rows(inner, lines, pitch_est)
        info["timings"]["digits"] = (time.perf_counter() - t1) * 1000
        info["rows"] = rows["debug"]
        if rows["sell"] is None and rows["my"] is None and not rows["history"]:
            info["reason"] = "no-price-rows"
            return None, info

        # ---- 이름 (OCR + 퍼지 매칭) ----
        t2 = time.perf_counter()
        name_info = self._read_name(inner, lines[0], pitch_est)
        info["timings"]["ocr"] = (time.perf_counter() - t2) * 1000
        info["name"] = name_info
        item = name_info.get("item")
        if item is None:
            info["reason"] = "name-" + name_info.get("reason", "fail")
            return None, info

        # ---- 가격 상식 검사 ----
        sell, my = rows["sell"], rows["my"]
        history = rows["history"]
        rejected = []
        lo, hi = item.get("min"), item.get("max")

        def sane(v):
            if v is None:
                return None
            if hi is not None and v > hi * PRICE_SANITY_HI:
                rejected.append(v)
                return None
            if lo is not None and v < lo * PRICE_SANITY_LO:
                rejected.append(v)
                return None
            return v

        sell = sane(sell)
        my = sane(my)
        history = [h for h in history if sane(h["price"]) is not None]
        if rejected:
            info["rejected_prices"] = rejected
        if sell is None and my is None and not history:
            info["reason"] = "prices-rejected"
            return None, info

        digit_conf = 1.0 - 0.15 * rows["max_dist"]
        conf = max(0.0, min(1.0, name_info["score"] * digit_conf))
        if rejected:
            conf *= 0.8
        event = {
            "name": item["name"],
            "category": item.get("category"),
            "rarity": rarity_from_color(tooltip.color),
            "sell": sell,
            "my": my,
            "history": history,
            "ts": ts if ts is not None else time.time(),
            "confidence": round(conf, 3),
        }
        info["timings"]["total_read"] = sum(v for k, v in info["timings"].items() if k != "detect")
        info["reason"] = "ok"
        return event, info

    # --- 가격 줄 -------------------------------------------------------------
    def _parse_price_rows(self, inner, lines, pitch_est):
        sell = my = None
        history = []
        label_rows = []   # (줄 번호, 가격, 라벨 단어 수, 줄 y0, y1, 가격 x0)
        max_dist = 0
        debug = []
        for li, (ly0, ly1) in enumerate(lines):
            if li == 0:
                continue  # 이름 줄
            row = inner[ly0:ly1]
            glyphs, tokens, band = G.read_row(row, pitch_est, self.templates)
            if band is None or not tokens:
                continue
            pitch = band[2]
            price_tok = next((t for t in tokens if not t["embedded"] and t["value"] is not None), None)
            if price_tok is None:
                continue
            # 가격 뒤에 '골드' 같은 단어가 있어야 가격 줄
            if not any(g.x0 >= price_tok["x1"] + G.WORD_GAP * pitch * 0.5 for g in glyphs):
                continue
            before = [t for t in tokens if t["x1"] <= price_tok["x0"]]
            day_tok = next((t for t in reversed(before) if t["embedded"] and t["value"] is not None), None)
            max_dist = max(max_dist, price_tok["dist"] or 0)
            if day_tok is not None:
                day = day_tok["value"]
                if DAY_MIN <= day <= DAY_MAX:
                    history.append({"day": day, "price": price_tok["value"]})
                    debug.append({"line": li, "kind": "history", "day": day, "price": price_tok["value"]})
                    max_dist = max(max_dist, day_tok["dist"] or 0)
                continue
            words = split_words([g for g in glyphs if g.x1 <= price_tok["x0"]], pitch)
            label_words = [w for w in words if (w[-1].x1 - w[0].x0) / pitch >= LABEL_WORD_MIN_W]
            label_rows.append((li, price_tok["value"], len(label_words), ly0, ly1, price_tok["x0"]))

        # 라벨 줄 분류: 단어 1개 = 판매가, 2개 이상 = 나의 판매가
        kinds = {}
        for li, val, nwords, *_ in label_rows:
            if nwords == 1:
                kinds[li] = "sell"
            elif nwords >= 2:
                kinds[li] = "my"
        # 애매(단어 0개 / 같은 종류 중복)하면 라벨 OCR 로 재판정
        ambiguous = (len(kinds) != len(label_rows)
                     or list(kinds.values()).count("sell") > 1
                     or list(kinds.values()).count("my") > 1)
        if ambiguous:
            for li, val, nwords, ly0, ly1, px0 in label_rows:
                k = self._ocr_label_kind(inner[ly0:ly1, :px0])
                if k:
                    kinds[li] = k
        for li, val, nwords, *_ in label_rows:
            k = kinds.get(li)
            debug.append({"line": li, "kind": k, "price": val, "label_words": nwords})
            if k == "sell" and sell is None:
                sell = val
            elif k == "my" and my is None:
                my = val
        return {"sell": sell, "my": my, "history": history, "max_dist": max_dist, "debug": debug}

    def _ocr_label_kind(self, label_img):
        ocr = self.get_ocr()
        if ocr is None or label_img.size == 0:
            return None
        try:
            lines = ocr.recognize(np.ascontiguousarray(label_img))
        except Exception:  # noqa: BLE001
            return None
        txt = "".join(ln.text for ln in lines).replace(" ", "")
        if not txt:
            return None
        if "나" in txt[:3] or "의" in txt:
            return "my"
        if "판" in txt or "매" in txt or "가" in txt:
            return "sell"
        return None

    # --- 이름 ----------------------------------------------------------------
    def _read_name(self, inner, line, pitch):
        ly0, ly1 = line
        V = G.value_channel(inner[ly0:ly1])
        segs = G.segment_glyphs(V, pitch)
        out = {"texts": [], "pattern": None}
        if not segs:
            out["reason"] = "empty"
            return out
        start = 0
        bx0, bx1, by0, by1 = segs[0]
        if (bx1 - bx0) / pitch >= BADGE_MIN_W:
            fill = float((V[by0:by1, bx0:bx1] >= G.INK_V).mean())
            if fill >= BADGE_MIN_FILL:
                start = 1
        name_segs = segs[start:]
        if not name_segs:
            out["reason"] = "empty"
            return out

        class _S:  # split_words 가 x0/x1 속성을 쓰므로 가벼운 래퍼
            __slots__ = ("x0", "x1")

            def __init__(self, a, b):
                self.x0, self.x1 = a, b

        words = split_words([_S(s[0], s[1]) for s in name_segs], pitch)
        pattern = [syllables_from_width((w[-1].x1 - w[0].x0) / pitch) for w in words]
        out["pattern"] = pattern
        nx0 = max(0, name_segs[0][0] - int(pitch))
        nx1 = min(inner.shape[1], name_segs[-1][1] + int(pitch))
        pad = int(round(pitch))
        crop = np.ascontiguousarray(inner[max(0, ly0 - pad):min(inner.shape[0], ly1 + pad), nx0:nx1])
        ocr = self.get_ocr()
        if ocr is None:
            out["reason"] = "ocr-unavailable"
            out["error"] = self._ocr_error
            return out
        texts = []
        for img in self._name_variants(crop, pitch):
            try:
                res = ocr.recognize(img)
            except Exception as e:  # noqa: BLE001
                out["error"] = str(e)
                continue
            texts.append(" ".join(ln.text for ln in res))
        out["texts"] = texts
        item, score, second, reason = self.names.match(texts, pattern)
        out.update({"item": item, "score": round(score, 3), "second": round(second, 3), "reason": reason})
        return out

    @staticmethod
    def _name_variants(crop, pitch):
        """OCR 에 넣을 이름 이미지 변형들.

        Windows OCR 은 이 픽셀 폰트를 '텍셀 약 3.3px' (2560x1600, GUI 배율 4) 크기에서 가장 잘 읽으므로
        먼저 그 크기로 맞춘 뒤(최근접), 1.5배 최근접 / 부드러운(쌍선형) 변형을 더 만들어
        세 결과를 모두 후보로 쓴다 (이름 매칭에서 후보별 최고 점수 사용).
        """
        from PIL import Image
        im = Image.fromarray(crop)
        seen = set()
        for factor, flt in NAME_OCR_VARIANTS:
            k = NAME_OCR_PITCH * factor / pitch
            if abs(k - 1.0) < 0.02:
                key = ("same",)
            else:
                key = (round(k, 2), flt)
            if key in seen:
                continue
            seen.add(key)
            if key == ("same",):
                yield crop
                continue
            resample = Image.NEAREST if flt == "nearest" else Image.BILINEAR
            w = max(1, int(round(im.width * k)))
            h = max(1, int(round(im.height * k)))
            yield np.ascontiguousarray(np.array(im.resize((w, h), resample)))


# 이름 OCR 기준 텍셀 크기(물리 px). 이 폰트는 텍셀 약 3.3px 일 때 Windows OCR 인식이 가장 좋았음
NAME_OCR_PITCH = 4 * G.FONT_TEXEL_PER_GUI_PX
# 이름 OCR 변형 목록: (기준 대비 배율, 확대 방식). 여러 변형의 OCR 결과를 모두 매칭 후보로 씀
# (많을수록 정확하지만 변형 1개당 OCR 약 20~40ms)
NAME_OCR_VARIANTS = (
    (1.0, "nearest"),
    (1.5, "nearest"),
    (0.75, "bilinear"),
)

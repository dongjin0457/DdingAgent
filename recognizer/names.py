# -*- coding: utf-8 -*-
"""
아이템 이름 퍼지 매칭

Windows OCR 은 픽셀 폰트 한글 이름을 자주 틀린다 (예: '마늘 양갈비' -> '마를 임길비').
그래서 두 가지 증거를 합친다.
  1) 글자 유사도: 한글을 자모(초성/중성/종성)로 풀어서 비교 -> '갈'/'길' 같은 오인식에 관대
  2) 모양 유사도: 이름 줄의 픽셀에서 잰 '단어별 글자 수' (예: 토마토 파인애플 피자 = [3, 4, 2])
     한글 음절은 폭이 일정해서 OCR 없이도 정확하게 셀 수 있음
최종 점수가 기준 미만이거나 1등과 2등이 너무 비슷하면(애매) 매칭을 거부한다.
"""

import difflib
import re

# ============================================================================
# 튜닝 상수
# ============================================================================

# 최종 점수 = TEXT_WEIGHT x 글자 유사도 + (1 - TEXT_WEIGHT) x 모양 유사도
TEXT_WEIGHT = 0.6

# 최종 점수가 이 값 미만이면 매칭 실패 (0~1)
NAME_MATCH_MIN = 0.55

# 1등과 2등 점수 차이가 이 값 미만이면 '애매함' 으로 매칭 거부
NAME_MATCH_MARGIN = 0.06

# 단어 단위 유사도(여러 OCR 변형의 단어를 조합)에 곱하는 가중치. 조합은 우연히 맞을 여지가 더 커서 약간 낮춤
WORD_SIM_WEIGHT = 0.95

# 모양 정보가 없을 때(이름 줄 분석 실패) 글자 유사도만으로 매칭할 때의 기준
TEXT_ONLY_MIN = 0.70
TEXT_ONLY_MARGIN = 0.12

_HANGUL_BASE = 0xAC00
_CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
_JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"
_JONG = " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"


def compact(s):
    """비교용: 한글/영문/숫자만 남김 (공백, 기호, OCR 잡음 제거)."""
    return "".join(ch for ch in s if ch.isalnum())


def to_jamo(s):
    out = []
    for ch in s:
        c = ord(ch)
        if 0xAC00 <= c <= 0xD7A3:
            k = c - _HANGUL_BASE
            out.append(_CHO[k // 588])
            out.append(_JUNG[(k % 588) // 28])
            j = _JONG[k % 28]
            if j != " ":
                out.append(j)
        else:
            out.append(ch.lower())
    return "".join(out)


def syllable_pattern(name):
    """이름의 단어별 글자 수 (예: '토마토 파인애플 피자' -> [3, 4, 2])."""
    return [len(compact(w)) for w in re.split(r"\s+", name.strip()) if compact(w)]


def text_similarity(ocr_text, name):
    a = to_jamo(compact(ocr_text))
    b = to_jamo(compact(name))
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def word_similarity(ocr_texts, name):
    """단어 단위 유사도: 이름의 각 단어를 모든 OCR 결과의 모든 단어 중 가장 비슷한 것과 비교.

    OCR 변형마다 다른 단어를 맞히는 경우(예: 변형1='달콤 ..', 변형2='.. 시리글')를 합쳐서 활용.
    이름 단어 길이(자모 수)로 가중 평균.
    """
    tokens = []
    for t in ocr_texts:
        tokens.extend(to_jamo(compact(w)) for w in re.split(r"\s+", t) if compact(w))
    if not tokens:
        return 0.0
    total = 0.0
    weight = 0
    for w in re.split(r"\s+", name.strip()):
        jw = to_jamo(compact(w))
        if not jw:
            continue
        best = max(difflib.SequenceMatcher(None, tk, jw).ratio() for tk in tokens)
        total += best * len(jw)
        weight += len(jw)
    return total / weight if weight else 0.0


def shape_similarity(measured, expected):
    """단어별 글자 수 패턴 유사도 (0~1). measured 가 None 이면 None."""
    if measured is None:
        return None
    if not measured or not expected:
        return 0.0
    if len(measured) == len(expected):
        diff = sum(abs(a - b) for a, b in zip(measured, expected))
        return max(0.0, 1.0 - diff / float(max(1, sum(expected))) * 2.0)
    # 단어 수가 다르면 전체 글자 수만 비교 (띄어쓰기 차이) - 크게 감점
    diff = abs(sum(measured) - sum(expected))
    return max(0.0, 0.5 - diff / float(max(1, sum(expected))))


class NameMatcher:
    """알려진 아이템 목록에 대한 이름 매칭기."""

    def __init__(self, items=None):
        self.items = []
        self.set_items(items or [])

    def set_items(self, items):
        """items: [{name, category?, min?, max?}]"""
        clean = []
        for it in items:
            try:
                name = str(it.get("name", "")).strip()
            except AttributeError:
                continue
            if not name:
                continue
            clean.append({
                "name": name,
                "category": it.get("category"),
                "min": _num(it.get("min")),
                "max": _num(it.get("max")),
                "_pattern": syllable_pattern(name),
            })
        self.items = clean

    def match(self, ocr_texts, measured_pattern=None):
        """ocr_texts: OCR 결과 후보 문자열 목록 (여러 전처리 결과). measured_pattern: 픽셀로 잰 글자 수.

        반환: (item dict 또는 None, 점수, 2등 점수, 이유)
        """
        if not self.items:
            return None, 0.0, 0.0, "no-known-items"
        texts = [t for t in (ocr_texts or []) if t and compact(t)]
        scored = []
        for it in self.items:
            ts = max([text_similarity(t, it["name"]) for t in texts]
                     + [word_similarity(texts, it["name"]) * WORD_SIM_WEIGHT], default=0.0)
            ss = shape_similarity(measured_pattern, it["_pattern"])
            if ss is None:
                sc = ts
            else:
                sc = TEXT_WEIGHT * ts + (1.0 - TEXT_WEIGHT) * ss
            scored.append((sc, ts, it))
        scored.sort(key=lambda x: x[0], reverse=True)
        best = scored[0]
        second = scored[1][0] if len(scored) > 1 else 0.0
        if measured_pattern is None:
            lo, margin = TEXT_ONLY_MIN, TEXT_ONLY_MARGIN
        else:
            lo, margin = NAME_MATCH_MIN, NAME_MATCH_MARGIN
        if best[0] < lo:
            return None, best[0], second, "low-score"
        if best[0] - second < margin:
            return None, best[0], second, "ambiguous"
        return best[2], best[0], second, "ok"


def _num(v):
    try:
        if v is None or v == "":
            return None
        f = float(v)
        return f if f == f else None  # NaN 제외
    except (TypeError, ValueError):
        return None

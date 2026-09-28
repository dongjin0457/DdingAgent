# -*- coding: utf-8 -*-
"""
띵타이쿤 툴팁 자동 인식 엔진

마인크래프트 화면에서 아이템 툴팁을 찾아 이름/희귀도/판매가/나의 판매가/과거 시세를 읽는다.
    - detect.py   : 색상 무관 툴팁 검출 (테두리 구조)
    - glyphs.py   : 픽셀 폰트 숫자 템플릿 매칭 (digit_templates.json)
    - ocr.py      : Windows 내장 OCR (이름 읽기용)
    - names.py    : 알려진 아이템 이름과 퍼지 매칭
    - reader.py   : 판독 파이프라인 (프레임 -> 이벤트)
    - capture.py  : DXGI Desktop Duplication 화면 캡처
    - win32.py    : 마인크래프트 창 찾기 / DPI
    - hotkey.py   : 전역 단축키 (RegisterHotKey)
    - engine.py   : 작업 스레드 (캡처 -> 검출 -> 중복 제거 -> 판독 -> 콜백)
    - selftest.py : exe 안에서 OCR/판독이 되는지 확인하는 자가 진단 (--selftest)

이벤트 형식
    {name, category|None, rarity|None, sell|None, my|None, history: [{day, price}], ts, confidence}
"""

from .detect import Tooltip, detect_tooltip  # noqa: F401
from .engine import CaptureEngine  # noqa: F401
from .hotkey import DEFAULT_HOTKEY, HotkeyManager  # noqa: F401
from .reader import TooltipReader  # noqa: F401

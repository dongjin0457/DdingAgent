# -*- coding: utf-8 -*-
"""
Windows 내장 OCR (Windows.Media.Ocr, PyWinRT) 래퍼

- 한국어(ko) 인식기 사용. 윈도우 한국어 언어팩에 OCR 기능이 포함되어 있어야 함
  (한국어 윈도우에는 기본 포함. 없으면 설정 > 언어 > 한국어 > 옵션 에서 설치)
- 입력: HxWx3 RGB 또는 HxWx4 BGRA uint8 numpy 배열
- 출력: OcrLine 목록 (text, 단어별 박스, 줄 박스)
- 한 인스턴스는 한 스레드에서만 사용할 것 (내부에 전용 asyncio 루프를 가짐)
"""

import asyncio
import threading

import numpy as np

# ============================================================================
# 튜닝 상수
# ============================================================================

# OCR 언어 태그 (띵타이쿤 툴팁은 한국어 + 숫자)
OCR_LANG = "ko"

# OCR 입력 이미지 가장자리 여백 (픽셀). 글자가 가장자리에 붙어 있으면 인식률이 떨어짐
OCR_PAD = 16


class OcrUnavailable(RuntimeError):
    """OCR 엔진을 만들 수 없음 (언어팩 없음 / winrt 패키지 없음)."""


class OcrLine:
    __slots__ = ("text", "words", "x0", "y0", "x1", "y1")

    def __init__(self, text, words):
        self.text = text
        self.words = words  # [(text, x0, y0, x1, y1)]
        if words:
            self.x0 = min(w[1] for w in words)
            self.y0 = min(w[2] for w in words)
            self.x1 = max(w[3] for w in words)
            self.y1 = max(w[4] for w in words)
        else:
            self.x0 = self.y0 = self.x1 = self.y1 = 0

    def __repr__(self):
        return "OcrLine(%r, y=%d-%d)" % (self.text, self.y0, self.y1)


class WinOcr:
    """Windows OCR 엔진. recognize(img, scale=1.0) -> [OcrLine] (좌표는 입력 이미지 기준)."""

    def __init__(self, lang=OCR_LANG):
        try:
            import winrt.windows.globalization as glob
            import winrt.windows.graphics.imaging as gi
            import winrt.windows.media.ocr as ocr
            import winrt.windows.storage.streams as ss
        except Exception as e:  # noqa: BLE001
            raise OcrUnavailable("winrt OCR 패키지를 불러오지 못함: %s" % e)
        self._gi = gi
        self._ss = ss
        engine = None
        try:
            engine = ocr.OcrEngine.try_create_from_language(glob.Language(lang))
        except Exception:  # noqa: BLE001
            engine = None
        if engine is None:
            raise OcrUnavailable("Windows OCR 언어팩(%s)이 설치되어 있지 않음" % lang)
        self.engine = engine
        self.max_dim = int(ocr.OcrEngine.max_image_dimension)
        self._loop = asyncio.new_event_loop()
        self._lock = threading.Lock()

    def close(self):
        try:
            self._loop.close()
        except Exception:  # noqa: BLE001
            pass

    def _to_bitmap(self, img):
        gi, ss = self._gi, self._ss
        if img.ndim == 2:
            img = np.repeat(img[:, :, None], 3, axis=2)
        h, w = img.shape[:2]
        if img.shape[2] == 3:  # RGB -> BGRA
            bgra = np.empty((h, w, 4), np.uint8)
            bgra[:, :, 0] = img[:, :, 2]
            bgra[:, :, 1] = img[:, :, 1]
            bgra[:, :, 2] = img[:, :, 0]
            bgra[:, :, 3] = 255
        else:
            bgra = np.ascontiguousarray(img)
        n = bgra.nbytes
        buf = ss.Buffer(n)
        buf.length = n
        memoryview(buf)[:] = bgra.tobytes()
        sb = gi.SoftwareBitmap(gi.BitmapPixelFormat.BGRA8, w, h, gi.BitmapAlphaMode.PREMULTIPLIED)
        sb.copy_from_buffer(buf)
        return sb

    async def _rec(self, sb):
        return await self.engine.recognize_async(sb)

    def recognize(self, img):
        """img(uint8 RGB/BGRA/gray) -> [OcrLine]. 좌표는 img 기준 (여백 제외)."""
        pad = OCR_PAD
        if img.ndim == 2:
            img = np.pad(img, pad, mode="edge")
        else:
            img = np.pad(img, ((pad, pad), (pad, pad), (0, 0)), mode="edge")
        h, w = img.shape[:2]
        if max(h, w) > self.max_dim:
            raise ValueError("OCR 이미지가 너무 큼: %dx%d (최대 %d)" % (w, h, self.max_dim))
        with self._lock:
            sb = self._to_bitmap(img)
            res = self._loop.run_until_complete(self._rec(sb))
        out = []
        for ln in res.lines:
            words = []
            for wd in ln.words:
                r = wd.bounding_rect
                words.append((wd.text, r.x - pad, r.y - pad, r.x + r.width - pad, r.y + r.height - pad))
            out.append(OcrLine(ln.text, words))
        return out

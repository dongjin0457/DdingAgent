# -*- coding: utf-8 -*-
"""
자동 인식 엔진 (작업 스레드 1개)

흐름 (자동 캡처가 켜져 있을 때)
    마인크래프트 창 찾기 -> 최소화 아님 + 전면 창 -> 클라이언트 영역 DXGI 캡처 (CAPTURE_FPS)
    -> 툴팁 검출 -> 글자 영역 해시 -> 같은 해시가 STABLE_FRAMES 번 연속이면 판독
    -> 이전에 보낸 것과 다른 내용이면 on_result(event)
창이 없거나 최소화/비전면이면 IDLE_INTERVAL_SEC 마다 한 번씩만 확인 (CPU 거의 0).

force_read() 는 중복 검사를 무시하고 지금 화면을 한 번 판독 (사용자가 누른 단축키/버튼용).
OCR 엔진과 DXGI 객체는 모두 이 작업 스레드 안에서만 만들고 쓴다.
캡처한 프레임은 메모리에서만 처리하고 파일로 저장하지 않으며, 게임에는 아무 입력도 보내지 않는다.
"""

import logging
import threading
import time

from . import win32
from .capture import CaptureError, DxgiCapture
from .detect import detect_tooltip, to_rgb
from .reader import TooltipReader, text_hash

log = logging.getLogger("dtc.engine")

# ============================================================================
# 튜닝 상수
# ============================================================================

# 게임 화면 캡처 횟수 (초당). 3~4 정도면 CPU 사용량이 매우 적음. 높이면 반응이 빨라지지만 CPU 증가
CAPTURE_FPS = 4.0

# 마인크래프트 창이 없거나 최소화/비전면일 때 다시 확인하는 간격(초)
IDLE_INTERVAL_SEC = 1.0

# 같은 툴팁 해시가 이 횟수만큼 연속으로 보여야 판독 (마우스 이동 중 반쯤 그려진 툴팁 방지)
STABLE_FRAMES = 2

# 창 목록 전체 검색(EnumWindows) 최소 간격(초). 찾은 창이 살아 있으면 다시 검색하지 않음
WINDOW_RESCAN_SEC = 1.0

# 캡처 오류가 나면 DXGI 객체를 버리고 이 시간(초) 뒤에 다시 만듦 (오류가 계속되면 점점 늘림, 최대 MAX)
CAPTURE_RETRY_SEC = 1.0
CAPTURE_RETRY_MAX_SEC = 10.0

# force_read() 가 결과를 기다리는 최대 시간(초)
FORCE_READ_TIMEOUT_SEC = 5.0

# 실제 fps 계산용 지수이동평균 계수 (0~1, 클수록 최근 값 반영이 빠름)
FPS_EMA = 0.2


class CaptureEngine:
    """on_result(event dict), on_status(status dict) 콜백은 작업 스레드에서 호출됨 (빨리 끝낼 것)."""

    def __init__(self, on_result=None, on_status=None):
        self.on_result = on_result
        self.on_status = on_status
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread = None
        self._known_items = []
        self._known_dirty = False
        self._force = []            # [(Event, box)] 대기 중인 강제 판독 요청
        self._status = {
            "enabled": False,
            "running": False,
            "minecraftFound": False,
            "foreground": False,
            "lastReadAt": None,
            "lastError": None,
            "fpsActual": 0.0,
        }
        self._last_pushed = None
        self.last_event = None
        self.last_miss = None       # 마지막 인식 실패 이유 (디버그용)

    # --- 공개 API (다른 스레드에서 호출) ----------------------------------------
    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="dtc-capture", daemon=True)
        self._thread.start()

    def stop(self, timeout=3.0):
        self._stop.set()
        self._wake.set()
        t = self._thread
        if t:
            t.join(timeout)
        self._thread = None

    def set_enabled(self, enabled):
        with self._lock:
            self._status["enabled"] = bool(enabled)
            if not enabled:
                self._status["fpsActual"] = 0.0
        self._wake.set()
        self._push_status(force=True)
        return self.status()

    def set_known_items(self, items):
        clean = []
        for it in items or []:
            if isinstance(it, dict) and it.get("name"):
                clean.append({k: it.get(k) for k in ("name", "category", "min", "max")})
        with self._lock:
            self._known_items = clean
            self._known_dirty = True
        return len(clean)

    def status(self):
        with self._lock:
            st = dict(self._status)
        st["running"] = bool(self._thread and self._thread.is_alive())
        return st

    def request_force(self):
        """비동기 강제 판독 요청 (단축키용). 결과는 on_result 로 전달."""
        ev = threading.Event()
        with self._lock:
            self._force.append((ev, {}))
        self._wake.set()
        return ev

    def force_read(self, timeout=FORCE_READ_TIMEOUT_SEC):
        """강제 판독 후 결과 대기. 반환 {"ok": True, "result": event} 또는 {"ok": False, "error": "..."}"""
        if not (self._thread and self._thread.is_alive()):
            return {"ok": False, "error": "인식 엔진이 실행 중이 아닙니다"}
        ev = threading.Event()
        box = {}
        with self._lock:
            self._force.append((ev, box))
        self._wake.set()
        if not ev.wait(timeout):
            return {"ok": False, "error": "시간 초과"}
        return box.get("result", {"ok": False, "error": "알 수 없는 오류"})

    # --- 내부 ------------------------------------------------------------------
    def _set(self, **kw):
        with self._lock:
            self._status.update(kw)

    def _push_status(self, force=False):
        st = self.status()
        key = (st["enabled"], st["running"], st["minecraftFound"], st["foreground"],
               st["lastReadAt"], st["lastError"])
        if not force and key == self._last_pushed:
            return
        self._last_pushed = key
        if self.on_status:
            try:
                self.on_status(st)
            except Exception:  # noqa: BLE001
                log.exception("on_status 콜백 실패")

    def _emit(self, event):
        self.last_event = event
        if self.on_result:
            try:
                self.on_result(event)
            except Exception:  # noqa: BLE001
                log.exception("on_result 콜백 실패")

    def _take_force(self):
        with self._lock:
            reqs, self._force = self._force, []
        return reqs

    def _run(self):
        win32.set_thread_dpi_aware()
        reader = TooltipReader()
        cap = None
        hwnd = None
        last_scan = 0.0
        retry_at = 0.0
        retry_delay = CAPTURE_RETRY_SEC
        prev_hash = None
        streak = 0
        emitted_hash = None
        fps = 0.0
        last_frame_t = None
        self._set(running=True)
        self._push_status(force=True)
        try:
            while not self._stop.is_set():
                with self._lock:
                    if self._known_dirty:
                        reader.set_known_items(self._known_items)
                        self._known_dirty = False
                        emitted_hash = None  # 목록이 바뀌면 같은 툴팁도 다시 판독
                    enabled = self._status["enabled"]
                forces = self._take_force()
                if not enabled and not forces:
                    if cap is not None:
                        cap.close()
                        cap = None
                    self._set(fpsActual=0.0)
                    self._wake.wait(IDLE_INTERVAL_SEC)
                    self._wake.clear()
                    continue

                t_loop = time.perf_counter()
                # ---- 창 찾기 ----
                now = time.monotonic()
                if hwnd is None or not win32.is_alive(hwnd) or not win32.is_minecraft_window(hwnd):
                    hwnd = None
                    if now - last_scan >= WINDOW_RESCAN_SEC or forces:
                        last_scan = now
                        hwnd = win32.find_minecraft_window()
                found = hwnd is not None
                minimized = found and win32.is_minimized(hwnd)
                fg = found and not minimized and win32.is_foreground(hwnd)
                self._set(minecraftFound=found, foreground=bool(fg))
                self._push_status()

                if not found or minimized or (not fg and not forces):
                    for ev, box in forces:
                        box["result"] = {"ok": False, "error": "마인크래프트 창을 찾지 못했습니다" if not found
                                         else "마인크래프트 창이 최소화되어 있습니다"}
                        ev.set()
                    prev_hash, streak = None, 0
                    if cap is not None:
                        cap.close()
                        cap = None
                    self._set(fpsActual=0.0)
                    self._wake.wait(IDLE_INTERVAL_SEC)
                    self._wake.clear()
                    continue

                # ---- 캡처 ----
                frame = None
                if time.monotonic() >= retry_at:
                    try:
                        rect = win32.client_rect_screen(hwnd)
                        if rect is None or rect[2] < 100 or rect[3] < 100:
                            raise CaptureError("창 영역이 올바르지 않음")
                        if cap is None:
                            cap = DxgiCapture()
                        frame = cap.grab(*rect)
                        retry_delay = CAPTURE_RETRY_SEC
                        err = self.status().get("lastError") or ""
                        if err.startswith("캡처 실패"):
                            self._set(lastError=None)  # 캡처가 회복되면 오류 표시 해제
                    except Exception as e:  # noqa: BLE001
                        log.warning("캡처 실패: %s", e)
                        if cap is not None:
                            cap.close()
                            cap = None
                        retry_at = time.monotonic() + retry_delay
                        retry_delay = min(CAPTURE_RETRY_MAX_SEC, retry_delay * 2)
                        self._set(lastError="캡처 실패: %s" % e)
                        self._push_status()
                if frame is None:
                    for ev, box in forces:
                        box["result"] = {"ok": False, "error": self.status().get("lastError") or "캡처 실패"}
                        ev.set()
                    self._sleep_until(t_loop)
                    continue

                tnow = time.perf_counter()
                if last_frame_t is not None:
                    inst = 1.0 / max(1e-3, tnow - last_frame_t)
                    fps = inst if fps == 0 else fps + FPS_EMA * (inst - fps)
                last_frame_t = tnow
                self._set(fpsActual=round(fps, 2) if enabled else 0.0)

                # ---- 검출 / 중복 검사 / 판독 ----
                try:
                    tip = detect_tooltip(frame)
                    event = None
                    if tip is None:
                        prev_hash, streak = None, 0
                        info = {"reason": "no-tooltip"}
                    else:
                        x0, y0, x1, y1 = tip.inner_box()
                        inner = to_rgb(frame[y0:y1, x0:x1])
                        h = text_hash(inner)
                        streak = streak + 1 if h == prev_hash else 1
                        prev_hash = h
                        info = {"reason": "waiting"}
                        if forces or (streak >= STABLE_FRAMES and h != emitted_hash):
                            event, info = reader.read_inner(inner, tip, {"timings": {}}, ts=time.time())
                            emitted_hash = h  # 실패해도 같은 내용은 다시 OCR 하지 않음
                    if event is not None:
                        self._set(lastReadAt=event["ts"], lastError=None)
                        self._emit(event)
                        self._push_status()
                    elif info.get("reason") not in ("no-tooltip", "waiting"):
                        self.last_miss = {"reason": info.get("reason"), "ts": time.time(),
                                          "name": info.get("name", {}).get("texts")}
                        if reader.ocr_error:
                            self._set(lastError="OCR 사용 불가: %s" % reader.ocr_error)
                            self._push_status()
                    for ev, box in forces:
                        if event is not None:
                            box["result"] = {"ok": True, "result": event}
                        else:
                            box["result"] = {"ok": False, "error": _reason_text(info.get("reason")),
                                             "reason": info.get("reason")}
                        ev.set()
                except Exception as e:  # noqa: BLE001
                    log.exception("판독 실패")
                    self._set(lastError="판독 오류: %s" % e)
                    self._push_status()
                    for ev, box in forces:
                        box["result"] = {"ok": False, "error": str(e)}
                        ev.set()
                self._sleep_until(t_loop)
        finally:
            if cap is not None:
                cap.close()
            try:
                if reader._ocr is not None:
                    reader._ocr.close()
            except Exception:  # noqa: BLE001
                pass
            self._set(running=False, fpsActual=0.0)
            self._push_status(force=True)

    def _sleep_until(self, t_loop):
        period = 1.0 / max(0.1, CAPTURE_FPS)
        remain = period - (time.perf_counter() - t_loop)
        if remain > 0:
            self._wake.wait(remain)
            self._wake.clear()


_REASONS = {
    "no-tooltip": "툴팁을 찾지 못했습니다 (아이템 위에 마우스를 올려 주세요)",
    "too-few-lines": "툴팁 내용을 읽지 못했습니다",
    "no-price-rows": "가격 정보가 없는 툴팁입니다",
    "name-low-score": "아이템 이름을 알 수 없습니다",
    "name-ambiguous": "아이템 이름이 애매합니다",
    "name-no-known-items": "아이템 목록이 아직 전달되지 않았습니다",
    "name-ocr-unavailable": "Windows OCR 을 사용할 수 없습니다 (한국어 언어팩 확인)",
    "prices-rejected": "가격이 알려진 범위와 너무 달라 버렸습니다",
}


def _reason_text(reason):
    return _REASONS.get(reason or "", "인식 실패 (%s)" % reason)

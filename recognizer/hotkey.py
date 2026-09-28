# -*- coding: utf-8 -*-
"""
전역 단축키 (Windows 표준 단축키 등록 API RegisterHotKey 사용, 관리자 권한 불필요)

등록한 키 조합 1개가 눌렸을 때만 Windows 가 이 앱에 알려 준다 (다른 키 입력은 전달되지 않음).
단축키가 눌리면 이 앱이 화면을 한 번 다시 읽을 뿐이고, 게임에는 아무 입력도 보내지 않는다.

RegisterHotKey 는 '등록한 스레드의 메시지 큐' 로 WM_HOTKEY 를 보내므로 전용 스레드에서 메시지 루프를 돈다.
단축키 변경(set_hotkey)도 그 스레드 안에서 해야 해서, 요청을 큐에 넣고 WM_APP 메시지로 깨운 뒤
결과를 기다린다.
"""

import ctypes
import ctypes.wintypes as wt
import logging
import queue
import threading

log = logging.getLogger("dtc.hotkey")

# ============================================================================
# 튜닝 상수
# ============================================================================

# 기본 단축키 (마인크래프트 기본 조작과 겹치지 않는 조합). 웹 앱이 저장된 값으로 다시 설정함
DEFAULT_HOTKEY = "Ctrl+Shift+R"

# RegisterHotKey 식별 번호 (프로세스 안에서만 유일하면 됨)
HOTKEY_ID = 0xB0A1

# set_hotkey 가 메시지 스레드의 처리 결과를 기다리는 최대 시간(초)
REQUEST_TIMEOUT_SEC = 3.0

MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_WIN = 0x0008
MOD_NOREPEAT = 0x4000       # 키를 누르고 있어도 반복 발생 안 함
WM_HOTKEY = 0x0312
WM_QUIT = 0x0012
WM_APP = 0x8000
ERROR_HOTKEY_ALREADY_REGISTERED = 1409

_MODS = {
    "ctrl": MOD_CONTROL, "control": MOD_CONTROL, "컨트롤": MOD_CONTROL,
    "shift": MOD_SHIFT, "쉬프트": MOD_SHIFT, "시프트": MOD_SHIFT,
    "alt": MOD_ALT, "알트": MOD_ALT,
    "win": MOD_WIN, "windows": MOD_WIN, "meta": MOD_WIN, "cmd": MOD_WIN, "super": MOD_WIN,
}

# 글자/숫자 외 키 이름 -> 가상 키 코드
_VK = {
    "space": 0x20, "spacebar": 0x20, "enter": 0x0D, "return": 0x0D, "tab": 0x09, "esc": 0x1B,
    "escape": 0x1B, "backspace": 0x08, "insert": 0x2D, "ins": 0x2D, "delete": 0x2E, "del": 0x2E,
    "home": 0x24, "end": 0x23, "pageup": 0x21, "pgup": 0x21, "pagedown": 0x22, "pgdn": 0x22,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27, "arrowup": 0x26, "arrowdown": 0x28,
    "arrowleft": 0x25, "arrowright": 0x27, "pause": 0x13, "printscreen": 0x2C, "scrolllock": 0x91,
    "`": 0xC0, "backquote": 0xC0, "-": 0xBD, "minus": 0xBD, "=": 0xBB, "equal": 0xBB,
    "[": 0xDB, "]": 0xDD, "\\": 0xDC, ";": 0xBA, "'": 0xDE, ",": 0xBC, ".": 0xBE, "/": 0xBF,
}
for _i in range(1, 25):
    _VK["f%d" % _i] = 0x70 + _i - 1
for _i in range(10):
    _VK["num%d" % _i] = 0x60 + _i
    _VK["numpad%d" % _i] = 0x60 + _i

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
user32.RegisterHotKey.argtypes = [wt.HWND, ctypes.c_int, wt.UINT, wt.UINT]
user32.UnregisterHotKey.argtypes = [wt.HWND, ctypes.c_int]
user32.PostThreadMessageW.argtypes = [wt.DWORD, wt.UINT, wt.WPARAM, wt.LPARAM]
user32.GetMessageW.argtypes = [ctypes.POINTER(wt.MSG), wt.HWND, wt.UINT, wt.UINT]
user32.PeekMessageW.argtypes = [ctypes.POINTER(wt.MSG), wt.HWND, wt.UINT, wt.UINT, wt.UINT]


class HotkeyError(ValueError):
    pass


def parse_hotkey(spec):
    """'Ctrl+Shift+R' -> (modifiers, vk, 정규화된 문자열). 형식이 틀리면 HotkeyError."""
    if not isinstance(spec, str) or not spec.strip():
        raise HotkeyError("단축키가 비어 있습니다")
    parts = [p.strip() for p in spec.replace(" ", "").split("+")]
    # '+' 키 자체('Ctrl++')는 지원하지 않음
    if any(p == "" for p in parts):
        raise HotkeyError("단축키 형식이 올바르지 않습니다: %s" % spec)
    mods = 0
    key = None
    names = []
    for p in parts:
        low = p.lower()
        if low in _MODS:
            mods |= _MODS[low]
            continue
        if key is not None:
            raise HotkeyError("일반 키는 하나만 지정할 수 있습니다: %s" % spec)
        if len(p) == 1 and p.isascii() and p.isalnum():
            key = ord(p.upper())
            names.append(p.upper())
        elif low in _VK:
            key = _VK[low]
            names.append(p.upper() if low.startswith("f") and low[1:].isdigit() else p.capitalize())
        elif low.startswith("key") and len(low) == 4 and low[3].isalpha():  # KeyboardEvent.code 'KeyR'
            key = ord(low[3].upper())
            names.append(low[3].upper())
        elif low.startswith("digit") and len(low) == 6 and low[5].isdigit():
            key = ord(low[5])
            names.append(low[5])
        else:
            raise HotkeyError("알 수 없는 키 이름: %s" % p)
    if key is None:
        raise HotkeyError("일반 키가 없습니다 (예: Ctrl+Shift+R)")
    if mods == 0 and not (0x70 <= key <= 0x87):
        # 조합 키 없이 글자 하나만 전역 등록하면 다른 프로그램에서 그 글자를 못 치게 됨
        raise HotkeyError("Ctrl/Shift/Alt 중 하나 이상과 함께 지정하세요 (F1~F24 는 단독 가능)")
    label = []
    if mods & MOD_CONTROL:
        label.append("Ctrl")
    if mods & MOD_SHIFT:
        label.append("Shift")
    if mods & MOD_ALT:
        label.append("Alt")
    if mods & MOD_WIN:
        label.append("Win")
    return mods, key, "+".join(label + names)


class HotkeyManager:
    """전역 단축키 1개 관리. on_press 는 메시지 스레드에서 호출되므로 오래 걸리는 일을 하면 안 됨."""

    def __init__(self, on_press):
        self.on_press = on_press
        self._thread = None
        self._tid = None
        self._ready = threading.Event()
        self._requests = queue.Queue()
        self.current = None      # 현재 등록된 단축키 문자열 (없으면 None)
        self.last_error = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._ready.clear()
        self._thread = threading.Thread(target=self._run, name="dtc-hotkey", daemon=True)
        self._thread.start()
        self._ready.wait(2.0)

    def stop(self):
        if self._tid:
            user32.PostThreadMessageW(self._tid, WM_QUIT, 0, 0)
        if self._thread:
            self._thread.join(2.0)
        self._thread = None
        self._tid = None

    def set_hotkey(self, spec):
        """단축키 변경. 반환: {"ok": True, "hotkey": "Ctrl+Shift+R"} 또는 {"ok": False, "error": "..."}

        spec 이 None/빈 문자열/'none' 이면 단축키 해제.
        """
        if spec is None or (isinstance(spec, str) and spec.strip().lower() in ("", "none", "off")):
            parsed = None
        else:
            try:
                parsed = parse_hotkey(spec)
            except HotkeyError as e:
                return {"ok": False, "error": str(e)}
        if not self._thread or not self._thread.is_alive() or not self._tid:
            return {"ok": False, "error": "단축키 스레드가 실행 중이 아닙니다"}
        done = threading.Event()
        box = {}
        self._requests.put((parsed, done, box))
        user32.PostThreadMessageW(self._tid, WM_APP + 1, 0, 0)
        if not done.wait(REQUEST_TIMEOUT_SEC):
            return {"ok": False, "error": "단축키 등록 응답 없음"}
        return box.get("result", {"ok": False, "error": "알 수 없는 오류"})

    # --- 메시지 스레드 ------------------------------------------------------
    def _register(self, parsed):
        user32.UnregisterHotKey(None, HOTKEY_ID)
        prev = self.current
        self.current = None
        if parsed is None:
            self.last_error = None
            return {"ok": True, "hotkey": None}
        mods, vk, label = parsed
        if user32.RegisterHotKey(None, HOTKEY_ID, mods | MOD_NOREPEAT, vk):
            self.current = label
            self.last_error = None
            log.info("단축키 등록: %s", label)
            return {"ok": True, "hotkey": label}
        err = ctypes.get_last_error()
        if err == ERROR_HOTKEY_ALREADY_REGISTERED:
            msg = "%s 는 다른 프로그램이 이미 사용 중입니다" % label
        else:
            msg = "%s 등록 실패 (오류 코드 %d)" % (label, err)
        self.last_error = msg
        log.warning("단축키 등록 실패: %s", msg)
        # 실패하면 이전 단축키를 되살림 (사용자가 단축키를 잃지 않도록)
        if prev:
            try:
                pm, pv, _ = parse_hotkey(prev)
                if user32.RegisterHotKey(None, HOTKEY_ID, pm | MOD_NOREPEAT, pv):
                    self.current = prev
            except HotkeyError:
                pass
        return {"ok": False, "error": msg, "hotkey": self.current}

    def _run(self):
        self._tid = kernel32.GetCurrentThreadId()
        msg = wt.MSG()
        # 메시지 큐를 먼저 만들어 둬야 PostThreadMessage 가 실패하지 않음
        user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 0)
        self._ready.set()
        try:
            while True:
                r = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
                if r == 0 or r == -1:
                    break
                if msg.message == WM_HOTKEY and msg.wParam == HOTKEY_ID:
                    try:
                        self.on_press()
                    except Exception:  # noqa: BLE001
                        log.exception("단축키 처리 실패")
                elif msg.message == WM_APP + 1:
                    while True:
                        try:
                            parsed, done, box = self._requests.get_nowait()
                        except queue.Empty:
                            break
                        try:
                            box["result"] = self._register(parsed)
                        except Exception as e:  # noqa: BLE001
                            box["result"] = {"ok": False, "error": str(e)}
                        done.set()
        finally:
            user32.UnregisterHotKey(None, HOTKEY_ID)
            self.current = None

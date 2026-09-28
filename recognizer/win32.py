# -*- coding: utf-8 -*-
"""
Win32 도우미 (ctypes): DPI 인식, 마인크래프트 창 찾기, 창 상태(최소화/전면), 클라이언트 영역(물리 픽셀)

DPI 주의
    화면이 150% 배율이면 DPI 를 모르는 스레드에서는 창 좌표가 '논리 픽셀'(1/1.5)로 나와서
    캡처 영역이 틀어진다. pywebview 창(UI)에는 영향을 주지 않도록 프로세스 전체가 아니라
    캡처 작업 스레드에만 Per-Monitor-V2 DPI 인식을 켠다 (set_thread_dpi_aware).
"""

import ctypes
import ctypes.wintypes as wt

# ============================================================================
# 튜닝 상수
# ============================================================================

# 마인크래프트 Java 에디션 창 클래스 이름 (GLFW 라이브러리가 만드는 창)
MC_WINDOW_CLASS = "GLFW30"

# 창 제목이 이 문자열로 시작하면 마인크래프트 창으로 간주 (예: "Minecraft 1.21.4 - 멀티플레이")
MC_TITLE_PREFIX = "Minecraft"

# True 면 창 클래스가 달라도(다른 런처/클라이언트) 제목만 맞으면 인정.
# 단 브라우저 탭 제목("Minecraft Wiki - Chrome")까지 잡힐 수 있어서 기본은 False
MC_ALLOW_ANY_CLASS = False

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

user32.GetForegroundWindow.restype = wt.HWND
user32.IsWindow.argtypes = [wt.HWND]
user32.IsIconic.argtypes = [wt.HWND]
user32.IsWindowVisible.argtypes = [wt.HWND]
user32.GetWindowTextLengthW.argtypes = [wt.HWND]
user32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
user32.GetClassNameW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
user32.GetClientRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
user32.ClientToScreen.argtypes = [wt.HWND, ctypes.POINTER(wt.POINT)]
try:
    user32.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
    user32.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
except AttributeError:  # 윈도우 10 1607 미만
    pass

_WNDENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
_DPI_CTX_PMV2 = ctypes.c_void_p(-4)
# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE
_DPI_CTX_PM = ctypes.c_void_p(-3)


def set_thread_dpi_aware():
    """현재 스레드만 Per-Monitor(V2) DPI 인식으로 (좌표 = 물리 픽셀). 성공 여부 반환."""
    try:
        if user32.SetThreadDpiAwarenessContext(_DPI_CTX_PMV2):
            return True
        return bool(user32.SetThreadDpiAwarenessContext(_DPI_CTX_PM))
    except Exception:  # noqa: BLE001
        return False


def set_process_dpi_aware():
    """프로세스 전체를 Per-Monitor-V2 로 (UI 가 없는 --selftest 등에서만 사용)."""
    try:
        if user32.SetProcessDpiAwarenessContext(_DPI_CTX_PMV2):
            return True
    except Exception:  # noqa: BLE001
        pass
    try:
        return ctypes.windll.shcore.SetProcessDpiAwareness(2) == 0
    except Exception:  # noqa: BLE001
        return False


def window_text(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def window_class(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def is_minecraft_window(hwnd):
    if not user32.IsWindowVisible(hwnd):
        return False
    title = window_text(hwnd)
    if not title.startswith(MC_TITLE_PREFIX):
        return False
    return MC_ALLOW_ANY_CLASS or window_class(hwnd) == MC_WINDOW_CLASS


def find_minecraft_window():
    """마인크래프트 창 HWND (없으면 None). 여러 개면 전면 창 우선, 아니면 첫 번째."""
    found = []

    def _cb(hwnd, _lp):
        try:
            if is_minecraft_window(hwnd):
                found.append(hwnd)
        except Exception:  # noqa: BLE001
            pass
        return True

    user32.EnumWindows(_WNDENUMPROC(_cb), 0)
    if not found:
        return None
    fg = user32.GetForegroundWindow()
    for h in found:
        if h == fg:
            return h
    return found[0]


def is_alive(hwnd):
    return bool(hwnd) and bool(user32.IsWindow(hwnd))


def is_minimized(hwnd):
    return bool(user32.IsIconic(hwnd))


def is_foreground(hwnd):
    fg = user32.GetForegroundWindow()
    return bool(fg) and fg == hwnd


def client_rect_screen(hwnd):
    """클라이언트 영역 (left, top, width, height) 화면 좌표. 호출 스레드가 DPI 인식이어야 물리 픽셀."""
    r = wt.RECT()
    if not user32.GetClientRect(hwnd, ctypes.byref(r)):
        return None
    p = wt.POINT(0, 0)
    if not user32.ClientToScreen(hwnd, ctypes.byref(p)):
        return None
    return p.x, p.y, r.right - r.left, r.bottom - r.top

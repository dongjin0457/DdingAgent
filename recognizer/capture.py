# -*- coding: utf-8 -*-
"""
DXGI Desktop Duplication 화면 캡처 (ctypes 만 사용, 추가 패키지 없음)

GDI(BitBlt) 방식은 매번 DWM 이 합성한 화면 전체를 GPU->CPU 로 읽어와서 상대적으로 느리다.
Desktop Duplication 은 Windows 가 제공하는 표준 화면 캡처 API 로, DWM 이 가진 화면 텍스처에서 필요한 영역만
GPU 안에서 작은 스테이징 텍스처로 복사한 뒤 그 부분만 CPU 로 읽는다 (OBS '디스플레이 캡처' 와 같은 방식).
그래서 초당 몇 장 정도로 읽을 때 CPU 사용량이 매우 적다.

- 읽는 것은 이미 모니터에 표시된 화면 픽셀뿐이며, 게임 프로세스/메모리/파일에는 접근하지 않는다
- 캡처한 이미지는 메모리(numpy 배열)에서만 처리하고 파일로 저장하지 않는다
- 캡처 대상 모니터 = 요청 영역 중심이 들어 있는 모니터. 창이 다른 모니터로 가면 자동으로 다시 만듦
- DXGI_ERROR_ACCESS_LOST (해상도 변경, 절전, 전체화면 전환, UAC 화면 등) 가 오면 객체를 다시 만듦
- 좌표는 모두 '물리 픽셀' (호출 스레드가 DPI 인식이어야 창 좌표와 맞음)
"""

import ctypes
import ctypes.wintypes as wt

import numpy as np

# ============================================================================
# 튜닝 상수
# ============================================================================

# AcquireNextFrame 대기 시간(ms). 0 이면 새 프레임이 없을 때 바로 돌아가서 직전 이미지를 재사용
ACQUIRE_TIMEOUT_MS = 0

# 처음 캡처하거나 영역이 바뀌었는데 새 프레임이 없을 때 한 번 더 기다릴 시간(ms)
FIRST_FRAME_WAIT_MS = 300

HRESULT = ctypes.c_long


def _hr(v):
    return v - (1 << 32)


DXGI_ERROR_WAIT_TIMEOUT = _hr(0x887A0027)
DXGI_ERROR_ACCESS_LOST = _hr(0x887A0026)
DXGI_ERROR_NOT_FOUND = _hr(0x887A0002)
DXGI_ERROR_INVALID_CALL = _hr(0x887A0001)
DXGI_ERROR_DEVICE_REMOVED = _hr(0x887A0005)
DXGI_ERROR_DEVICE_RESET = _hr(0x887A0007)
DXGI_FORMAT_B8G8R8A8_UNORM = 87
D3D11_USAGE_STAGING = 3
D3D11_CPU_ACCESS_READ = 0x20000
D3D11_MAP_READ = 1
D3D11_SDK_VERSION = 7


class CaptureError(OSError):
    """캡처 실패 (다시 만들면 회복될 수도 있음)."""


class GUID(ctypes.Structure):
    _fields_ = [("Data1", wt.DWORD), ("Data2", wt.WORD), ("Data3", wt.WORD), ("Data4", ctypes.c_ubyte * 8)]

    def __init__(self, s):
        super().__init__()
        s = s.strip("{}").replace("-", "")
        self.Data1 = int(s[0:8], 16)
        self.Data2 = int(s[8:12], 16)
        self.Data3 = int(s[12:16], 16)
        for i in range(8):
            self.Data4[i] = int(s[16 + 2 * i:18 + 2 * i], 16)


IID_IDXGIFactory1 = GUID("770aae78-f26f-4dba-a829-253c83d1b387")
IID_ID3D11Texture2D = GUID("6f15aaf2-d208-4e89-9ab4-489535d34f9c")
# IDXGIOutput1 IID 후보 (QueryInterface 로 확인). 둘 다 실패하면 같은 vtable 을 직접 사용
IID_IDXGIOutput1_CANDIDATES = ["00cd59e5-6c85-4a86-a4ea-4cec87d53e7b",
                               "00cd59e5-6c3e-4bee-b7d2-db52ad2d7c1c"]


class DXGI_OUTPUT_DESC(ctypes.Structure):
    _fields_ = [("DeviceName", wt.WCHAR * 32), ("DesktopCoordinates", wt.RECT),
                ("AttachedToDesktop", wt.BOOL), ("Rotation", wt.UINT), ("Monitor", wt.HMONITOR)]


class DXGI_OUTDUPL_FRAME_INFO(ctypes.Structure):
    _fields_ = [("LastPresentTime", ctypes.c_longlong), ("LastMouseUpdateTime", ctypes.c_longlong),
                ("AccumulatedFrames", wt.UINT), ("RectsCoalesced", wt.BOOL),
                ("ProtectedContentMaskedOut", wt.BOOL), ("PointerPosition", wt.POINT),
                ("PointerVisible", wt.BOOL), ("TotalMetadataBufferSize", wt.UINT),
                ("PointerShapeBufferSize", wt.UINT)]


class D3D11_TEXTURE2D_DESC(ctypes.Structure):
    _fields_ = [("Width", wt.UINT), ("Height", wt.UINT), ("MipLevels", wt.UINT), ("ArraySize", wt.UINT),
                ("Format", wt.UINT), ("SampleCount", wt.UINT), ("SampleQuality", wt.UINT),
                ("Usage", wt.UINT), ("BindFlags", wt.UINT), ("CPUAccessFlags", wt.UINT),
                ("MiscFlags", wt.UINT)]


class D3D11_MAPPED_SUBRESOURCE(ctypes.Structure):
    _fields_ = [("pData", ctypes.c_void_p), ("RowPitch", wt.UINT), ("DepthPitch", wt.UINT)]


class D3D11_BOX(ctypes.Structure):
    _fields_ = [("left", wt.UINT), ("top", wt.UINT), ("front", wt.UINT),
                ("right", wt.UINT), ("bottom", wt.UINT), ("back", wt.UINT)]


_PROTO_CACHE = {}


def _vcall(obj, idx, restype, argtypes, *args):
    """COM vtable idx 번 메서드 호출."""
    key = (restype, tuple(argtypes))
    proto = _PROTO_CACHE.get(key)
    if proto is None:
        proto = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)
        _PROTO_CACHE[key] = proto
    vtbl = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    return proto(vtbl[idx])(obj, *args)


def _release(obj):
    if obj:
        try:
            _vcall(obj, 2, wt.ULONG, [])
        except Exception:  # noqa: BLE001
            pass


def _check(hr, what):
    if hr < 0:
        raise CaptureError("%s 실패 HRESULT=0x%08X" % (what, hr & 0xFFFFFFFF))


_dxgi = None
_d3d11 = None


def _libs():
    global _dxgi, _d3d11
    if _dxgi is None:
        _dxgi = ctypes.windll.dxgi
        _d3d11 = ctypes.windll.d3d11
        _dxgi.CreateDXGIFactory1.argtypes = [ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)]
        _dxgi.CreateDXGIFactory1.restype = HRESULT
        _d3d11.D3D11CreateDevice.argtypes = [ctypes.c_void_p, wt.UINT, ctypes.c_void_p, wt.UINT,
                                             ctypes.c_void_p, wt.UINT, wt.UINT,
                                             ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wt.UINT),
                                             ctypes.POINTER(ctypes.c_void_p)]
        _d3d11.D3D11CreateDevice.restype = HRESULT
    return _dxgi, _d3d11


class DxgiCapture:
    """grab(left, top, width, height) -> HxWx4 BGRA uint8 (물리 픽셀 화면 좌표).

    새 프레임이 없으면(화면 변화 없음) 직전 결과를 그대로 돌려준다.
    """

    def __init__(self):
        self.dupl = self.device = self.context = self.staging = None
        self.out_rect = None       # (left, top, right, bottom) 현재 복제 중인 모니터 영역
        self.stage_size = None
        self.last = None
        self.last_region = None
        self.stats = {"new": 0, "reuse": 0, "recreate": 0}

    # --- 생성/해제 --------------------------------------------------------
    def _create_for_point(self, px, py):
        dxgi, d3d11 = _libs()
        fac = ctypes.c_void_p()
        _check(dxgi.CreateDXGIFactory1(ctypes.byref(IID_IDXGIFactory1), ctypes.byref(fac)), "CreateDXGIFactory1")
        found = None
        first = None
        try:
            ai = 0
            while found is None:
                ad = ctypes.c_void_p()
                hr = _vcall(fac, 12, HRESULT, [wt.UINT, ctypes.POINTER(ctypes.c_void_p)], ai, ctypes.byref(ad))
                if hr == DXGI_ERROR_NOT_FOUND:
                    break
                _check(hr, "EnumAdapters1")
                oi = 0
                keep_adapter = False
                while True:
                    out = ctypes.c_void_p()
                    hr = _vcall(ad, 7, HRESULT, [wt.UINT, ctypes.POINTER(ctypes.c_void_p)], oi, ctypes.byref(out))
                    if hr == DXGI_ERROR_NOT_FOUND:
                        break
                    desc = DXGI_OUTPUT_DESC()
                    _vcall(out, 7, HRESULT, [ctypes.POINTER(DXGI_OUTPUT_DESC)], ctypes.byref(desc))
                    r = desc.DesktopCoordinates
                    if r.left <= px < r.right and r.top <= py < r.bottom:
                        found = (ad, out, (r.left, r.top, r.right, r.bottom))
                        keep_adapter = True
                        break
                    _release(out)
                    oi += 1
                if not keep_adapter:
                    _release(ad)
                ai += 1
        finally:
            _release(fac)
        if found is None:
            raise CaptureError("좌표 (%d, %d) 를 포함하는 모니터를 찾지 못함" % (px, py))
        ad, out, rect = found
        try:
            out1 = ctypes.c_void_p()
            ok = False
            for s in IID_IDXGIOutput1_CANDIDATES:
                g = GUID(s)
                if _vcall(out, 0, HRESULT, [ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)],
                          ctypes.byref(g), ctypes.byref(out1)) >= 0:
                    ok = True
                    break
            if not ok:
                out1 = out
                _vcall(out, 1, wt.ULONG, [])  # AddRef (아래에서 한 번 Release 하므로)
            dev = ctypes.c_void_p()
            ctx = ctypes.c_void_p()
            fl = wt.UINT()
            # D3D_DRIVER_TYPE_UNKNOWN(0) + 특정 어댑터 = 그 모니터가 연결된 GPU 에서 생성
            _check(d3d11.D3D11CreateDevice(ad, 0, None, 0, None, 0, D3D11_SDK_VERSION, ctypes.byref(dev),
                                           ctypes.byref(fl), ctypes.byref(ctx)), "D3D11CreateDevice")
            dupl = ctypes.c_void_p()
            hr = _vcall(out1, 22, HRESULT, [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)],
                        dev, ctypes.byref(dupl))
            _release(out1)
            if hr < 0:
                _release(ctx)
                _release(dev)
                _check(hr, "DuplicateOutput")
        finally:
            _release(out)
            _release(ad)
        self.device, self.context, self.dupl = dev, ctx, dupl
        self.out_rect = rect
        self.staging = None
        self.stage_size = None
        self.last = None
        self.last_region = None

    def close(self):
        for o in (self.staging, self.dupl, self.context, self.device):
            _release(o)
        self.staging = self.dupl = self.context = self.device = None
        self.out_rect = None
        self.stage_size = None
        self.last = None

    def _ensure_staging(self, w, h):
        if self.stage_size == (w, h) and self.staging:
            return
        _release(self.staging)
        self.staging = None
        d = D3D11_TEXTURE2D_DESC(w, h, 1, 1, DXGI_FORMAT_B8G8R8A8_UNORM, 1, 0, D3D11_USAGE_STAGING, 0,
                                 D3D11_CPU_ACCESS_READ, 0)
        tex = ctypes.c_void_p()
        _check(_vcall(self.device, 5, HRESULT, [ctypes.POINTER(D3D11_TEXTURE2D_DESC), ctypes.c_void_p,
                                                ctypes.POINTER(ctypes.c_void_p)],
                      ctypes.byref(d), None, ctypes.byref(tex)), "CreateTexture2D")
        self.staging = tex
        self.stage_size = (w, h)
        self.last = None

    # --- 캡처 -------------------------------------------------------------
    def grab(self, left, top, width, height, _retry=True):
        cx, cy = left + width // 2, top + height // 2
        r = self.out_rect
        if self.dupl is None or r is None or not (r[0] <= cx < r[2] and r[1] <= cy < r[3]):
            self.close()
            self._create_for_point(cx, cy)
            r = self.out_rect
        # 모니터 밖으로 나간 부분은 잘라냄 (창이 두 모니터에 걸친 경우)
        x0 = max(left, r[0])
        y0 = max(top, r[1])
        x1 = min(left + width, r[2])
        y1 = min(top + height, r[3])
        if x1 - x0 < 16 or y1 - y0 < 16:
            raise CaptureError("캡처 영역이 너무 작음")
        x, y, w, h = x0 - r[0], y0 - r[1], x1 - x0, y1 - y0
        self._ensure_staging(w, h)
        region = (x, y, w, h)
        info = DXGI_OUTDUPL_FRAME_INFO()
        res = ctypes.c_void_p()
        acq = [wt.UINT, ctypes.POINTER(DXGI_OUTDUPL_FRAME_INFO), ctypes.POINTER(ctypes.c_void_p)]
        hr = _vcall(self.dupl, 8, HRESULT, acq, ACQUIRE_TIMEOUT_MS, ctypes.byref(info), ctypes.byref(res))
        if hr == DXGI_ERROR_WAIT_TIMEOUT:
            if self.last is not None and self.last_region == region:
                self.stats["reuse"] += 1
                return self.last
            hr = _vcall(self.dupl, 8, HRESULT, acq, FIRST_FRAME_WAIT_MS, ctypes.byref(info), ctypes.byref(res))
            if hr == DXGI_ERROR_WAIT_TIMEOUT:
                if self.last is not None and self.last_region == region:
                    return self.last
                raise CaptureError("화면 프레임을 받지 못함 (대기 시간 초과)")
        if hr in (DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_INVALID_CALL, DXGI_ERROR_DEVICE_REMOVED,
                  DXGI_ERROR_DEVICE_RESET):
            self.stats["recreate"] += 1
            self.close()
            if _retry:
                return self.grab(left, top, width, height, _retry=False)
            raise CaptureError("DXGI 접근 손실 (HRESULT=0x%08X)" % (hr & 0xFFFFFFFF))
        _check(hr, "AcquireNextFrame")
        self.stats["new"] += 1
        try:
            tex = ctypes.c_void_p()
            _check(_vcall(res, 0, HRESULT, [ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)],
                          ctypes.byref(IID_ID3D11Texture2D), ctypes.byref(tex)), "QI Texture2D")
            box = D3D11_BOX(x, y, 0, x + w, y + h, 1)
            # CopySubresourceRegion(dst, dstSub, X, Y, Z, src, srcSub, box): 필요한 영역만 GPU 안에서 복사
            _vcall(self.context, 46, None, [ctypes.c_void_p, wt.UINT, wt.UINT, wt.UINT, wt.UINT,
                                            ctypes.c_void_p, wt.UINT, ctypes.POINTER(D3D11_BOX)],
                   self.staging, 0, 0, 0, 0, tex, 0, ctypes.byref(box))
            _release(tex)
        finally:
            _release(res)
            _vcall(self.dupl, 14, HRESULT, [])  # ReleaseFrame
        m = D3D11_MAPPED_SUBRESOURCE()
        _check(_vcall(self.context, 14, HRESULT, [ctypes.c_void_p, wt.UINT, wt.UINT, wt.UINT,
                                                  ctypes.POINTER(D3D11_MAPPED_SUBRESOURCE)],
                      self.staging, 0, D3D11_MAP_READ, 0, ctypes.byref(m)), "Map")
        try:
            buf = (ctypes.c_uint8 * (m.RowPitch * h)).from_address(m.pData)
            arr = np.ctypeslib.as_array(buf).reshape(h, m.RowPitch)[:, :w * 4].reshape(h, w, 4).copy()
        finally:
            _vcall(self.context, 15, None, [ctypes.c_void_p, wt.UINT], self.staging, 0)  # Unmap
        self.last = arr
        self.last_region = region
        return arr

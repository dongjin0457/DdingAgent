# -*- coding: utf-8 -*-
"""
띵타이쿤 가격 계산기 - 데스크톱 래퍼 (pywebview + Edge WebView2)

web/index.html 오프라인 웹 앱을 네이티브 창으로 띄우고,
JS 에서 호출할 수 있는 Python API(window.pywebview.api.*)를 제공합니다.

JS 에서 쓸 수 있는 API (자세한 설명은 아래 Api 클래스의 각 메서드 설명 참고)
    load_state()                              -> str | None
    save_state(json_string)                   -> bool
    save_file_dialog(default_name, content)   -> str | None   (저장된 경로)
    open_file_dialog()                        -> str | None   (선택한 .json 파일 내용)

    -- 게임 화면 자동 인식 (recognizer 패키지) --
    set_known_items(items)                    -> {ok, count}  ([{name, category, min, max}])
    set_auto_capture(enabled)                 -> 상태 dict (get_capture_status 와 같은 형식)
    get_capture_status()                      -> {enabled, running, minecraftFound, foreground,
                                                  lastReadAt, lastError, fpsActual, hotkey, hotkeyError}
    force_read()                              -> {ok: true, result} | {ok: false, error}
    set_hotkey(spec)                          -> {ok: true, hotkey} | {ok: false, error}
    Python -> JS 알림: window.DdingApp.onRecognized(event), window.DdingApp.onCaptureStatus(status)

실행 방법
    개발:  run_dev.bat  (또는 python main.py)
    배포:  build.bat 로 만든 dist\\DdingTycoonCalc.exe
    자가 진단: DdingTycoonCalc.exe --selftest 툴팁이미지.png [--out 결과.json]
              (GUI 없이 사용자가 지정한 PNG 한 장을 판독해 결과 JSON 저장 후 종료. exe 안에서 OCR 이 되는지 확인용)

환경변수 (개발/테스트용, 일반 사용자는 설정할 필요 없음)
    DTC_DEBUG=1        개발자 도구(F12) 활성화 + 상세 로그
    DTC_WEB_DIR=경로    web 폴더 대신 다른 폴더의 index.html 을 띄움 (테스트 페이지용)
    DTC_DATA_DIR=경로   state.json 저장 폴더를 바꿈 (테스트 시 실제 데이터 보호용)
"""

import ctypes
import json
import logging
import logging.handlers
import os
import queue
import socket
import sys
import tempfile
import threading
import webbrowser

import webview

# ============================================================================
# 설정값 (필요하면 자유롭게 바꿔도 되는 값들)
# ============================================================================

# 창 제목 표시줄에 보이는 이름
APP_TITLE = "띵타이쿤 가격 계산기"

# %APPDATA% 아래에 만들어질 앱 데이터 폴더 이름 (state.json, 로그, WebView 프로필이 여기 저장됨)
# 주의: 바꾸면 기존 사용자의 저장 데이터를 못 찾게 됨
APP_DIR_NAME = "DdingTycoonCalc"

# 처음 열릴 때 창 크기 (가로, 세로 픽셀)
WINDOW_WIDTH = 1100
WINDOW_HEIGHT = 760

# 사용자가 줄일 수 있는 최소 창 크기 (가로, 세로 픽셀)
WINDOW_MIN_SIZE = (800, 560)

# 창 크기 조절 허용 여부
WINDOW_RESIZABLE = True

# 페이지가 로드되기 전 잠깐 보이는 창 배경색 (웹 앱 배경색과 맞추면 깜빡임이 덜함)
WINDOW_BG_COLOR = "#FFFFFF"

# 앱 상태(가격 데이터 등)를 저장하는 파일 이름
STATE_FILE_NAME = "state.json"

# 직전 버전 상태를 1개 보관하는 백업 파일 이름 (state.json 이 깨졌을 때 자동 복구용)
STATE_BACKUP_FILE_NAME = "state.bak.json"

# 로그 파일 이름 / 최대 크기(바이트) / 보관할 이전 로그 개수
LOG_FILE_NAME = "app.log"
LOG_MAX_BYTES = 256 * 1024
LOG_BACKUP_COUNT = 1

# WebView2 프로필(캐시, localStorage 등)을 저장할 하위 폴더 이름
WEBVIEW_STORAGE_DIR_NAME = "webview"

# 웹 앱 폴더 이름 (PyInstaller 로 묶을 때도 이 이름으로 들어감: --add-data "web;web")
WEB_DIR_NAME = "web"

# 웹 앱 시작 파일 이름
WEB_ENTRY_FILE = "index.html"

# 창 아이콘 파일 (프로젝트 기준 상대경로, exe 에는 assets\icon.ico 로 함께 묶임)
ICON_RELATIVE_PATH = os.path.join("assets", "icon.ico")

# 내장 로컬 HTTP 서버가 우선 사용할 포트.
# 포트가 고정되어야 웹 페이지의 origin 이 매번 같아져서 localStorage 등이 유지됨.
# 이미 다른 프로그램이 쓰고 있으면 자동으로 빈 포트를 골라 씀 (앱 동작에는 문제 없음)
HTTP_PORT_PREFERRED = 42117

# 불러오기(open_file_dialog)로 읽을 파일의 최대 크기 (바이트). 너무 큰 파일을 실수로 여는 것 방지
MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024

# 파일 대화상자에 표시할 파일 형식 필터 (pywebview 형식: '설명 (*.확장자)')
JSON_FILE_TYPES = ("JSON 파일 (*.json)", "모든 파일 (*.*)")

# 개발/테스트용 환경변수 이름들
ENV_DEBUG = "DTC_DEBUG"        # "1" 이면 개발자 도구 + 디버그 로그
ENV_WEB_DIR = "DTC_WEB_DIR"    # 띄울 웹 폴더 경로 덮어쓰기
ENV_DATA_DIR = "DTC_DATA_DIR"  # 데이터(state.json) 폴더 경로 덮어쓰기

# WebView2 런타임이 없을 때 안내할 다운로드 주소
WEBVIEW2_DOWNLOAD_URL = "https://developer.microsoft.com/microsoft-edge/webview2/"

# --- 게임 화면 자동 인식 ---------------------------------------------------------
# 웹 앱이 호출할 때까지 쓰는 기본 전역 단축키 (누르면 이 앱이 마인크래프트 창의 툴팁을 한 번 읽음)
# Windows 표준 단축키 등록 API(RegisterHotKey)로 등록하며, 게임에는 아무 입력도 보내지 않음
# 웹 앱이 시작할 때 저장된 단축키로 set_hotkey 를 다시 호출함
DEFAULT_CAPTURE_HOTKEY = "Ctrl+Shift+R"

# 인식 결과/상태를 JS 로 보내는 함수 이름 (window.DdingApp.<이름>). 페이지가 준비 전이면 조용히 무시됨
JS_ON_RECOGNIZED = "onRecognized"
JS_ON_CAPTURE_STATUS = "onCaptureStatus"

# JS 로 보낼 알림을 쌓아 두는 최대 개수 (JS 가 멈춰 있으면 오래된 것부터 버림)
JS_PUSH_QUEUE_MAX = 100

# 자가 진단 명령줄 옵션 이름
SELFTEST_FLAG = "--selftest"

# ============================================================================
# 경로 계산
# ============================================================================

log = logging.getLogger("dtc")


def is_debug() -> bool:
    """DTC_DEBUG 환경변수가 1/true/yes 이면 디버그 모드."""
    return os.environ.get(ENV_DEBUG, "").strip().lower() in ("1", "true", "yes", "on")


def resource_dir() -> str:
    """
    번들된 리소스(web 폴더, 아이콘)가 있는 폴더.
    - PyInstaller onefile exe: 실행 시 임시로 풀리는 폴더(sys._MEIPASS)
    - 개발 실행(python main.py): 이 파일이 있는 프로젝트 폴더
    """
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return sys._MEIPASS  # type: ignore[attr-defined]
    return os.path.dirname(os.path.abspath(__file__))


def web_dir() -> str:
    """웹 앱 폴더. DTC_WEB_DIR 가 있으면 그걸 우선 사용 (테스트 페이지용)."""
    override = os.environ.get(ENV_WEB_DIR, "").strip()
    if override:
        return os.path.abspath(override)
    return os.path.join(resource_dir(), WEB_DIR_NAME)


def data_dir() -> str:
    """
    사용자 데이터 폴더: %APPDATA%\\DdingTycoonCalc
    (DTC_DATA_DIR 가 있으면 그 경로 사용)
    """
    override = os.environ.get(ENV_DATA_DIR, "").strip()
    if override:
        return os.path.abspath(override)
    base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
    return os.path.join(base, APP_DIR_NAME)


def ensure_dir(path: str) -> str:
    os.makedirs(path, exist_ok=True)
    return path


def documents_dir() -> str:
    """파일 대화상자를 처음 열 폴더 (내 문서). 못 찾으면 홈 폴더."""
    try:
        buf = ctypes.create_unicode_buffer(260)
        # CSIDL_PERSONAL(5) = 내 문서. 내 문서 폴더가 다른 위치(클라우드 동기화 폴더 등)로 옮겨진 경우도 실제 경로를 돌려줌
        if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buf) == 0 and buf.value:
            return buf.value
    except Exception:
        pass
    return os.path.expanduser("~")


# ============================================================================
# 로깅 / 콘솔 없는 exe 대비
# ============================================================================

def setup_logging() -> None:
    """%APPDATA%\\DdingTycoonCalc\\app.log 에 로그 기록 (다른 PC 에서 문제가 생겼을 때 원인 확인용)."""
    # --windowed exe 에서는 sys.stdout/stderr 가 None 이라 print 하는 라이브러리가 죽을 수 있음 -> devnull 로 대체
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")

    level = logging.DEBUG if is_debug() else logging.INFO
    root = logging.getLogger()
    root.setLevel(level)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    try:
        handler = logging.handlers.RotatingFileHandler(
            os.path.join(ensure_dir(data_dir()), LOG_FILE_NAME),
            maxBytes=LOG_MAX_BYTES,
            backupCount=LOG_BACKUP_COUNT,
            encoding="utf-8",
        )
        handler.setFormatter(fmt)
        root.addHandler(handler)
    except Exception:
        pass  # 로그 파일을 못 만들어도 앱은 계속 실행
    if is_debug():
        console = logging.StreamHandler(sys.stderr)
        console.setFormatter(fmt)
        root.addHandler(console)


# ============================================================================
# 네이티브 메시지 박스 (WebView2 가 없을 때 등, 웹 화면을 못 띄우는 상황용)
# ============================================================================

MB_OK = 0x0
MB_YESNO = 0x4
MB_ICONERROR = 0x10
MB_ICONWARNING = 0x30
IDYES = 6


def message_box(text: str, title: str = APP_TITLE, flags: int = MB_OK | MB_ICONERROR) -> int:
    try:
        return ctypes.windll.user32.MessageBoxW(None, text, title, flags)
    except Exception:
        return 0


def check_webview2_or_exit() -> None:
    """
    Edge Chromium(WebView2) 엔진을 쓸 수 있는지 미리 확인.
    pywebview 는 WebView2 가 없으면 조용히 옛날 IE(MSHTML) 엔진으로 바꿔버리는데,
    그러면 최신 JS/CSS 가 깨지므로 여기서 막고 설치 안내 후 종료한다.
    (pywebview 가 실제로 쓰는 것과 같은 판별 로직을 그대로 사용)
    """
    renderer = None
    try:
        from webview.guilib import initialize
        renderer = getattr(initialize("edgechromium"), "renderer", None)
    except Exception:
        log.exception("GUI 초기화 실패")

    if renderer == "edgechromium":
        return

    log.error("WebView2 사용 불가 (renderer=%s)", renderer)
    answer = message_box(
        "이 프로그램을 실행하려면 'Microsoft Edge WebView2 Runtime'이 필요합니다.\n\n"
        "아래 주소에서 'Evergreen Bootstrapper'를 받아 설치한 뒤 다시 실행해 주세요.\n"
        f"{WEBVIEW2_DOWNLOAD_URL}\n\n"
        "지금 다운로드 페이지를 여시겠습니까?",
        APP_TITLE,
        MB_YESNO | MB_ICONERROR,
    )
    if answer == IDYES:
        try:
            webbrowser.open(WEBVIEW2_DOWNLOAD_URL)
        except Exception:
            pass
    sys.exit(1)


# ============================================================================
# 파일 쓰기 도우미
# ============================================================================

def atomic_write_text(path: str, text: str) -> None:
    """
    임시 파일에 먼저 다 쓴 뒤 os.replace 로 한 번에 바꿔치기.
    쓰는 도중 꺼져도 원래 파일이 반쯤 쓰인 상태로 남지 않는다.
    """
    folder = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(prefix=".tmp_", suffix=".part", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def read_text_file(path: str) -> str:
    """UTF-8(BOM 있어도 OK)로 읽고, 안 되면 한국어 윈도우 기본 인코딩(cp949)으로 재시도."""
    with open(path, "rb") as f:
        raw = f.read()
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp949")


def _first_path(result):
    """pywebview 파일 대화상자 결과(튜플/리스트/문자열/None)에서 경로 하나 꺼내기."""
    if not result:
        return None
    if isinstance(result, (list, tuple)):
        return result[0] if result else None
    return str(result)


# ============================================================================
# Python -> JS 알림 (인식 결과 / 캡처 상태)
# ============================================================================

class JsPusher:
    """window.evaluate_js 를 전용 스레드에서 순서대로 실행.

    - 캡처 스레드가 evaluate_js(페이지 로드 대기/응답 대기)에 묶이지 않도록 큐로 분리
    - 스크립트는 'window.DdingApp && window.DdingApp.<함수>' 확인 후 호출 + try/catch 로 감싸서
      페이지가 아직 준비되지 않았거나 함수가 없어도 오류가 나지 않음
    """

    def __init__(self):
        self.window = None
        self._q = queue.Queue(maxsize=JS_PUSH_QUEUE_MAX)
        self._thread = threading.Thread(target=self._run, name="dtc-jspush", daemon=True)
        self._thread.start()

    def push(self, func_name, payload):
        data = json.dumps(payload, ensure_ascii=True, default=str)
        script = ("(function(){try{var a=window.DdingApp;"
                  "if(a&&typeof a.%s==='function'){a.%s(%s);}}catch(e){}})();"
                  % (func_name, func_name, data))
        try:
            self._q.put_nowait(script)
        except queue.Full:
            try:
                self._q.get_nowait()  # 가장 오래된 것 버리기
            except queue.Empty:
                pass
            try:
                self._q.put_nowait(script)
            except queue.Full:
                pass

    def stop(self):
        try:
            self._q.put_nowait(None)
        except queue.Full:
            pass

    def _run(self):
        while True:
            script = self._q.get()
            if script is None:
                return
            w = self.window
            if w is None:
                continue
            try:
                w.evaluate_js(script)
            except Exception as e:  # noqa: BLE001  (창이 닫히는 중 등)
                log.debug("evaluate_js 실패: %s", e)


# ============================================================================
# JS 에서 호출하는 API  (window.pywebview.api.<메서드>)
# 주의: 밑줄(_)로 시작하는 속성/메서드는 JS 에 노출되지 않음
# ============================================================================

class Api:
    def __init__(self):
        self._window = None                 # 파일 대화상자를 띄울 창 (main 에서 설정)
        self._lock = threading.Lock()       # JS 호출이 동시에 와도 파일을 한 번에 하나씩만 쓰도록
        self._engine = None                 # 게임 화면 인식 엔진 (recognizer.CaptureEngine, run 에서 설정)
        self._hotkeys = None                # 전역 단축키 관리자 (recognizer.HotkeyManager)
        self._engine_error = None           # 인식 엔진을 못 만들었을 때 이유

    # --- 내부용 -------------------------------------------------------------
    def _state_path(self) -> str:
        return os.path.join(data_dir(), STATE_FILE_NAME)

    def _backup_path(self) -> str:
        return os.path.join(data_dir(), STATE_BACKUP_FILE_NAME)

    @staticmethod
    def _read_valid_json_text(path: str):
        """파일이 있고 올바른 JSON 이면 그 텍스트, 아니면 None."""
        if not os.path.isfile(path):
            return None
        try:
            text = read_text_file(path)
            json.loads(text)  # 깨진 파일인지 검사만
            return text
        except Exception:
            log.exception("상태 파일 읽기 실패/손상: %s", path)
            return None

    # --- 앱 상태 저장/불러오기 ------------------------------------------------
    def load_state(self):
        """
        저장된 상태 JSON 문자열을 돌려줌. 저장된 게 없으면 None.
        state.json 이 깨져 있으면 state.bak.json(직전 버전)으로 자동 대체.
        """
        with self._lock:
            try:
                text = self._read_valid_json_text(self._state_path())
                if text is None:
                    text = self._read_valid_json_text(self._backup_path())
                    if text is not None:
                        log.warning("state.json 대신 백업(state.bak.json)을 불러왔습니다")
                return text
            except Exception:
                log.exception("load_state 실패")
                return None

    def save_state(self, json_string):
        """
        상태 JSON 문자열을 %APPDATA%\\DdingTycoonCalc\\state.json 에 저장. 성공 시 True.
        - 올바른 JSON 이 아니면 저장하지 않고 False (기존 데이터 보호)
        - 기존 state.json 은 state.bak.json 으로 1개 보관
        - 원자적 쓰기(임시파일 -> 교체)라 저장 중 꺼져도 파일이 깨지지 않음
        """
        with self._lock:
            try:
                if not isinstance(json_string, str):
                    log.error("save_state: 문자열이 아님 (%s)", type(json_string).__name__)
                    return False
                try:
                    json.loads(json_string)  # 유효성 검사 (깨진 JSON 으로 기존 데이터를 덮어쓰지 않도록)
                except ValueError as e:
                    log.warning("save_state: 올바른 JSON 이 아니라 저장 안 함 (%s)", e)
                    return False

                ensure_dir(data_dir())
                state_path = self._state_path()

                # 내용이 똑같으면 다시 쓰지 않음 (백업이 현재와 같은 내용으로 덮이는 것 방지)
                if os.path.isfile(state_path):
                    try:
                        if read_text_file(state_path) == json_string:
                            return True
                    except Exception:
                        pass

                # 1) 새 내용을 임시 파일에 완전히 쓴 다음
                folder = os.path.dirname(state_path)
                fd, tmp = tempfile.mkstemp(prefix=".state_", suffix=".part", dir=folder)
                try:
                    with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
                        f.write(json_string)
                        f.flush()
                        os.fsync(f.fileno())
                    # 2) 기존 state.json -> state.bak.json (직전 버전 1개 보관)
                    if os.path.isfile(state_path):
                        os.replace(state_path, self._backup_path())
                    # 3) 임시 파일 -> state.json
                    os.replace(tmp, state_path)
                except BaseException:
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass
                    raise
                return True
            except Exception:
                log.exception("save_state 실패")
                return False

    # --- 파일 내보내기/가져오기 (네이티브 대화상자) ------------------------------
    def save_file_dialog(self, default_name, content_string):
        """
        '다른 이름으로 저장' 대화상자를 띄우고 content_string 을 UTF-8 로 저장.
        저장한 전체 경로를 돌려줌. 취소하거나 실패하면 None.
        """
        try:
            if self._window is None or not isinstance(content_string, str):
                return None
            default_name = os.path.basename(str(default_name or "export.json")) or "export.json"
            result = self._window.create_file_dialog(
                webview.FileDialog.SAVE,
                directory=documents_dir(),
                save_filename=default_name,
                file_types=JSON_FILE_TYPES,
            )
            path = _first_path(result)
            if not path:
                return None
            # 사용자가 확장자를 지웠으면 기본 이름의 확장자(.json)를 붙여줌
            if not os.path.splitext(path)[1]:
                path += os.path.splitext(default_name)[1] or ".json"
            atomic_write_text(path, content_string)
            log.info("내보내기 저장: %s", path)
            return path
        except Exception:
            log.exception("save_file_dialog 실패")
            return None

    def save_file(self, default_name, content_string):
        """save_file_dialog 의 별칭 (웹 쪽 storage.js 가 이 이름으로 찾을 수도 있어서 둘 다 지원)."""
        return self.save_file_dialog(default_name, content_string)

    def open_file_dialog(self):
        """
        '열기' 대화상자로 .json 파일을 고르게 하고 그 파일의 텍스트를 돌려줌.
        취소하거나 읽기 실패/너무 큰 파일이면 None. (JSON 파싱/검증은 JS 쪽에서)
        """
        try:
            if self._window is None:
                return None
            result = self._window.create_file_dialog(
                webview.FileDialog.OPEN,
                directory=documents_dir(),
                allow_multiple=False,
                file_types=JSON_FILE_TYPES,
            )
            path = _first_path(result)
            if not path or not os.path.isfile(path):
                return None
            if os.path.getsize(path) > MAX_IMPORT_FILE_BYTES:
                log.warning("가져오기 파일이 너무 큼: %s", path)
                return None
            text = read_text_file(path)
            log.info("가져오기 읽음: %s", path)
            return text
        except Exception:
            log.exception("open_file_dialog 실패")
            return None

    # --- 게임 화면 자동 인식 ----------------------------------------------------
    def _status_dict(self):
        """get_capture_status 반환 형식 (엔진이 없어도 같은 키)."""
        st = {"enabled": False, "running": False, "minecraftFound": False, "foreground": False,
              "lastReadAt": None, "lastError": self._engine_error, "fpsActual": 0.0}
        if self._engine is not None:
            st.update(self._engine.status())
        hk = self._hotkeys
        st["hotkey"] = hk.current if hk is not None else None
        st["hotkeyError"] = hk.last_error if hk is not None else None
        return st

    def set_known_items(self, items):
        """알려진 아이템 목록 [{name, category, min, max}] 전달 (이름 매칭/가격 상식 검사용)."""
        try:
            if isinstance(items, str):
                items = json.loads(items)
            if isinstance(items, dict):
                items = items.get("items", [])
            if not isinstance(items, list):
                return {"ok": False, "error": "목록(배열)이 아닙니다"}
            if self._engine is None:
                return {"ok": False, "error": self._engine_error or "인식 엔진 없음"}
            n = self._engine.set_known_items(items)
            log.info("아이템 목록 수신: %d개", n)
            return {"ok": True, "count": n}
        except Exception as e:
            log.exception("set_known_items 실패")
            return {"ok": False, "error": str(e)}

    def set_auto_capture(self, enabled):
        """자동 캡처 켜기/끄기. 현재 상태 dict 를 돌려줌."""
        try:
            if self._engine is not None:
                self._engine.set_enabled(bool(enabled))
                log.info("자동 캡처: %s", "켜짐" if enabled else "꺼짐")
            return self._status_dict()
        except Exception:
            log.exception("set_auto_capture 실패")
            return self._status_dict()

    def get_capture_status(self):
        try:
            return self._status_dict()
        except Exception as e:
            log.exception("get_capture_status 실패")
            return {"enabled": False, "running": False, "minecraftFound": False, "foreground": False,
                    "lastReadAt": None, "lastError": str(e), "fpsActual": 0.0}

    def force_read(self):
        """중복 검사 없이 지금 화면을 한 번 판독. 결과는 onRecognized 로도 전달됨."""
        try:
            if self._engine is None:
                return {"ok": False, "error": self._engine_error or "인식 엔진 없음"}
            return self._engine.force_read()
        except Exception as e:
            log.exception("force_read 실패")
            return {"ok": False, "error": str(e)}

    def set_hotkey(self, spec):
        """전역 단축키 변경 (예: "Ctrl+Shift+R"). 빈 값/"none" 이면 해제."""
        try:
            if self._hotkeys is None:
                return {"ok": False, "error": "단축키 기능을 사용할 수 없습니다"}
            res = self._hotkeys.set_hotkey(spec)
            if self._engine is not None and self._engine.on_status:
                self._engine.on_status(self._status_dict())
            return res
        except Exception as e:
            log.exception("set_hotkey 실패")
            return {"ok": False, "error": str(e)}


# ============================================================================
# 실행
# ============================================================================

def pick_http_port() -> int:
    """고정 포트(HTTP_PORT_PREFERRED)가 비어 있으면 그걸, 아니면 OS 가 골라준 빈 포트."""
    for port in (HTTP_PORT_PREFERRED, 0):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
        except OSError:
            continue
    return 0


def create_main_window(api: Api):
    """메인 창 생성 (webview.start 전에 호출)."""
    entry = os.path.join(web_dir(), WEB_ENTRY_FILE)
    window = webview.create_window(
        APP_TITLE,
        url=entry,  # 로컬 경로 -> pywebview 내장 HTTP 서버(127.0.0.1)로 제공됨
        js_api=api,
        width=WINDOW_WIDTH,
        height=WINDOW_HEIGHT,
        min_size=WINDOW_MIN_SIZE,
        resizable=WINDOW_RESIZABLE,
        background_color=WINDOW_BG_COLOR,
        text_select=True,  # 가격/숫자 복사할 수 있게 텍스트 선택 허용
    )
    api._window = window
    return window


def run(func=None, args=None):
    """
    앱 실행. func 를 주면 GUI 루프 시작 직후 별도 스레드에서 func(*args) 실행
    (자동 테스트용 콜백 인자. 일반 실행에서는 None)
    """
    setup_logging()
    log.info("시작 (frozen=%s, resource_dir=%s)", getattr(sys, "frozen", False), resource_dir())

    entry = os.path.join(web_dir(), WEB_ENTRY_FILE)
    if not os.path.isfile(entry):
        log.error("웹 앱 파일 없음: %s", entry)
        message_box(f"웹 앱 파일을 찾을 수 없습니다.\n{entry}", APP_TITLE)
        sys.exit(1)

    # Edge WebView2 필수: 없으면 설치 안내 후 종료 (옛 IE 엔진으로 자동 전환되어 화면이 깨지는 것을 막음)
    check_webview2_or_exit()

    # <a download> 방식 다운로드도 허용 (WebView2 에서 네이티브 저장 대화상자가 뜸).
    # 권장 경로는 save_file_dialog API 이지만, 웹 쪽 폴백용으로 켜 둔다.
    webview.settings["ALLOW_DOWNLOADS"] = True
    # 디버그 모드일 때 개발자 도구 창 자동으로 열기
    webview.settings["OPEN_DEVTOOLS_IN_DEBUG"] = True

    api = Api()
    window = create_main_window(api)
    pusher = JsPusher()
    pusher.window = window
    start_recognizer(api, pusher)

    icon_path = os.path.join(resource_dir(), ICON_RELATIVE_PATH)
    storage = ensure_dir(os.path.join(data_dir(), WEBVIEW_STORAGE_DIR_NAME))

    try:
        webview.start(
            func,
            args,
            gui="edgechromium",
            debug=is_debug(),
            # private_mode=False + storage_path: WebView2 프로필을 %APPDATA%\DdingTycoonCalc\webview 에
            # 고정해서 임시폴더에 쓰레기가 쌓이지 않게 함. (진짜 저장은 state.json API 가 담당)
            private_mode=False,
            storage_path=storage,
            http_port=pick_http_port(),
            icon=icon_path if os.path.isfile(icon_path) else None,
        )
    finally:
        stop_recognizer(api, pusher)
    log.info("종료")


def start_recognizer(api: Api, pusher: JsPusher) -> None:
    """게임 화면 인식 엔진 + 전역 단축키 시작. 실패해도 앱(계산기)은 그대로 동작."""
    try:
        from recognizer import CaptureEngine, HotkeyManager
    except Exception as e:
        api._engine_error = "인식 모듈을 불러오지 못함: %s" % e
        log.exception("recognizer 불러오기 실패")
        return
    try:
        engine = CaptureEngine(
            on_result=lambda ev: pusher.push(JS_ON_RECOGNIZED, ev),
            on_status=lambda _st: pusher.push(JS_ON_CAPTURE_STATUS, api._status_dict()),
        )
        api._engine = engine
        engine.start()  # 자동 캡처는 꺼진 상태로 시작 (웹 앱이 set_auto_capture 로 켬)
    except Exception as e:
        api._engine_error = "인식 엔진 시작 실패: %s" % e
        log.exception("인식 엔진 시작 실패")
        return
    try:
        hk = HotkeyManager(on_press=lambda: engine.request_force())
        hk.start()
        api._hotkeys = hk
        res = hk.set_hotkey(DEFAULT_CAPTURE_HOTKEY)
        if not res.get("ok"):
            log.warning("기본 단축키 등록 실패: %s", res.get("error"))
    except Exception:
        log.exception("단축키 시작 실패")


def stop_recognizer(api: Api, pusher: JsPusher) -> None:
    """앱 종료 시 작업 스레드 정리 (단축키 해제, 캡처 중지)."""
    try:
        if api._hotkeys is not None:
            api._hotkeys.stop()
    except Exception:
        log.exception("단축키 정리 실패")
    try:
        if api._engine is not None:
            api._engine.on_result = None
            api._engine.on_status = None
            api._engine.stop()
    except Exception:
        log.exception("인식 엔진 정리 실패")
    pusher.window = None
    pusher.stop()


def run_selftest(argv) -> int:
    """--selftest <png> [--out 결과.json] [--items 목록.json] : GUI 없이 판독만 하고 종료."""
    setup_logging()
    from recognizer import selftest, win32
    win32.set_process_dpi_aware()
    data_js = os.path.join(web_dir(), "js", "data.js")
    code = selftest.main(argv, data_js=data_js)
    log.info("selftest 종료 코드 %s", code)
    return code


def main():
    if SELFTEST_FLAG in sys.argv:
        i = sys.argv.index(SELFTEST_FLAG)
        try:
            code = run_selftest(sys.argv[i + 1:])
        except Exception:
            log.exception("selftest 실패")
            code = 2
        sys.exit(code)
    try:
        run()
    except SystemExit:
        raise
    except Exception as e:
        log.exception("치명적 오류")
        message_box(f"프로그램 실행 중 오류가 발생했습니다.\n\n{e}\n\n로그: {os.path.join(data_dir(), LOG_FILE_NAME)}")
        sys.exit(1)


if __name__ == "__main__":
    main()

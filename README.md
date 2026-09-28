# 띵타이쿤 가격 계산기

## 소개

마인크래프트 서버 미니게임 **띵타이쿤**의 요리·공예품 판매가를 정리하고 계산해 주는 Windows 데스크톱 프로그램입니다.

- 가격은 직접 입력하거나, 켜 두면 **내 화면에 떠 있는 아이템 툴팁을 읽어서** 자동으로 채울 수 있습니다.
- `web/` 폴더의 오프라인 웹 앱을 **pywebview + Microsoft Edge WebView2** 창으로 띄우며, PyInstaller 로 exe 파일 1개로 묶습니다.

## 주요 기능

- **범위 내 위치 %**: 판매가가 최저가~최고가 사이 어디쯤인지 계산하고, 가장 높은 항목과 80% 초과 항목을 강조
- **세트 판매액**: 판매가 × 세트 크기(기본 64)
- **판매가 / 나의 판매가**: 게임 툴팁의 두 가격을 따로 저장. 위치 %는 판매가, 매출·이익은 나의 판매가(비어 있으면 판매가)로 계산
- **다음 가격 변동까지 카운트다운**: 요리는 매월 정해진 날짜 3시, 공예품은 매일 3시
- **보유 재료 탭**: 보유 재료로 요리별 최대 제작 수, 재료비·이익, 공유 재료를 나눠 쓸 때 총 이익이 가장 큰 제작 조합 계산
- **가격 기록**: 툴팁에 표시되는 지난 가격(예: `(21일) 1,286 골드`)을 아이템별로 최대 30개 보관하고 미니 그래프로 표시
- **범위 자동 확장**(설정에서 끌 수 있음): 확인한 가격이 최저~최고 범위 밖이면 범위를 넓혀 표시. 원래 값은 따로 보관하며 언제든 되돌릴 수 있음
- **목록 편집 / 공유**: 요리·공예품 목록(이름·최저가·최고가·재료)을 설정 탭에서 고치고 JSON 파일로 내보내기·가져오기
- **밝은/어두운 테마**

## 동작 방식

### 화면 읽기 (자동 인식)

- 상단의 🎥 자동 인식 토글을 켜면 동작합니다 (기본값: 꺼짐). 켜짐/꺼짐 상태는 다음 실행에도 유지됩니다.
- 마인크래프트 창이 맨 앞(포커스)에 있을 때 그 창 영역을 초당 약 4회 캡처합니다 (Windows 화면 캡처 API인 DXGI Desktop Duplication). 창이 없거나 다른 창을 보고 있을 때는 1초에 한 번 창 상태만 확인합니다.
- 마인크래프트 창은 창 제목이 "Minecraft"로 시작하고 창 종류가 GLFW 인 창으로 찾습니다.
- 캡처한 화면에서 아이템 툴팁 테두리를 찾아 **아이템 이름·희귀도·판매가·나의 판매가·지난 가격**을 읽습니다. 이름은 Windows 에 내장된 OCR, 숫자는 픽셀 폰트 모양 비교로 읽습니다.
- 같은 툴팁이 두 프레임 연속으로 보이면 한 번 읽고, 읽은 가격을 해당 아이템 행에 채웁니다.
- **수동 읽기**: "지금 읽기" 버튼이나 단축키(기본 `Ctrl+Shift+R`)를 누르면 그 순간의 마인크래프트 창을 한 번 읽습니다. 자동 인식 토글과 상관없이 동작합니다.

### 단축키

- Windows 단축키 등록 API(`RegisterHotKey`)로 등록한 키 조합이 눌리면 화면을 한 번 다시 읽습니다.
- 프로그램이 켜져 있는 동안 등록한 키 조합은 이 프로그램이 사용합니다. 설정 탭에서 다른 조합으로 바꿀 수 있습니다.

### 저장되는 데이터

데이터는 `%APPDATA%\DdingTycoonCalc\` 에 저장됩니다.

| 파일/폴더 | 내용 |
|-----------|------|
| `state.json` | 입력한 가격, 가격 기록, 보유 재료, 목록, 설정 (UTF-8 JSON) |
| `state.bak.json` | 직전 버전 1개 (`state.json` 이 손상되면 자동으로 이 파일을 불러옴) |
| `app.log` | 오류 확인용 로그 (최대 256KB, 이전 로그 1개만 보관) |
| `webview\` | WebView2 브라우저 프로필 (캐시 등, 지워도 됨) |

- "최근 인식" 목록은 메모리에만 있고 프로그램을 끄면 사라집니다.
- 초기화하려면 프로그램을 끄고 `%APPDATA%\DdingTycoonCalc` 폴더를 지우면 됩니다.

## 설치 / 실행

1. 이 저장소의 **Releases** 에서 `DdingTycoonCalc.exe` 를 받습니다. **파일 하나**만 있으면 되며, 설치 과정 없이 아무 폴더에 두고 실행하세요.
2. **Microsoft Edge WebView2 Runtime** 이 필요합니다.
   - Windows 11 과 최신 Windows 10 에는 기본으로 들어 있습니다.
   - 없으면 실행 시 안내 창이 뜹니다. https://developer.microsoft.com/microsoft-edge/webview2/ 에서 "Evergreen Bootstrapper" 를 설치한 뒤 다시 실행하세요.
3. 코드 서명이 없는 exe 라서 처음 실행할 때 **"Windows의 PC 보호"(SmartScreen)** 창이 뜰 수 있습니다. **"추가 정보" → "실행"** 을 누르면 됩니다.
   - PyInstaller 로 만든 exe 는 백신이 드물게 오탐하는 경우가 있습니다. 걱정되면 아래 "소스에서 빌드" 방법으로 직접 만들어 쓸 수 있습니다.
4. 첫 실행은 exe 압축을 푸느라 2~5초 정도 걸립니다.
5. 메신저로 exe 를 보내면 차단될 수 있으니 zip 으로 압축해서 전달하세요.
6. 자동 인식의 아이템 이름 읽기에는 Windows 의 **한국어 OCR** 기능이 필요합니다 (한국어 Windows 에는 기본 포함. 없으면 설정 > 시간 및 언어 > 언어 > 한국어 > 언어 옵션에서 설치).

## 사용법

### 가격 입력 (🍳 요리 / 🎨 공예품 탭)

- 표의 **판매가**, **나의 판매가** 칸에 게임에서 확인한 값을 입력합니다. `1,234` / `1234G` 형식 모두 됩니다. Enter/↑↓ 로 다음 칸으로 이동합니다.
- 범위 내 위치 %, 세트 판매액이 바로 계산됩니다. "% 높은 순 정렬" 을 켜면 높은 항목부터 보입니다.
- 가격 변동 시각이 지나면 "가격이 바뀌었을 수 있음" 안내가 표시됩니다.
- 이름 옆 📈 버튼을 누르면 가격 기록 그래프를 볼 수 있습니다.

### 자동 인식 (exe 전용)

1. 상단의 **🎥 자동 인식** 을 켭니다 (기본 꺼짐).
2. 마인크래프트를 **창 모드 또는 테두리 없는 창 모드**로 두고, 게임 안에서 아이템 위에 마우스를 올려 툴팁을 띄웁니다.
3. 툴팁을 읽으면 해당 행의 가격이 채워지고 잠깐 반짝입니다. 📋 버튼(오른쪽 서랍)에 최근 인식 20개가 표시됩니다.

- 상태 표시: `꺼짐` / `마인크래프트 대기 중` / `게임 창 비활성` / `인식 중 · N초 전` / `오류`(마우스를 올리면 내용 표시)
- **지금 읽기** 버튼 또는 단축키(기본 `Ctrl+Shift+R`)로 한 번만 읽을 수 있습니다. 단축키는 ⚙️ 설정 → 🎥 자동 인식에서 바꿉니다.
- 목록에 없는 아이템은 "알 수 없는 아이템" 으로 표시되며, **아이템으로 추가** 버튼으로 바로 등록할 수 있습니다.
- 브라우저로 `web/index.html` 을 열었을 때는 자동 인식 없이 수동 입력만 가능합니다.

### 보유 재료 (🧺 탭)

- 재료별 보유 수량(필요하면 개당 비용)을 입력하면 요리별 최대 제작 수와 총 이익이 가장 큰 제작 조합을 계산합니다.

### 설정 (⚙️ 탭)

- 세트 크기, 테마, 범위 자동 확장, 단축키
- 요리·공예품 목록 편집 (최저가/최고가/재료)
- JSON 내보내기·가져오기·클립보드 복사, 기본값으로 복원, 모든 데이터 초기화

### 알려진 제한

- 전체화면(독점) 모드에서는 화면 캡처가 되지 않을 수 있습니다. 창 모드 또는 테두리 없는 창 모드를 권장합니다.
- 공예품 툴팁은 요리 툴팁과 같은 형식이라고 가정하고 읽습니다.
- 희귀도 색은 NORMAL·COMMON·RARE·EPIC 만 구분합니다 (그 외는 "알 수 없음").

## 소스에서 빌드

### 필요 환경

- Windows 10/11, **Python 3.11**
- 패키지:

```
py -3.11 -m pip install pyinstaller pywebview numpy pillow openpyxl ^
  winrt-runtime winrt-Windows.Media.Ocr winrt-Windows.Graphics.Imaging ^
  winrt-Windows.Storage.Streams winrt-Windows.Globalization ^
  winrt-Windows.Foundation winrt-Windows.Foundation.Collections
```

(`openpyxl` 은 기본 데이터를 엑셀에서 다시 만들 때만 필요합니다.)

### 빌드

1. `build.bat` 을 더블클릭합니다.
2. 약 1분 뒤 `dist\DdingTycoonCalc.exe` 가 만들어집니다.

- Python 위치: 기본으로 `%LOCALAPPDATA%\Programs\Python\Python311\python.exe`(Python 3.11 사용자 설치 기본 경로)를 쓰고, 없으면 `py -3.11` 런처로 찾습니다. 다른 Python 을 쓰려면 환경변수 `DTC_PYTHON` 에 python.exe 전체 경로를 지정하세요.
- PyInstaller 작업 폴더는 동기화/파일 잠금 문제를 피하려고 `%TEMP%\DdingTycoonCalc_build` 에 만들어집니다.
- `web\` 폴더, 아이콘, `recognizer\digit_templates.json` 이 exe 안에 포함됩니다. **웹 앱을 고치면 다시 빌드해야 exe 에 반영**됩니다.
- `assets\icon.ico` 가 없으면 `tools\make_icon.py` 로 자동 생성합니다.
- `DTC_NO_PAUSE=1` 이면 빌드가 끝난 뒤 키 입력을 기다리지 않습니다.

### 빌드 없이 실행 / 자가 진단

- `run_dev.bat`: 빌드 없이 `main.py` 를 바로 실행합니다 (개발자 도구 F12 창이 함께 열림).
- 브라우저로 `web/index.html` 을 직접 열어도 계산 기능은 동작합니다 (이때는 브라우저 localStorage 에 저장).
- 자가 진단 (exe 안에서 OCR 이 되는지 확인): 툴팁이 보이는 PNG 이미지를 지정하면 창 없이 판독 결과만 JSON 으로 저장하고 종료합니다.

```
DdingTycoonCalc.exe --selftest 툴팁이미지.png --out 결과.json
```

  종료 코드 0 = 인식 성공. `build.bat` 실행 전에 `set DTC_SELFTEST_PNG=툴팁이미지.png` 를 해 두면 빌드 직후 자동으로 확인합니다 (`dist\selftest_result.json`).

### 기본 데이터 다시 만들기 (엑셀이 바뀌었을 때)

```
py -3.11 tools/extract_xlsx.py                        # 기본 경로: %USERPROFILE%\Downloads\띵타이쿤 요리가격 계산 시트.xlsx
py -3.11 tools/extract_xlsx.py "다른\경로\파일.xlsx"    # 다른 엑셀 지정
```

- 결과는 `web/js/data.js` 로 저장됩니다 (자동 생성 파일이므로 직접 고치지 마세요).
- 최신 최저가/최고가는 `tools/extract_xlsx.py` 의 `PRICE_OVERRIDES` 표가 엑셀 값보다 우선합니다.

### 자주 바꿀 만한 설정값

각 값의 의미는 파일 안의 한국어 주석에 적혀 있습니다.

- `web/js/calc.js`: `SET_SIZE`(64), `HIGHLIGHT_THRESHOLD`(0.8), `COOKING_CHANGE_DAYS`, `CHANGE_HOUR`(3), `OPT_MAX_NODES`, `OPT_TIME_LIMIT_MS`
- `web/js/recog.js`: `HISTORY_MAX`(30), `EXPAND_SANITY_FACTOR`(3), `LOG_MAX`(20), `LOG_DEDUPE_MS`(15000)
- `web/js/state.js`: `DEFAULT_HOTKEY`(`Ctrl+Shift+R`)
- `web/js/app.js`: `CAPTURE_POLL_MS`(2000), `FLASH_MS`, `BAR_LOW_THRESHOLD` 등
- `recognizer/engine.py`: `CAPTURE_FPS`(4), `STABLE_FRAMES`, `IDLE_INTERVAL_SEC`
- `recognizer/names.py`: `NAME_MATCH_MIN`, `NAME_MATCH_MARGIN` / `recognizer/reader.py`: `RARITY_COLORS`, `PRICE_SANITY_HI`, `PRICE_SANITY_LO`

## 폴더 구조

```
DdingTycoonCalc/
├─ main.py                  데스크톱 창 생성, JS ↔ Python API, 상태 저장
├─ build.bat                exe 빌드 (dist\DdingTycoonCalc.exe)
├─ run_dev.bat              빌드 없이 실행 (개발자 도구 켜짐)
├─ version_info.txt         exe 속성의 버전 정보
├─ assets/
│  └─ icon.ico              앱 아이콘 (tools/make_icon.py 로 생성)
├─ recognizer/              툴팁 인식 엔진
│  ├─ __init__.py
│  ├─ engine.py             작업 스레드 (창 확인 → 캡처 → 판독 → 결과 전달)
│  ├─ capture.py            DXGI Desktop Duplication 화면 캡처 (마인크래프트 창 영역)
│  ├─ win32.py              마인크래프트 창 찾기 / 창 상태 / DPI
│  ├─ detect.py             툴팁 테두리 찾기
│  ├─ reader.py             툴팁 판독 (이름 / 가격 줄 분류)
│  ├─ glyphs.py             픽셀 폰트 숫자 판독
│  ├─ digit_templates.json  숫자 모양 템플릿
│  ├─ ocr.py                Windows 내장 OCR 래퍼
│  ├─ names.py              아이템 이름 퍼지 매칭
│  ├─ hotkey.py             전역 단축키 (RegisterHotKey)
│  └─ selftest.py           자가 진단 (--selftest)
├─ web/                     화면 (순수 HTML/CSS/JS, 빌드 과정 없음)
│  ├─ index.html
│  ├─ css/style.css
│  └─ js/
│     ├─ data.js            기본 데이터 (자동 생성)
│     ├─ calc.js            계산 함수 (범위 %, 세트 가격, 변동 일정, 최적 조합)
│     ├─ recog.js           인식 결과 정리 (이름 매칭, 가격 기록 병합, 범위 확장)
│     ├─ state.js           상태 기본값·검증·마이그레이션
│     ├─ storage.js         저장 (exe 는 state.json, 브라우저는 localStorage)
│     └─ app.js             화면 그리기와 이벤트 처리
└─ tools/
   ├─ extract_xlsx.py       엑셀 → web/js/data.js
   └─ make_icon.py          아이콘 생성
```

## 데이터 출처

- 기본 요리·공예품 목록, 재료, 최저가/최고가는 엑셀 시트 **"띵타이쿤 요리가격 계산 시트"** 를 바탕으로 했습니다.
- 일반 요리의 최저가/최고가는 **띵타이쿤 위키의 요리 가격표(2026-09-26 기준)** 값으로 갱신했습니다.
- 게임 업데이트로 가격 범위가 바뀔 수 있습니다. 설정 탭에서 직접 고치거나, 자동 인식의 범위 자동 확장을 사용할 수 있습니다.
- 이 프로그램은 띵타이쿤 서버의 공식 프로그램이 아닙니다.

## 라이선스

라이선스: 미정

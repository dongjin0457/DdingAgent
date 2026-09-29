# -*- coding: utf-8 -*-
"""
자가 진단: 사용자가 지정한 PNG 이미지 한 장을 판독해서 결과를 JSON 파일로 저장
(exe 안에서 OCR/numpy 번들이 제대로 됐는지 확인용. 명령줄에서 --selftest 를 줄 때만 실행됨)

    DdingAgent.exe --selftest 툴팁이미지.png [--out 결과.json] [--items 목록.json]

- 아이템 목록: --items 로 준 JSON (배열 또는 {"items": [...]}) 또는 exe 에 들어 있는 web/js/data.js
- 결과 파일 기본 위치: PNG 와 같은 폴더의 <PNG 이름>.selftest.json (판독 결과 텍스트만 저장, 이미지는 저장하지 않음)
- exe 는 콘솔이 없으므로(--windowed) 결과는 파일로 확인. 종료 코드: 0 = 인식 성공, 1 = 실패, 2 = 오류
"""

import json
import os
import sys
import time
import traceback


def load_items_from_data_js(path):
    with open(path, "r", encoding="utf-8") as f:
        s = f.read()
    data = json.loads(s[s.index("{"): s.rindex("}") + 1])
    return [{"name": it.get("name"), "category": it.get("category"), "min": it.get("min"),
             "max": it.get("max")} for it in data.get("items", [])]


def load_items(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    if isinstance(data, dict):
        data = data.get("items", [])
    return data


def run_selftest(png_path, out_path=None, items=None, data_js=None):
    """판독 결과 dict 반환 + out_path 에 JSON 저장."""
    t_start = time.perf_counter()
    out_path = out_path or (os.path.splitext(png_path)[0] + ".selftest.json")
    report = {"png": os.path.abspath(png_path), "frozen": bool(getattr(sys, "frozen", False)),
              "python": sys.version.split()[0]}
    code = 2
    try:
        import numpy as np
        from PIL import Image

        from .reader import TooltipReader
        from .detect import detect_tooltip

        if items is None and data_js and os.path.isfile(data_js):
            items = load_items_from_data_js(data_js)
        report["known_items"] = len(items or [])
        frame = np.array(Image.open(png_path).convert("RGB"))
        report["frame"] = [int(frame.shape[1]), int(frame.shape[0])]
        reader = TooltipReader()
        reader.set_known_items(items or [])
        t0 = time.perf_counter()
        tip = detect_tooltip(frame)
        t_det = (time.perf_counter() - t0) * 1000
        event, info = reader.read(frame, tip)
        info.setdefault("timings", {})["detect"] = t_det
        report["ocr_available"] = reader.get_ocr() is not None
        report["ocr_error"] = reader.ocr_error
        report["event"] = event
        report["reason"] = info.get("reason")
        report["timings_ms"] = {k: round(v, 1) for k, v in info.get("timings", {}).items()}
        report["name_debug"] = {k: v for k, v in (info.get("name") or {}).items() if k != "item"}
        report["rows"] = info.get("rows")
        report["tooltip"] = info.get("tooltip")
        report["ok"] = event is not None
        code = 0 if event is not None else 1
    except Exception as e:  # noqa: BLE001
        report["ok"] = False
        report["error"] = "%s: %s" % (type(e).__name__, e)
        report["traceback"] = traceback.format_exc()
    report["total_ms"] = round((time.perf_counter() - t_start) * 1000, 1)
    try:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1, default=str)
    except Exception:  # noqa: BLE001
        pass
    report["_exit_code"] = code
    report["_out_path"] = out_path
    return report


def main(argv, data_js=None):
    """argv: --selftest 뒤의 인자들. 반환: 종료 코드."""
    if not argv:
        print("사용법: --selftest <png> [--out 결과.json] [--items 목록.json]")
        return 2
    png = argv[0]
    out = None
    items = None
    if "--out" in argv:
        out = argv[argv.index("--out") + 1]
    if "--items" in argv:
        items = load_items(argv[argv.index("--items") + 1])
    rep = run_selftest(png, out, items, data_js)
    try:
        if sys.stdout is not None:
            print(json.dumps({k: v for k, v in rep.items() if k != "traceback"}, ensure_ascii=False,
                             indent=1, default=str))
    except Exception:  # noqa: BLE001
        pass
    return rep["_exit_code"]

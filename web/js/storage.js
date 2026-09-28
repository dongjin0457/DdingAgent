/*
 * storage.js — 상태 저장/불러오기 (pywebview 우선, 없으면 localStorage)
 *
 * ── pywebview(패키징된 exe) 연동 계약 ──
 *   await window.pywebview.api.load_state()        → JSON 문자열 또는 null
 *   await window.pywebview.api.save_state(jsonStr) → true (잘못된 JSON 이면 false, 저장 안 함)
 *   (선택) await window.pywebview.api.save_file_dialog(기본파일명, 내용) → 저장 경로 또는 null(취소)
 *          ※ 옛 이름 save_file 도 허용. 있으면 JSON 내보내기에 사용, 없으면 브라우저 다운로드 방식
 *   (선택) await window.pywebview.api.open_file_dialog() → 선택한 파일의 텍스트 또는 null(취소)
 *          ※ 있으면 JSON 가져오기에 사용, 없으면 <input type=file> 방식
 *
 * 브라우저에서 직접 열면 pywebviewready 이벤트를 최대 PYWEBVIEW_WAIT_MS 동안 기다린 뒤
 * localStorage 로 대체합니다.
 */
(function (root) {
  'use strict';

  // pywebview 준비 신호(pywebviewready)를 기다리는 최대 시간(ms). 넘으면 localStorage 사용.
  var PYWEBVIEW_WAIT_MS = 1500;

  // 저장 지연 시간(ms). 입력할 때마다 저장하지 않고 마지막 변경 후 이 시간이 지나면 한 번 저장.
  var SAVE_DEBOUNCE_MS = 400;

  // localStorage 에 저장할 때 쓰는 키 이름
  var LS_KEY = 'ddingTycoonCalc.state';

  var backend = null;      // 'pywebview' | 'localStorage' | 'none'
  var timer = null;
  var pendingJson = null;
  var saving = Promise.resolve();

  function hasApi() {
    return !!(root.pywebview && root.pywebview.api &&
      typeof root.pywebview.api.load_state === 'function');
  }

  /** pywebview API 가 준비될 때까지 대기 (최대 PYWEBVIEW_WAIT_MS) */
  function waitForPywebview() {
    return new Promise(function (resolve) {
      if (hasApi()) { resolve(true); return; }
      var done = false;
      function finish(ok) {
        if (done) return;
        done = true;
        root.removeEventListener('pywebviewready', onReady);
        clearInterval(poll);
        clearTimeout(to);
        resolve(ok);
      }
      function onReady() { finish(hasApi()); }
      root.addEventListener('pywebviewready', onReady);
      // 이벤트를 놓친 경우 대비해 짧게 폴링
      var poll = setInterval(function () { if (hasApi()) finish(true); }, 100);
      var to = setTimeout(function () { finish(hasApi()); }, PYWEBVIEW_WAIT_MS);
    });
  }

  function lsGet() {
    try { return root.localStorage ? root.localStorage.getItem(LS_KEY) : null; } catch (e) { return null; }
  }
  function lsSet(json) {
    try { if (root.localStorage) root.localStorage.setItem(LS_KEY, json); return true; } catch (e) { return false; }
  }

  /**
   * 저장소 초기화 + 저장된 상태 불러오기.
   * @returns {Promise<string|null>} 저장된 JSON 문자열 (없으면 null)
   */
  function init() {
    return waitForPywebview().then(function (ok) {
      if (ok) {
        backend = 'pywebview';
        return Promise.resolve()
          .then(function () { return root.pywebview.api.load_state(); })
          .then(function (s) { return typeof s === 'string' ? s : (s ? JSON.stringify(s) : null); })
          .catch(function (e) {
            console.warn('[storage] load_state 실패, localStorage 사용', e);
            backend = 'localStorage';
            return lsGet();
          });
      }
      backend = 'localStorage';
      return lsGet();
    });
  }

  function writeNow(json) {
    if (backend === 'pywebview') {
      saving = saving.then(function () {
        return root.pywebview.api.save_state(json);
      }).then(function (ok) {
        if (ok === false) { // 파이썬 쪽이 거부 → 데이터 유실 방지를 위해 localStorage 에라도 보관
          console.warn('[storage] save_state 가 false 반환, localStorage 에 임시 저장');
          lsSet(json);
        }
        return ok;
      }).catch(function (e) {
        console.warn('[storage] save_state 실패, localStorage 에 임시 저장', e);
        lsSet(json);
      });
      return saving;
    }
    lsSet(json);
    return Promise.resolve(true);
  }

  /** 상태 저장 예약 (SAVE_DEBOUNCE_MS 디바운스) */
  function save(state) {
    pendingJson = JSON.stringify(state);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  }

  /** 예약된 저장을 즉시 실행 */
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pendingJson === null) return saving;
    var json = pendingJson;
    pendingJson = null;
    return writeNow(json);
  }

  // 창을 닫기 직전에 남은 저장을 내보냄 (localStorage 는 동기라 확실히 저장됨)
  root.addEventListener('beforeunload', function () { flush(); });
  root.addEventListener('pagehide', function () { flush(); });

  // 전역 이름: window.AppStorage (window.Storage 는 브라우저 내장 이름이라 피함)
  root.AppStorage = {
    PYWEBVIEW_WAIT_MS: PYWEBVIEW_WAIT_MS,
    SAVE_DEBOUNCE_MS: SAVE_DEBOUNCE_MS,
    LS_KEY: LS_KEY,
    init: init,
    save: save,
    flush: flush,
    backend: function () { return backend; },
    /** pywebview 저장 대화상자 함수 (save_file_dialog 우선, 옛 이름 save_file 도 허용). 없으면 null */
    saveFileDialogFn: function () {
      return apiFn('save_file_dialog') || apiFn('save_file');
    },
    /** pywebview 열기 대화상자 함수 (파일 내용 텍스트 또는 null 반환). 없으면 null */
    openFileDialogFn: function () {
      return apiFn('open_file_dialog');
    }
  };

  /** pywebview API 함수 찾기 (this 바인딩 유지) */
  function apiFn(name) {
    var api = backend === 'pywebview' && root.pywebview && root.pywebview.api;
    if (!api || typeof api[name] !== 'function') return null;
    return function () { return api[name].apply(api, arguments); };
  }
})(typeof self !== 'undefined' ? self : this);

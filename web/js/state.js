/*
 * state.js — 앱 상태(JSON) 기본값 생성 / 정규화(마이그레이션) / 마스터 데이터 검증
 * DOM 사용 없음 → Node 에서도 require 가능 (UMD 패턴, window.AppState)
 * 의존: recog.js (기록 정리 함수) — 브라우저에서는 state.js 보다 먼저 불러와야 함
 *
 * ── 상태 JSON 구조 v2 (pywebview 저장·localStorage 저장 공통) ──
 * {
 *   version: 2,                                  // 상태 형식 버전 (마이그레이션용)
 *   settings: {
 *     setSize: 64,                               // 세트 크기
 *     theme: 'dark' | 'light',
 *     activeTab: 'cooking' | 'craft' | 'inventory' | 'settings',
 *     sortByPct: { cooking: false, craft: false }, // "% 높은 순 정렬" 토글
 *     autoExpandRange: true,                     // 인식한 가격이 범위 밖이면 최저/최고 자동 확장
 *     autoCapture: false,                        // 🎥 자동 인식 켜짐 여부 (exe 에서만 의미 있음)
 *     hotkey: 'Ctrl+Shift+R'                     // "지금 읽기" 전역 단축키
 *   },
 *   master: null | { items: [ {category, name, min, max, ingredients:[{name,qty}]} ] },
 *                                                // null = 기본 데이터(data.js) 사용, 편집하면 전체 목록 저장
 *   sell: { cooking: {이름: 판매가}, craft: {...} },        // 게임의 "판매가" (범위 % 계산 기준)
 *   my:   { cooking: {이름: 나의 판매가}, craft: {...} },   // 게임의 "나의 판매가" (이익/매출 계산 기준, 없으면 판매가)
 *   priceUpdatedAt: { cooking: ms|null, craft: ms|null },   // 카테고리별 마지막 가격 입력/인식 시각
 *   itemUpdatedAt:  { cooking: {이름: ms}, craft: {...} },  // 아이템별 마지막 가격 입력/인식 시각
 *   rangeOverride:  { cooking: {이름: {min?, max?}}, craft: {...} }, // 자동 확장된 범위 (data.js 는 건드리지 않음)
 *   history: { cooking: {이름: [{day, price, seenAt}]}, craft: {...} }, // 인식한 지난 가격 기록
 *   inventory: { 재료이름: 보유수량 },
 *   costs: { 재료이름: 개당비용 }
 * }
 *
 * v1 → v2 변경점: prices → sell 로 이름 변경, my/itemUpdatedAt/rangeOverride/history 추가, 설정 3개 추가
 */
(function (root, factory) {
  var recog = (root && root.Recog) || (typeof require === 'function' ? require('./recog.js') : null);
  var api = factory(recog);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.AppState = api;
  }
})(typeof self !== 'undefined' ? self : this, function (Recog) {
  'use strict';

  // 상태 형식 버전. 구조를 바꿀 때 올리고 migrateState 에 변환 로직을 추가하세요.
  var STATE_VERSION = 2;

  // 내보내기(JSON) 파일 식별자. 가져오기 시 이 값으로 앱 파일인지 확인.
  var EXPORT_APP_ID = 'DdingTycoonCalc';

  // 세트 크기 기본값 (Calc.SET_SIZE 와 동일하게 유지)
  var DEFAULT_SET_SIZE = 64;

  // 세트 크기 허용 최대값 (잘못된 입력 방지용)
  var MAX_SET_SIZE = 100000;

  // 이름 최대 길이 (가져오기 검증용)
  var MAX_NAME_LEN = 60;

  // "지금 읽기" 단축키 기본값 (파이썬 api.set_hotkey 로 전달)
  var DEFAULT_HOTKEY = 'Ctrl+Shift+R';

  // 단축키 문자열 최대 길이 (잘못된 저장값 방지)
  var MAX_HOTKEY_LEN = 40;

  var TABS = ['cooking', 'craft', 'inventory', 'settings'];
  var CATS = ['cooking', 'craft'];

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function perCat(fn) { var o = {}; CATS.forEach(function (c) { o[c] = fn ? fn(c) : {}; }); return o; }

  /** data.js 의 DEFAULT_DATA → 마스터 데이터 {items} */
  function defaultMaster(defaultData) {
    var items = (defaultData && defaultData.items) || [];
    return {
      items: items.map(function (it) {
        return {
          category: it.category,
          name: it.name,
          min: it.min,
          max: it.max,
          ingredients: clone(it.ingredients || [])
        };
      })
    };
  }

  /** 기본 상태 (엑셀의 현재가격을 판매가 초기값으로 사용) */
  function createDefaultState(defaultData) {
    var sell = perCat();
    ((defaultData && defaultData.items) || []).forEach(function (it) {
      if (sell[it.category] && isNum(it.current)) sell[it.category][it.name] = it.current;
    });
    return {
      version: STATE_VERSION,
      settings: {
        setSize: DEFAULT_SET_SIZE,
        theme: 'dark',
        activeTab: 'cooking',
        sortByPct: { cooking: false, craft: false },
        autoExpandRange: true,
        autoCapture: false,
        hotkey: DEFAULT_HOTKEY
      },
      master: null,
      sell: sell,
      my: perCat(),
      priceUpdatedAt: { cooking: null, craft: null },
      itemUpdatedAt: perCat(),
      rangeOverride: perCat(),
      history: perCat(),
      inventory: {},
      costs: {}
    };
  }

  /**
   * 마스터 데이터 검증. 배열 또는 {items:[...]} 또는 내보내기 파일 형식 모두 허용.
   * @returns {{ok:boolean, errors:string[], master?:{items:Array}, setSize?:number}}
   */
  function validateMaster(input) {
    var errors = [];
    var items = null, setSize;
    if (Array.isArray(input)) items = input;
    else if (isObj(input) && Array.isArray(input.items)) {
      items = input.items;
      if (input.setSize !== undefined) {
        if (isNum(input.setSize) && input.setSize >= 1 && input.setSize <= MAX_SET_SIZE && Math.floor(input.setSize) === input.setSize) {
          setSize = input.setSize;
        } else {
          errors.push('setSize 값이 올바르지 않습니다.');
        }
      }
    }
    if (!items) return { ok: false, errors: ['items 배열이 없습니다. 이 앱에서 내보낸 JSON 파일인지 확인하세요.'] };
    if (items.length === 0) errors.push('항목이 하나도 없습니다.');

    var seen = {};
    var out = [];
    items.forEach(function (it, idx) {
      var label = (idx + 1) + '번째 항목';
      if (!isObj(it)) { errors.push(label + ': 객체가 아닙니다.'); return; }
      if (CATS.indexOf(it.category) < 0) { errors.push(label + ': category 는 cooking 또는 craft 여야 합니다.'); return; }
      var name = typeof it.name === 'string' ? it.name.trim() : '';
      if (!name) { errors.push(label + ': 이름이 비어 있습니다.'); return; }
      if (name.length > MAX_NAME_LEN) { errors.push(label + ': 이름이 너무 깁니다.'); return; }
      label = '"' + name + '"';
      var key = it.category + '::' + name;
      if (seen[key]) { errors.push(label + ': 같은 카테고리에 중복된 이름입니다.'); return; }
      seen[key] = true;
      if (!isNum(it.min) || !isNum(it.max) || it.min < 0 || it.max < 0) { errors.push(label + ': 최저가/최고가는 0 이상의 숫자여야 합니다.'); return; }
      if (it.min > it.max) { errors.push(label + ': 최저가가 최고가보다 큽니다.'); return; }
      var ings = [];
      if (it.ingredients !== undefined && it.ingredients !== null) {
        if (!Array.isArray(it.ingredients)) { errors.push(label + ': ingredients 는 배열이어야 합니다.'); return; }
        var bad = false;
        it.ingredients.forEach(function (g) {
          if (!isObj(g) || typeof g.name !== 'string' || !g.name.trim() ||
              !isNum(g.qty) || g.qty < 1 || Math.floor(g.qty) !== g.qty) bad = true;
          else ings.push({ name: g.name.trim(), qty: g.qty });
        });
        if (bad) { errors.push(label + ': 재료 형식이 올바르지 않습니다 ({name, qty(1 이상 정수)}).'); return; }
      }
      out.push({ category: it.category, name: name, min: it.min, max: it.max, ingredients: it.category === 'cooking' ? ings : [] });
    });
    if (errors.length) return { ok: false, errors: errors };
    var res = { ok: true, errors: [], master: { items: out } };
    if (setSize !== undefined) res.setSize = setSize;
    return res;
  }

  /** 숫자 맵 정리: 0 이상 유한수만 유지 (integer=true 면 내림) */
  function cleanNumMap(src, integer) {
    var out = {};
    if (!isObj(src)) return out;
    Object.keys(src).forEach(function (k) {
      var v = src[k];
      if (isNum(v) && v >= 0) out[k] = integer ? Math.floor(v) : v;
    });
    return out;
  }

  /** 범위 확장 맵 정리: {이름: {min?, max?}} — 숫자가 하나도 없으면 버림 */
  function cleanOverrideMap(src) {
    var out = {};
    if (!isObj(src)) return out;
    Object.keys(src).forEach(function (k) {
      var o = src[k];
      if (!isObj(o)) return;
      var r = {};
      if (isNum(o.min) && o.min >= 0) r.min = o.min;
      if (isNum(o.max) && o.max >= 0) r.max = o.max;
      if (r.min !== undefined || r.max !== undefined) out[k] = r;
    });
    return out;
  }

  /** 가격 기록 맵 정리: {이름: [{day, price, seenAt}]} — 날짜 중복 제거·정렬·개수 제한 */
  function cleanHistoryMap(src) {
    var out = {};
    if (!isObj(src)) return out;
    Object.keys(src).forEach(function (k) {
      if (!Array.isArray(src[k])) return;
      var list = Recog ? Recog.mergeHistory(src[k], [], null).list : [];
      if (list.length) out[k] = list;
    });
    return out;
  }

  /**
   * 옛 형식 → 현재 형식으로 구조만 변환 (값 검증은 normalizeState 가 담당).
   * v1(또는 version 없음): prices → sell, my 는 빈 값.
   * 입력 객체는 수정하지 않고 새 객체를 돌려줌.
   */
  function migrateState(src) {
    if (!isObj(src)) return src;
    var s = Object.assign({}, src);
    var v = isNum(s.version) ? s.version : 1;
    if (v < 2) {
      if (s.sell === undefined && isObj(s.prices)) s.sell = s.prices;
      delete s.prices;
      if (s.my === undefined) s.my = { cooking: {}, craft: {} };
      v = 2;
    }
    // ── 다음 버전이 생기면 여기에 추가: if (v < 3) { ... v = 3; } ──
    s.version = v;
    return s;
  }

  /**
   * 저장된 상태(문자열 또는 객체)를 안전하게 현재 형식으로 변환.
   * 누락/부분/손상된 데이터는 해당 필드만 기본값으로 대체. 완전히 깨졌으면 기본 상태.
   */
  function normalizeState(raw, defaultData) {
    var def = createDefaultState(defaultData);
    var src = raw;
    if (typeof src === 'string') {
      try { src = JSON.parse(src); } catch (e) { return def; }
    }
    if (!isObj(src)) return def;

    src = migrateState(src);

    var st = def;
    var s = isObj(src.settings) ? src.settings : {};
    if (isNum(s.setSize) && s.setSize >= 1 && s.setSize <= MAX_SET_SIZE) st.settings.setSize = Math.floor(s.setSize);
    if (s.theme === 'light' || s.theme === 'dark') st.settings.theme = s.theme;
    if (TABS.indexOf(s.activeTab) >= 0) st.settings.activeTab = s.activeTab;
    if (isObj(s.sortByPct)) {
      CATS.forEach(function (c) { st.settings.sortByPct[c] = s.sortByPct[c] === true; });
    }
    if (typeof s.autoExpandRange === 'boolean') st.settings.autoExpandRange = s.autoExpandRange;
    if (typeof s.autoCapture === 'boolean') st.settings.autoCapture = s.autoCapture;
    if (typeof s.hotkey === 'string' && s.hotkey.trim() && s.hotkey.length <= MAX_HOTKEY_LEN) st.settings.hotkey = s.hotkey.trim();

    if (src.master !== null && src.master !== undefined) {
      var v = validateMaster(src.master);
      if (v.ok) st.master = v.master;
    }

    ['sell', 'my'].forEach(function (key) {
      if (isObj(src[key])) {
        CATS.forEach(function (c) {
          if (isObj(src[key][c])) st[key][c] = cleanNumMap(src[key][c], false);
        });
      }
    });
    if (isObj(src.priceUpdatedAt)) {
      CATS.forEach(function (c) {
        var t = src.priceUpdatedAt[c];
        st.priceUpdatedAt[c] = isNum(t) ? t : null;
      });
    }
    CATS.forEach(function (c) {
      if (isObj(src.itemUpdatedAt)) st.itemUpdatedAt[c] = cleanNumMap(src.itemUpdatedAt[c], false);
      if (isObj(src.rangeOverride)) st.rangeOverride[c] = cleanOverrideMap(src.rangeOverride[c]);
      if (isObj(src.history)) st.history[c] = cleanHistoryMap(src.history[c]);
    });
    st.inventory = cleanNumMap(src.inventory, true);
    st.costs = cleanNumMap(src.costs, false);
    st.version = STATE_VERSION;
    return st;
  }

  /** 내보내기용 JSON 객체 (마스터 데이터만 — 가격/기록/확장 범위는 포함하지 않음) */
  function buildExport(master, setSize) {
    return {
      app: EXPORT_APP_ID,
      kind: 'master',
      version: STATE_VERSION,
      exportedAt: new Date().toISOString(),
      setSize: setSize,
      items: clone(master.items)
    };
  }

  return {
    STATE_VERSION: STATE_VERSION,
    EXPORT_APP_ID: EXPORT_APP_ID,
    DEFAULT_SET_SIZE: DEFAULT_SET_SIZE,
    MAX_SET_SIZE: MAX_SET_SIZE,
    MAX_NAME_LEN: MAX_NAME_LEN,
    DEFAULT_HOTKEY: DEFAULT_HOTKEY,
    TABS: TABS,
    CATS: CATS,
    defaultMaster: defaultMaster,
    createDefaultState: createDefaultState,
    validateMaster: validateMaster,
    migrateState: migrateState,
    normalizeState: normalizeState,
    buildExport: buildExport
  };
});

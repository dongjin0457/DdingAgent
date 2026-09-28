/*
 * recog.js — 게임 화면 자동 인식(파이썬 엔진)과 관련된 순수 함수 모음 (DOM 사용 없음)
 *
 * - 브라우저: <script src="js/recog.js"> → window.Recog
 * - Node: module.exports 로도 불러올 수 있음 (UMD 패턴)
 *
 * 담당 기능
 *  1) 이름 매칭: 인식된 이름 → 목록의 아이템 (정확히 일치 → 공백/대소문자 무시 일치 순)
 *  2) 인식 이벤트 정리: 파이썬이 보낸 evt 를 안전한 형태로 변환 (초 단위 시각 → ms 등)
 *  3) 가격 기록(history) 병합: "(21일) 1,286 골드" 같은 지난 가격을 날짜 기준으로 합치고 중복 제거
 *  4) 최저~최고 범위 자동 확장: 인식한 가격이 범위 밖이면 범위를 넓히는 "덮어쓰기(override)" 계산
 *  5) 최근 인식 기록(log) 관리
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Recog = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* =====================================================================
   * 설정값 (필요하면 자유롭게 바꿔도 되는 값들)
   * ===================================================================== */

  // 아이템 하나당 보관할 지난 가격 기록 개수. 오래된 것부터 버림.
  // (요리는 한 달에 약 11번 변동 → 30개면 약 3달치)
  var HISTORY_MAX = 30;

  // 범위 자동 확장 "이상값" 방지 배수.
  // 인식 오류(예: 1,286 을 12,860 으로 잘못 읽음)로 범위가 터무니없이 넓어지는 것을 막기 위해,
  // 원래 최고가 × 이 값보다 크거나, 원래 최저가 ÷ 이 값보다 작은 가격은 확장에 쓰지 않습니다.
  // 0 으로 두면 검사하지 않고 무조건 확장합니다.
  var EXPAND_SANITY_FACTOR = 3;

  // 최근 인식 기록(화면 오른쪽 서랍)에 남길 최대 개수
  var LOG_MAX = 20;

  // 같은 아이템·같은 가격이 이 시간(ms) 안에 다시 인식되면 기록을 새로 추가하지 않고 시각만 갱신.
  // (파이썬이 같은 툴팁을 여러 번 보내도 기록이 도배되지 않게)
  var LOG_DEDUPE_MS = 15000;

  // 인식 가격으로 받아들일 최대값 (이보다 크면 인식 오류로 보고 버림)
  var MAX_PRICE = 1e10;

  // 이 값보다 작은 시각 값은 "초" 단위로 보고 ×1000 해서 ms 로 바꿈 (파이썬 time.time() 대응)
  // 1e12 ms = 2001년 9월 → 그보다 작은 ms 값은 현실적으로 나올 수 없음
  var SECONDS_THRESHOLD = 1e12;

  // 카테고리 이름 별칭 → 내부 키 (파이썬이 한국어로 보내도 인식)
  var CATEGORY_ALIASES = {
    cooking: 'cooking', cook: 'cooking', '요리': 'cooking',
    craft: 'craft', crafts: 'craft', '공예품': 'craft', '공예': 'craft'
  };

  /* =====================================================================
   * 작은 도우미
   * ===================================================================== */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  /** 가격 값 정리: 0 이상 유한수면 그대로, 문자열 "1,286" 도 허용. 아니면 null */
  function cleanPrice(v) {
    if (typeof v === 'string') {
      var s = v.replace(/[,\s]/g, '').replace(/(골드|[gG])$/, '');
      if (!/^\d+(\.\d+)?$/.test(s)) return null;
      v = Number(s);
    }
    if (!isNum(v) || v < 0 || v > MAX_PRICE) return null;
    return v;
  }

  /** 시각 값 정리: 초 단위면 ms 로 변환. 잘못된 값이면 null */
  function cleanTime(t) {
    if (!isNum(t) || t <= 0) return null;
    return t < SECONDS_THRESHOLD ? Math.round(t * 1000) : Math.round(t);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* =====================================================================
   * 1) 이름 / 카테고리 매칭
   * ===================================================================== */

  /**
   * 비교용 이름 정규화: 유니코드 NFC, 마인크래프트 색상 코드(§a 등)·모든 공백·보이지 않는 문자 제거, 소문자.
   * "토마토 스파게티" / " 토마토스파게티 " / "§6토마토  스파게티" → 모두 같은 값
   */
  function normalizeName(s) {
    var t = String(s === null || s === undefined ? '' : s);
    if (typeof t.normalize === 'function') t = t.normalize('NFC');
    return t
      .replace(/§[0-9a-fk-orA-FK-OR]/g, '')        // 마인크래프트 서식 코드
      .replace(/[\s​-‍﻿ ]+/g, '') // 공백 + 폭 없는 문자
      .toLowerCase();
  }

  /** 'cooking' | 'craft' | null (모르는 값) */
  function normalizeCategory(c) {
    if (typeof c !== 'string') return null;
    var k = c.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(CATEGORY_ALIASES, k) ? CATEGORY_ALIASES[k] : null;
  }

  /**
   * 인식된 이름으로 아이템 찾기.
   * 순서: ① 같은 카테고리 정확히 일치 → ② 전체 정확히 일치 → ③ 같은 카테고리 정규화 일치 → ④ 전체 정규화 일치
   * (category 가 null 이면 ①③ 생략)
   * @param {Array<{category,name}>} items
   * @returns {object|null} 찾은 아이템 객체 (items 안의 원본 참조)
   */
  function matchItem(items, name, category) {
    if (!Array.isArray(items) || typeof name !== 'string') return null;
    var raw = name.trim();
    if (!raw) return null;
    var cat = normalizeCategory(category);
    var norm = normalizeName(raw);
    if (!norm) return null;
    var i;
    if (cat) {
      for (i = 0; i < items.length; i++) if (items[i].category === cat && items[i].name === raw) return items[i];
    }
    for (i = 0; i < items.length; i++) if (items[i].name === raw) return items[i];
    if (cat) {
      for (i = 0; i < items.length; i++) if (items[i].category === cat && normalizeName(items[i].name) === norm) return items[i];
    }
    for (i = 0; i < items.length; i++) if (normalizeName(items[i].name) === norm) return items[i];
    return null;
  }

  /* =====================================================================
   * 2) 인식 이벤트 정리
   * ===================================================================== */

  /**
   * 파이썬 evt → 정리된 객체. 이름이 없으면 null.
   * evt = {name, category|null, rarity, sell, my, history:[{day, price}], ts, confidence}
   * - sell/my: 못 읽었으면 null
   * - ts: 초 또는 ms (없으면 now)
   * - confidence: 0~1 (없으면 null)
   */
  function sanitizeEvent(evt, now) {
    if (typeof evt === 'string') {
      try { evt = JSON.parse(evt); } catch (e) { return null; }
    }
    if (!isObj(evt)) return null;
    var name = typeof evt.name === 'string' ? evt.name.trim() : '';
    if (!name) return null;
    var nowMs = isNum(now) ? now : Date.now();
    var ts = cleanTime(evt.ts);
    // 미래 시각(시계 오차 1분 이상)은 믿지 않고 현재 시각 사용
    if (ts === null || ts > nowMs + 60000) ts = nowMs;
    var hist = [];
    if (Array.isArray(evt.history)) {
      evt.history.forEach(function (h) {
        if (!isObj(h)) return;
        var day = typeof h.day === 'string' ? parseInt(h.day, 10) : h.day;
        var price = cleanPrice(h.price);
        if (isNum(day) && Math.floor(day) === day && day >= 1 && day <= 31 && price !== null) {
          hist.push({ day: day, price: price });
        }
      });
    }
    var conf = isNum(evt.confidence) ? Math.max(0, Math.min(1, evt.confidence)) : null;
    return {
      name: name,
      category: normalizeCategory(evt.category),
      rarity: evt.rarity === undefined ? null : evt.rarity,
      sell: cleanPrice(evt.sell),
      my: cleanPrice(evt.my),
      history: hist,
      ts: ts,
      confidence: conf
    };
  }

  /* =====================================================================
   * 3) 가격 기록(history) 병합
   * ===================================================================== */

  /**
   * "(21일)" 같은 일(day)만 있는 기록의 실제 날짜 추정.
   * 기준: 그 기록을 본 시각(seenAt). 날짜가 본 날보다 뒤면 지난달로 봄.
   * 그 달에 없는 날짜(예: 9월 31일)면 한 달씩 더 거슬러 올라감(최대 3번).
   * @returns {{y:number, m:number(1~12), d:number, key:'YYYY-MM-DD'}|null}
   */
  function inferHistoryDate(day, seenAt) {
    if (!isNum(day) || day < 1 || day > 31 || !isNum(seenAt)) return null;
    var seen = new Date(seenAt);
    var y = seen.getFullYear(), m = seen.getMonth();
    if (day > seen.getDate()) m -= 1;
    for (var k = 0; k < 4; k++) {
      var first = new Date(y, m - k, 1);
      var yy = first.getFullYear(), mm = first.getMonth();
      var dim = new Date(yy, mm + 1, 0).getDate();
      if (day <= dim) {
        return { y: yy, m: mm + 1, d: day, key: yy + '-' + pad2(mm + 1) + '-' + pad2(day) };
      }
    }
    return null;
  }

  /** 기록 한 개의 날짜 키 'YYYY-MM-DD' (계산 불가면 null) */
  function historyKey(entry) {
    var d = entry ? inferHistoryDate(entry.day, entry.seenAt) : null;
    return d ? d.key : null;
  }

  /** 저장된 기록 한 개 검증 → 정리된 {day, price, seenAt} 또는 null */
  function cleanHistoryEntry(e) {
    if (!isObj(e)) return null;
    var price = cleanPrice(e.price);
    var seenAt = cleanTime(e.seenAt);
    if (!isNum(e.day) || Math.floor(e.day) !== e.day || e.day < 1 || e.day > 31 || price === null || seenAt === null) return null;
    return { day: e.day, price: price, seenAt: seenAt };
  }

  /**
   * 기존 기록 + 새로 인식한 기록 병합.
   * - 같은 날짜(연-월-일 추정값)는 하나로 합침 → 더 최근에 본(seenAt 큰) 값이 이김
   * - 날짜 오름차순 정렬 후 최근 max 개만 유지
   * @param {Array<{day,price,seenAt}>} existing  저장된 기록
   * @param {Array<{day,price}>} incoming          이번에 인식한 기록 (seenAt 은 인자로)
   * @param {number} seenAt                          이번 인식 시각(ms)
   * @param {number} [max]                           보관 개수 (기본 HISTORY_MAX)
   * @returns {{list:Array<{day,price,seenAt}>, added:number, changed:number}}
   */
  function mergeHistory(existing, incoming, seenAt, max) {
    var keep = isNum(max) && max > 0 ? Math.floor(max) : HISTORY_MAX;
    var map = {};
    var added = 0, changed = 0;
    (Array.isArray(existing) ? existing : []).forEach(function (e) {
      var c = cleanHistoryEntry(e);
      if (!c) return;
      var k = historyKey(c);
      if (!k) return;
      if (!map[k] || map[k].seenAt <= c.seenAt) map[k] = c;
    });
    var t = cleanTime(seenAt);
    if (t !== null) {
      (Array.isArray(incoming) ? incoming : []).forEach(function (h) {
        var c = cleanHistoryEntry({ day: h && h.day, price: h && h.price, seenAt: t });
        if (!c) return;
        var k = historyKey(c);
        if (!k) return;
        var old = map[k];
        if (!old) { added++; map[k] = c; }
        else if (old.seenAt <= c.seenAt) {
          if (old.price !== c.price) changed++;
          map[k] = c;
        }
      });
    }
    var keys = Object.keys(map).sort();
    if (keys.length > keep) keys = keys.slice(keys.length - keep);
    return { list: keys.map(function (k) { return map[k]; }), added: added, changed: changed };
  }

  /* =====================================================================
   * 4) 범위 자동 확장
   * ===================================================================== */

  /**
   * 실제로 쓰는 범위 = 원래 범위(마스터 데이터)와 확장값(override)의 합집합.
   * @param {{min:number,max:number}} base   원래 최저/최고 (data.js 또는 설정에서 편집한 값)
   * @param {{min?:number,max?:number}|null} ov  자동 확장 값
   * @returns {{min, max, baseMin, baseMax, expandedMin:boolean, expandedMax:boolean}}
   */
  function effectiveRange(base, ov) {
    var bMin = base && isNum(base.min) ? base.min : 0;
    var bMax = base && isNum(base.max) ? base.max : 0;
    var min = bMin, max = bMax;
    if (isObj(ov)) {
      if (isNum(ov.min) && ov.min < min) min = ov.min;
      if (isNum(ov.max) && ov.max > max) max = ov.max;
    }
    return { min: min, max: max, baseMin: bMin, baseMax: bMax, expandedMin: min < bMin, expandedMax: max > bMax };
  }

  /** 이상값 검사: 원래 범위에서 EXPAND_SANITY_FACTOR 배 이상 벗어나면 true */
  function isSuspicious(base, v, factor) {
    var f = isNum(factor) ? factor : EXPAND_SANITY_FACTOR;
    if (!(f > 0)) return false;
    if (isNum(base.max) && base.max > 0 && v > base.max * f) return true;
    if (isNum(base.min) && base.min > 0 && v < base.min / f) return true;
    return false;
  }

  /**
   * 인식한 가격들(현재 판매가 + 지난 가격)이 범위 밖이면 범위를 넓힌 새 override 계산.
   * 기존 override 보다 좁아지지는 않음(한 번 넓힌 범위는 "범위 원래대로" 전까지 유지).
   * @param {{min,max}} base
   * @param {{min?,max?}|null} ov        기존 확장 값
   * @param {Array<number|null>} values  검사할 가격들
   * @param {{sanityFactor?:number}} [opts]
   * @returns {{override:({min?,max?}|null), changed:boolean, rejected:number[], range:object}}
   *   override 가 null 이면 확장 없음(원래 범위 그대로)
   */
  function expandRange(base, ov, values, opts) {
    var factor = opts && isNum(opts.sanityFactor) ? opts.sanityFactor : EXPAND_SANITY_FACTOR;
    var eff = effectiveRange(base, ov);
    var lo = Infinity, hi = -Infinity, rejected = [];
    (Array.isArray(values) ? values : []).forEach(function (v) {
      if (!isNum(v) || v < 0) return;
      if (isSuspicious({ min: eff.baseMin, max: eff.baseMax }, v, factor)) { rejected.push(v); return; }
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    });
    var out = {};
    if (isObj(ov)) {
      if (isNum(ov.min) && ov.min < eff.baseMin) out.min = ov.min;
      if (isNum(ov.max) && ov.max > eff.baseMax) out.max = ov.max;
    }
    var changed = false;
    if (lo < eff.min) { out.min = lo; changed = true; }
    if (hi > eff.max) { out.max = hi; changed = true; }
    var has = out.min !== undefined || out.max !== undefined;
    var override = has ? out : null;
    return { override: override, changed: changed, rejected: rejected, range: effectiveRange(base, override) };
  }

  /* =====================================================================
   * 5) 최근 인식 기록
   * ===================================================================== */

  /**
   * 기록 맨 앞에 추가 (최신이 위). 같은 이름·같은 가격이 LOG_DEDUPE_MS 안에 다시 오면 시각만 갱신.
   * @param {Array} log     기존 기록 (직접 수정하지 않고 새 배열 반환)
   * @param {object} entry  {kind:'ok'|'unknown', name, sell, my, ts, ...}
   * @returns {{log:Array, duplicate:boolean}}
   */
  function pushLog(log, entry, max, dedupeMs) {
    var keep = isNum(max) && max > 0 ? max : LOG_MAX;
    var win = isNum(dedupeMs) ? dedupeMs : LOG_DEDUPE_MS;
    var list = Array.isArray(log) ? log.slice() : [];
    var head = list[0];
    if (head && head.kind === entry.kind && head.name === entry.name && head.sell === entry.sell &&
        head.my === entry.my && !entry.expanded && Math.abs((entry.ts || 0) - (head.ts || 0)) <= win) {
      var merged = Object.assign({}, head, { ts: entry.ts, count: (head.count || 1) + 1 });
      list[0] = merged;
      return { log: list, duplicate: true };
    }
    list.unshift(Object.assign({ count: 1 }, entry));
    if (list.length > keep) list.length = keep;
    return { log: list, duplicate: false };
  }

  return {
    // 설정값
    HISTORY_MAX: HISTORY_MAX,
    EXPAND_SANITY_FACTOR: EXPAND_SANITY_FACTOR,
    LOG_MAX: LOG_MAX,
    LOG_DEDUPE_MS: LOG_DEDUPE_MS,
    // 함수
    cleanPrice: cleanPrice,
    cleanTime: cleanTime,
    normalizeName: normalizeName,
    normalizeCategory: normalizeCategory,
    matchItem: matchItem,
    sanitizeEvent: sanitizeEvent,
    inferHistoryDate: inferHistoryDate,
    historyKey: historyKey,
    cleanHistoryEntry: cleanHistoryEntry,
    mergeHistory: mergeHistory,
    effectiveRange: effectiveRange,
    expandRange: expandRange,
    pushLog: pushLog
  };
});

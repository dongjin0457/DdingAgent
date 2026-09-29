/*
 * calc.js — 띵 에이전트의 가격 계산용 순수 계산 함수 모음 (DOM 사용 없음)
 *
 * - 브라우저: <script src="js/calc.js"> 로 불러오면 window.Calc 로 접근
 * - Node: module.exports 로도 불러올 수 있음
 * ES 모듈을 쓰지 않는 이유: file:// 로 열었을 때 모듈 로딩이 막히기 때문 (UMD 패턴 사용)
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Calc = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* =====================================================================
   * 설정값 (필요하면 자유롭게 바꿔도 되는 값들)
   * ===================================================================== */

  // 한 세트(스택)당 개수. "세트당 가격 = 현재가격 × SET_SIZE" 계산에 사용.
  // 앱의 설정 탭에서 사용자가 바꾼 값이 있으면 그 값이 우선합니다.
  var SET_SIZE = 64;

  // "범위 내 위치 %"가 이 값보다 크면 빨간 굵은 글씨로 강조 (0.8 = 80%).
  // 강조 기준을 바꾸고 싶으면 이 값을 수정하세요.
  var HIGHLIGHT_THRESHOLD = 0.8;

  // 요리 가격이 바뀌는 날짜(매월). 해당 월에 없는 날짜(예: 2월 30일)는 자동으로 건너뜀.
  // 게임 업데이트로 변동일이 바뀌면 이 배열만 수정하면 됩니다.
  var COOKING_CHANGE_DAYS = [1, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30];

  // 가격이 바뀌는 시각(현지 시간, 시 단위). 3 = 오전 3시. 요리·공예품 공통.
  var CHANGE_HOUR = 3;

  // 최적화(분기한정법)에서 탐색할 최대 노드 수. 넘으면 지금까지 찾은 최선의 해를 반환.
  // 값을 키우면 더 정확하지만 느려질 수 있음.
  var OPT_MAX_NODES = 50000;

  // 최적화 최대 계산 시간(밀리초). 넘으면 지금까지 찾은 최선의 해를 반환(optimal=false).
  var OPT_TIME_LIMIT_MS = 1500;

  // 부동소수점 비교 허용 오차 (수학적 내부 값 — 보통 바꿀 필요 없음)
  var EPS = 1e-9;

  // 카테고리 키: 요리 / 공예품
  var CATEGORIES = ['cooking', 'craft'];

  /* =====================================================================
   * 숫자 파싱 / 포맷
   * ===================================================================== */

  /**
   * 사용자가 입력한 문자열을 숫자로 변환.
   * "1,234", "1234G", " 1 234 " 모두 허용. 빈 값이면 null, 해석 불가면 NaN.
   */
  function parseNumber(str) {
    if (str === null || str === undefined) return null;
    if (typeof str === 'number') return isFinite(str) ? str : NaN;
    var s = String(str).replace(/[,\s]/g, '').replace(/[gG]$/, '');
    if (s === '') return null;
    if (!/^-?\d*\.?\d+$/.test(s) && !/^-?\d+\.$/.test(s)) return NaN;
    var n = Number(s);
    return isFinite(n) ? n : NaN;
  }

  /** 유효한 숫자인지 (null/NaN/Infinity 제외) */
  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /** 엑셀 서식 `#,##0` 과 같게: 반올림 + 천 단위 쉼표 */
  function formatInt(n) {
    if (!isNum(n)) return '';
    var r = Math.round(n);
    var neg = r < 0;
    var s = String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + s;
  }

  /** 골드 표기: 41,088G */
  function formatGold(n) {
    return isNum(n) ? formatInt(n) + 'G' : '';
  }

  /** 퍼센트 표기(엑셀 0.00% 서식): 0.279338843 → "27.93%" */
  function formatPercent(p) {
    return isNum(p) ? (p * 100).toFixed(2) + '%' : '';
  }

  /* =====================================================================
   * 가격 표 계산
   * ===================================================================== */

  /**
   * 범위 내 위치 = (현재가 - 최저가) / (최고가 - 최저가)
   * - 최저가 === 최고가 (0으로 나누기) → null
   * - 현재가가 비어 있거나 숫자가 아니면 → null
   * - 범위를 벗어난 값은 그대로 계산됨(음수 또는 1 초과) → rangeStatus 로 판별
   */
  function rangePercent(min, max, cur) {
    if (!isNum(min) || !isNum(max) || !isNum(cur)) return null;
    if (max === min) return null;
    return (cur - min) / (max - min);
  }

  /**
   * 현재가가 최저~최고 범위 안인지 판별.
   * 'below'(최저가 미만) / 'above'(최고가 초과) / 'in'(범위 안) / null(판단 불가)
   */
  function rangeStatus(min, max, cur) {
    if (!isNum(min) || !isNum(max) || !isNum(cur)) return null;
    var lo = Math.min(min, max), hi = Math.max(min, max);
    if (cur < lo) return 'below';
    if (cur > hi) return 'above';
    return 'in';
  }

  /**
   * 실제로 받는 판매 단가 = 나의 판매가(개인 보너스 포함). 비어 있으면 판매가로 대체.
   * 이익/매출(보유 재료 탭, 최적 조합, 세트 판매액) 계산은 모두 이 값을 사용합니다.
   * 범위 내 위치(%)는 이 값이 아니라 "판매가" 로 계산합니다.
   * @returns {number|null} 둘 다 없으면 null
   */
  function salePrice(sell, my) {
    if (isNum(my)) return my;
    if (isNum(sell)) return sell;
    return null;
  }

  /**
   * 요리 이름 → 판매 단가 맵 만들기 (optimizeProduction 의 prices 인자용)
   * @param {Array<{name}>} recipes
   * @param {Object<string,number>} sellMap  이름 → 판매가
   * @param {Object<string,number>} myMap    이름 → 나의 판매가
   */
  function salePriceMap(recipes, sellMap, myMap) {
    var out = {};
    (recipes || []).forEach(function (r) {
      out[r.name] = salePrice(sellMap ? sellMap[r.name] : null, myMap ? myMap[r.name] : null);
    });
    return out;
  }

  /** 세트당 가격 = 현재가 × 세트 크기 (setSize 생략 시 SET_SIZE) */
  function setPrice(cur, setSize) {
    if (!isNum(cur)) return null;
    var size = isNum(setSize) && setSize > 0 ? setSize : SET_SIZE;
    return cur * size;
  }

  /**
   * 행 강조 규칙 계산 (엑셀 조건부 서식 재현)
   * - 퍼센트가 가장 높은 행(동점이면 모두): isMax=true → 노란 배경 + 빨간 굵은 글씨
   * - 퍼센트 > threshold(기본 80%): isHigh=true → 빨간 굵은 글씨
   * @param {Array<number|null>} pcts
   * @returns {Array<{isMax:boolean,isHigh:boolean}>}
   */
  function highlightFlags(pcts, threshold) {
    var th = isNum(threshold) ? threshold : HIGHLIGHT_THRESHOLD;
    var max = -Infinity;
    pcts.forEach(function (p) { if (isNum(p) && p > max) max = p; });
    return pcts.map(function (p) {
      var valid = isNum(p);
      return {
        isMax: valid && max !== -Infinity && Math.abs(p - max) < 1e-12,
        isHigh: valid && p > th
      };
    });
  }

  /* =====================================================================
   * 가격 변동 일정
   * ===================================================================== */

  function toDate(now) {
    return now instanceof Date ? new Date(now.getTime()) : new Date(now);
  }

  /** 해당 연/월(0부터)의 일 수 */
  function daysInMonth(y, m) {
    return new Date(y, m + 1, 0).getDate();
  }

  /** 월 오프셋 k 만큼 떨어진 달의 변동 시각 후보들(오름차순) */
  function cookingCandidates(y, m, k) {
    var base = new Date(y, m + k, 1);
    var yy = base.getFullYear(), mm = base.getMonth();
    var dim = daysInMonth(yy, mm);
    var out = [];
    COOKING_CHANGE_DAYS.slice().sort(function (a, b) { return a - b; }).forEach(function (d) {
      if (d >= 1 && d <= dim) out.push(new Date(yy, mm, d, CHANGE_HOUR, 0, 0, 0));
    });
    return out;
  }

  /**
   * 다음 가격 변동 시각 (now 보다 "엄격히" 뒤인 가장 가까운 시각)
   * - 'cooking': 매월 COOKING_CHANGE_DAYS 의 CHANGE_HOUR 시 (없는 날짜는 건너뜀 → 2월 27일 이후는 3월 1일)
   * - 'craft'  : 매일 CHANGE_HOUR 시
   * 정확히 변동 시각(03:00:00.000)이면 방금 바뀐 것으로 보고 그 다음 시각을 반환.
   */
  function nextChangeTime(now, category) {
    var t = toDate(now);
    if (category === 'craft') {
      var c = new Date(t.getFullYear(), t.getMonth(), t.getDate(), CHANGE_HOUR, 0, 0, 0);
      if (c.getTime() <= t.getTime()) {
        c = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, CHANGE_HOUR, 0, 0, 0);
      }
      return c;
    }
    for (var k = 0; k < 3; k++) {
      var cands = cookingCandidates(t.getFullYear(), t.getMonth(), k);
      for (var i = 0; i < cands.length; i++) {
        if (cands[i].getTime() > t.getTime()) return cands[i];
      }
    }
    return null; // 변동일 설정이 비어 있는 경우
  }

  /**
   * 직전 가격 변동 시각 (now 이하인 가장 최근 시각)
   * "마지막 입력 이후 가격이 바뀌었는지" 판단에 사용.
   */
  function prevChangeTime(now, category) {
    var t = toDate(now);
    if (category === 'craft') {
      var c = new Date(t.getFullYear(), t.getMonth(), t.getDate(), CHANGE_HOUR, 0, 0, 0);
      if (c.getTime() > t.getTime()) {
        c = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1, CHANGE_HOUR, 0, 0, 0);
      }
      return c;
    }
    for (var k = 0; k > -3; k--) {
      var cands = cookingCandidates(t.getFullYear(), t.getMonth(), k);
      for (var i = cands.length - 1; i >= 0; i--) {
        if (cands[i].getTime() <= t.getTime()) return cands[i];
      }
    }
    return null;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 남은 시간(ms) → "2일 03:14:05" / "03:14:05" */
  function formatCountdown(ms) {
    if (!isNum(ms) || ms < 0) ms = 0;
    var total = Math.floor(ms / 1000);
    var d = Math.floor(total / 86400);
    var h = Math.floor((total % 86400) / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return (d > 0 ? d + '일 ' : '') + pad2(h) + ':' + pad2(m) + ':' + pad2(s);
  }

  var WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  /** 날짜 → "10/27 (화) 03:00" */
  function formatDateTime(date) {
    if (!(date instanceof Date)) return '';
    return (date.getMonth() + 1) + '/' + date.getDate() + ' (' + WEEKDAYS[date.getDay()] + ') ' +
      pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  /* =====================================================================
   * 재료 문자열 처리 / 분류
   * ===================================================================== */

  // "토마토 베이스 2개" 한 항목 파싱 정규식
  var ING_RE = /^(.*\S)\s+(\d+)\s*개$/;

  /**
   * "토마토 베이스 2개 + 비트 묶음 1개" → [{name:'토마토 베이스',qty:2},{name:'비트 묶음',qty:1}]
   * 형식이 틀리면 Error 를 던짐. 빈 문자열이면 [].
   */
  function parseIngredients(text) {
    if (text === null || text === undefined) return [];
    var s = String(text).trim();
    if (s === '') return [];
    return s.split('+').map(function (part) {
      var p = part.trim();
      var m = ING_RE.exec(p);
      if (!m) throw new Error('재료 형식 오류: "' + p + '" (예: 토마토 베이스 2개)');
      var qty = parseInt(m[2], 10);
      if (!(qty > 0)) throw new Error('재료 수량은 1 이상이어야 합니다: "' + p + '"');
      return { name: m[1].trim(), qty: qty };
    });
  }

  /** [{name,qty}] → "A 1개 + B 2개" */
  function formatIngredients(list) {
    return (list || []).map(function (it) { return it.name + ' ' + it.qty + '개'; }).join(' + ');
  }

  // 재료 그룹 표시 순서 (보유 재료 탭의 그룹 카드 순서)
  var INGREDIENT_GROUPS = ['베이스', '묶음', '고기', '기타'];

  /** 재료 이름으로 그룹 추정: ~베이스 / ~묶음 / 익힌~·스테이크·~고기 / 기타 */
  function ingredientGroup(name) {
    var n = String(name || '').trim();
    if (/베이스$/.test(n)) return '베이스';
    if (/묶음$/.test(n)) return '묶음';
    if (/^익힌\s/.test(n) || /스테이크/.test(n) || /고기$/.test(n)) return '고기';
    return '기타';
  }

  /** 요리 목록에서 고유 재료 이름을 첫 등장 순서대로 추출 */
  function uniqueIngredients(items) {
    var seen = {}, out = [];
    (items || []).forEach(function (it) {
      (it.ingredients || []).forEach(function (g) {
        if (!Object.prototype.hasOwnProperty.call(seen, g.name)) {
          seen[g.name] = true;
          out.push(g.name);
        }
      });
    });
    return out;
  }

  /* =====================================================================
   * 제작 / 이익 계산
   * ===================================================================== */

  /** 보유 수량 정리: 숫자 아니면 0, 음수는 0, 소수는 버림 */
  function haveOf(inventory, name) {
    var v = inventory ? inventory[name] : 0;
    if (!isNum(v) || v <= 0) return 0;
    return Math.floor(v);
  }

  function costOf(costs, name) {
    var v = costs ? costs[name] : 0;
    return isNum(v) && v > 0 ? v : 0;
  }

  /** 수량이 1 이상인 재료만 */
  function activeIngredients(recipe) {
    return (recipe.ingredients || []).filter(function (g) { return isNum(g.qty) && g.qty > 0; });
  }

  /**
   * 단독으로 만들 수 있는 최대 개수 = min(보유량 / 필요량) (내림)
   * 재료가 하나도 없는 레시피는 0 (계산 불가) 으로 처리.
   */
  function maxCraftable(recipe, inventory) {
    var ings = activeIngredients(recipe);
    if (ings.length === 0) return 0;
    var best = Infinity;
    ings.forEach(function (g) {
      var n = Math.floor(haveOf(inventory, g.name) / g.qty);
      if (n < best) best = n;
    });
    return best === Infinity ? 0 : best;
  }

  /** 요리 1개당 재료비 = Σ(필요 수량 × 재료 단가). 단가 미입력은 0. */
  function unitIngredientCost(recipe, costs) {
    return activeIngredients(recipe).reduce(function (sum, g) {
      return sum + g.qty * costOf(costs, g.name);
    }, 0);
  }

  /** 요리 1개당 이익 = 현재가 − 재료비. 현재가가 없으면 null. */
  function unitProfit(recipe, price, costs) {
    if (!isNum(price)) return null;
    return price - unitIngredientCost(recipe, costs);
  }

  /* =====================================================================
   * 선형계획(LP) — 밀집 심플렉스 (maximize c·x, A·x ≤ b, x ≥ 0, b ≥ 0)
   * b ≥ 0 이므로 원점(여유변수 기저)이 항상 실행 가능 → 1단계(Phase 1) 불필요.
   * ===================================================================== */

  // 심플렉스 최대 피벗 횟수 (문제 크기가 작아 보통 수십 번 이내로 끝남)
  var SIMPLEX_MAX_ITER = 5000;
  // 이 횟수 이후에는 순환 방지를 위해 Bland 규칙으로 전환
  var SIMPLEX_BLAND_AFTER = 200;

  function simplexMax(c, A, b) {
    var m = A.length, n = c.length, W = n + m + 1, R = W - 1;
    var T = new Array(m + 1), basis = new Array(m);
    var i, j;
    var cScale = 1;
    for (j = 0; j < n; j++) cScale = Math.max(cScale, Math.abs(c[j]));
    var epsObj = EPS * cScale;
    for (i = 0; i < m; i++) {
      var row = new Float64Array(W);
      for (j = 0; j < n; j++) row[j] = A[i][j];
      row[n + i] = 1;
      row[R] = b[i];
      T[i] = row;
      basis[i] = n + i;
    }
    var obj = new Float64Array(W);
    for (j = 0; j < n; j++) obj[j] = -c[j];
    T[m] = obj;

    for (var iter = 0; iter < SIMPLEX_MAX_ITER; iter++) {
      var bland = iter >= SIMPLEX_BLAND_AFTER;
      var e = -1, best = -epsObj;
      for (j = 0; j < R; j++) {
        if (obj[j] < best) {
          e = j;
          if (bland) break;
          best = obj[j];
        }
      }
      if (e < 0) break; // 최적
      var r = -1, minRatio = Infinity;
      for (i = 0; i < m; i++) {
        var a = T[i][e];
        if (a > EPS) {
          var ratio = T[i][R] / a;
          if (ratio < minRatio - EPS || (ratio <= minRatio + EPS && r >= 0 && basis[i] < basis[r])) {
            minRatio = ratio;
            r = i;
          }
        }
      }
      if (r < 0) return { unbounded: true };
      // 피벗
      var pr = T[r], pv = pr[e];
      for (j = 0; j < W; j++) pr[j] /= pv;
      for (i = 0; i <= m; i++) {
        if (i === r) continue;
        var ri = T[i], f = ri[e];
        if (f !== 0) {
          for (j = 0; j < W; j++) ri[j] -= f * pr[j];
        }
      }
      basis[r] = e;
    }
    var x = new Array(n);
    for (j = 0; j < n; j++) x[j] = 0;
    for (i = 0; i < m; i++) {
      if (basis[i] < n) x[basis[i]] = Math.max(0, T[i][R]);
    }
    return { x: x, value: obj[R] };
  }

  /* =====================================================================
   * 최적 생산 조합 (정수계획) — LP 완화 + 분기한정법(Branch & Bound)
   * ===================================================================== */

  /**
   * 공유 재료를 두고 경쟁하는 여러 요리의 "총 이익"을 최대화하는 생산 개수를 계산.
   *
   * @param {Array<{name:string, ingredients:Array<{name:string,qty:number}>}>} recipes 요리 목록
   * @param {Object<string,number|null>} prices  요리 이름 → 현재 판매가
   * @param {Object<string,number>} inventory    재료 이름 → 보유 수량
   * @param {Object<string,number>} costs        재료 이름 → 개당 비용 (없으면 0)
   * @param {{maxNodes?:number,timeLimitMs?:number}} [options]
   * @returns {{
   *   counts: Object<string,number>, perRecipe: Array, excluded: Array<{name,reason}>,
   *   totalRevenue:number, totalCost:number, totalProfit:number,
   *   leftoverInventory: Object<string,number>, optimal:boolean, upperBound:number, nodes:number
   * }}
   *
   * 알고리즘:
   *  1) 이익 ≤ 0 이거나 가격/재료가 없는 요리는 제외(생산 0).
   *  2) 탐욕법(greedy) 여러 순서로 초기 해(incumbent)를 만듦.
   *  3) 각 노드에서 LP 완화를 심플렉스로 풀어 상한(bound) 계산.
   *     하한 x_j ≥ l_j 는 변수 치환(x = l + y, b' = b − A·l)으로, 상한 x_j ≤ u_j 는 제약 행으로 추가.
   *  4) LP 해를 내림 + 탐욕 채우기로 정수해를 만들어 incumbent 갱신.
   *  5) 소수부가 0.5 에 가장 가까운 변수로 분기. 상한이 가장 큰 노드부터 확장(최선 우선).
   *     상한 ≤ incumbent 이면 가지치기 (이익이 모두 정수면 상한을 내림해서 비교).
   *  6) 노드 수/시간 제한을 넘으면 중단하고 최선의 해 반환(optimal=false).
   */
  function optimizeProduction(recipes, prices, inventory, costs, options) {
    var opts = options || {};
    var maxNodes = isNum(opts.maxNodes) ? opts.maxNodes : OPT_MAX_NODES;
    var timeLimit = isNum(opts.timeLimitMs) ? opts.timeLimitMs : OPT_TIME_LIMIT_MS;
    var startTime = Date.now();
    recipes = recipes || [];
    prices = prices || {};

    var excluded = [];
    var elig = []; // 최적화 대상 요리 인덱스
    var profitOf = recipes.map(function (r) {
      var price = prices[r.name];
      var ings = activeIngredients(r);
      if (!isNum(price)) { excluded.push({ name: r.name, reason: 'noPrice' }); return null; }
      if (ings.length === 0) { excluded.push({ name: r.name, reason: 'noIngredients' }); return null; }
      var p = unitProfit(r, price, costs);
      if (!(p > 0)) { excluded.push({ name: r.name, reason: 'nonPositiveProfit' }); return p; }
      return p;
    });
    recipes.forEach(function (r, idx) {
      var ings = activeIngredients(r);
      if (isNum(prices[r.name]) && ings.length > 0 && profitOf[idx] > 0) elig.push(idx);
    });

    // 사용되는 재료(행) 목록
    var ingNames = [];
    var ingIndex = {};
    elig.forEach(function (idx) {
      activeIngredients(recipes[idx]).forEach(function (g) {
        if (!Object.prototype.hasOwnProperty.call(ingIndex, g.name)) {
          ingIndex[g.name] = ingNames.length;
          ingNames.push(g.name);
        }
      });
    });
    var m = ingNames.length, n = elig.length;
    var A = [], b = [];
    var i, j;
    for (i = 0; i < m; i++) {
      A.push(new Array(n).fill(0));
      b.push(haveOf(inventory, ingNames[i]));
    }
    for (j = 0; j < n; j++) {
      activeIngredients(recipes[elig[j]]).forEach(function (g) {
        A[ingIndex[g.name]][j] += g.qty; // 같은 재료가 두 번 적혀 있으면 합산
      });
    }
    var c = elig.map(function (idx) { return profitOf[idx]; });
    // 각 변수의 자연 상한 = 단독 최대 제작 수
    var natUb = [];
    for (j = 0; j < n; j++) {
      var u = Infinity;
      for (i = 0; i < m; i++) if (A[i][j] > 0) u = Math.min(u, Math.floor(b[i] / A[i][j]));
      natUb.push(u === Infinity ? 0 : u);
    }
    // 이익이 모두 정수면 상한을 내림하여 더 강하게 가지치기 가능
    var intProfits = c.every(function (v) { return Math.abs(v - Math.round(v)) < 1e-9; });

    function valueOf(x) {
      var s = 0;
      for (var k = 0; k < n; k++) s += c[k] * x[k];
      return s;
    }

    /** 남은 재료로 order 순서대로 최대한 채워 넣기 (x 를 직접 수정) */
    function greedyFill(x, order) {
      var rem = b.slice();
      var k, t;
      for (k = 0; k < m; k++) for (t = 0; t < n; t++) rem[k] -= A[k][t] * x[t];
      order.forEach(function (t2) {
        var can = Infinity;
        for (var k2 = 0; k2 < m; k2++) {
          if (A[k2][t2] > 0) can = Math.min(can, Math.floor((rem[k2] + EPS) / A[k2][t2]));
        }
        if (can === Infinity || can <= 0) return;
        x[t2] += can;
        for (var k3 = 0; k3 < m; k3++) rem[k3] -= A[k3][t2] * can;
      });
      return x;
    }

    var bestX = new Array(n).fill(0), bestVal = 0;
    function tryIncumbent(x) {
      var v = valueOf(x);
      if (v > bestVal + EPS) { bestVal = v; bestX = x.slice(); }
    }

    // 탐욕 순서 후보들: ① 개당 이익 큰 순 ② 희소 재료 대비 이익 큰 순
    var idxs = [];
    for (j = 0; j < n; j++) idxs.push(j);
    var orderProfit = idxs.slice().sort(function (p, q) { return c[q] - c[p]; });
    var orderDensity = idxs.slice().sort(function (p, q) {
      function dens(t) {
        var use = 0;
        for (var k = 0; k < m; k++) if (A[k][t] > 0) use += A[k][t] / Math.max(b[k], 1);
        return c[t] / Math.max(use, EPS);
      }
      return dens(q) - dens(p);
    });
    if (n > 0) {
      tryIncumbent(greedyFill(new Array(n).fill(0), orderProfit));
      tryIncumbent(greedyFill(new Array(n).fill(0), orderDensity));
    }

    /** 노드 LP: lo ≤ x ≤ hi 에서 LP 완화 풀기 */
    function solveNode(lo, hi) {
      var bb = new Array(m), k, t;
      for (k = 0; k < m; k++) {
        var s = b[k];
        for (t = 0; t < n; t++) s -= A[k][t] * lo[t];
        if (s < -EPS) return null; // 하한만으로 재료 초과 → 불가능
        bb[k] = Math.max(0, s);
      }
      var AA = A.slice(), rhs = bb.slice();
      for (t = 0; t < n; t++) {
        if (hi[t] < lo[t]) return null;
        var row = new Array(n).fill(0);
        row[t] = 1;
        AA.push(row);
        rhs.push(hi[t] - lo[t]);
      }
      var res = simplexMax(c, AA, rhs);
      if (!res || res.unbounded) return null;
      var x = new Array(n);
      for (t = 0; t < n; t++) x[t] = lo[t] + res.x[t];
      return { x: x, bound: valueOf(lo) + res.value };
    }

    function prunable(bound) {
      if (intProfits) return Math.floor(bound + 1e-6) <= Math.round(bestVal);
      return bound <= bestVal + EPS * Math.max(1, Math.abs(bestVal));
    }

    // ── 최선 우선(best-first) 분기한정: 상한(bound)이 가장 큰 노드부터 확장 ──
    // 힙에서 꺼낸 최대 상한조차 가지치기 대상이면 남은 노드 전부 가지치기 → 최적 증명 완료.
    var heap = [];
    function heapPush(nd) {
      heap.push(nd);
      var k = heap.length - 1;
      while (k > 0) {
        var p = (k - 1) >> 1;
        if (heap[p].bound >= heap[k].bound) break;
        var tmp = heap[p]; heap[p] = heap[k]; heap[k] = tmp; k = p;
      }
    }
    function heapPop() {
      var top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        var k = 0;
        for (;;) {
          var l = 2 * k + 1, r = l + 1, big = k;
          if (l < heap.length && heap[l].bound > heap[big].bound) big = l;
          if (r < heap.length && heap[r].bound > heap[big].bound) big = r;
          if (big === k) break;
          var t2 = heap[big]; heap[big] = heap[k]; heap[k] = t2; k = big;
        }
      }
      return top;
    }

    var nodes = 0, complete = true;
    /** 노드 하나의 LP 를 풀고, 휴리스틱으로 incumbent 갱신 후 필요하면 힙에 넣음 */
    function expand(lo, hi) {
      var sol = solveNode(lo, hi);
      nodes++;
      if (!sol) return;
      // 내림 + 탐욕 채우기로 정수해 후보 만들기
      var rounded = sol.x.map(function (v, t) {
        return Math.max(lo[t], Math.min(hi[t], Math.floor(v + 1e-7)));
      });
      tryIncumbent(greedyFill(rounded, orderProfit));
      if (prunable(sol.bound)) return;
      // 분기 변수: 소수부가 0.5 에 가장 가까운 변수
      var br = -1, bestFrac = -1;
      for (var t = 0; t < n; t++) {
        var f = sol.x[t] - Math.floor(sol.x[t] + 1e-7);
        if (f > 1e-7 && f < 1 - 1e-7) {
          var score = 0.5 - Math.abs(f - 0.5);
          if (score > bestFrac) { bestFrac = score; br = t; }
        }
      }
      if (br < 0) { // LP 해가 이미 정수 → 이 구간의 최적해
        tryIncumbent(sol.x.map(function (v) { return Math.round(v); }));
        return;
      }
      heapPush({ lo: lo, hi: hi, x: sol.x, bound: sol.bound, br: br });
    }

    var upperBound = bestVal;
    if (n > 0) {
      expand(new Array(n).fill(0), natUb.slice());
      if (heap.length) upperBound = Math.max(bestVal, heap[0].bound);
      while (heap.length) {
        if (nodes >= maxNodes || Date.now() - startTime > timeLimit) { complete = false; break; }
        var node = heapPop();
        if (prunable(node.bound)) { heap.length = 0; break; } // 최대 상한도 개선 불가 → 종료
        var fl = Math.floor(node.x[node.br] + 1e-7);
        var hiDn = node.hi.slice(); hiDn[node.br] = fl;
        var loUp = node.lo.slice(); loUp[node.br] = fl + 1;
        expand(node.lo, hiDn);
        expand(loUp, node.hi);
      }
    }
    // 증명 완료면 상한 = 최적값, 아니면 남은 노드 중 최대 상한(이론상 가능한 최대 이익)
    upperBound = complete ? bestVal : Math.max(bestVal, heap.length ? heap[0].bound : bestVal);

    // 결과 정리
    var counts = {};
    recipes.forEach(function (r) { counts[r.name] = 0; });
    for (j = 0; j < n; j++) counts[recipes[elig[j]].name] += Math.round(bestX[j]);

    var leftover = {};
    Object.keys(inventory || {}).forEach(function (k) { leftover[k] = haveOf(inventory, k); });
    var totalRevenue = 0, totalCost = 0;
    var perRecipe = recipes.map(function (r) {
      var cnt = counts[r.name] || 0;
      var price = isNum(prices[r.name]) ? prices[r.name] : null;
      var uc = unitIngredientCost(r, costs);
      if (cnt > 0) {
        activeIngredients(r).forEach(function (g) {
          leftover[g.name] = (leftover[g.name] || 0) - g.qty * cnt;
        });
      }
      var rev = cnt > 0 ? price * cnt : 0;
      totalRevenue += rev;
      totalCost += uc * cnt;
      return {
        name: r.name, count: cnt, price: price, unitCost: uc,
        unitProfit: price === null ? null : price - uc,
        revenue: rev, cost: uc * cnt, profit: rev - uc * cnt
      };
    });

    return {
      counts: counts,
      perRecipe: perRecipe,
      excluded: excluded,
      totalRevenue: totalRevenue,
      totalCost: totalCost,
      totalProfit: totalRevenue - totalCost,
      leftoverInventory: leftover,
      optimal: complete,
      upperBound: upperBound,
      nodes: nodes,
      elapsedMs: Date.now() - startTime
    };
  }

  return {
    // 설정값
    SET_SIZE: SET_SIZE,
    HIGHLIGHT_THRESHOLD: HIGHLIGHT_THRESHOLD,
    COOKING_CHANGE_DAYS: COOKING_CHANGE_DAYS,
    CHANGE_HOUR: CHANGE_HOUR,
    OPT_MAX_NODES: OPT_MAX_NODES,
    OPT_TIME_LIMIT_MS: OPT_TIME_LIMIT_MS,
    CATEGORIES: CATEGORIES,
    INGREDIENT_GROUPS: INGREDIENT_GROUPS,
    // 숫자
    parseNumber: parseNumber,
    isNum: isNum,
    formatInt: formatInt,
    formatGold: formatGold,
    formatPercent: formatPercent,
    // 가격 표
    rangePercent: rangePercent,
    rangeStatus: rangeStatus,
    salePrice: salePrice,
    salePriceMap: salePriceMap,
    setPrice: setPrice,
    highlightFlags: highlightFlags,
    // 일정
    nextChangeTime: nextChangeTime,
    prevChangeTime: prevChangeTime,
    formatCountdown: formatCountdown,
    formatDateTime: formatDateTime,
    // 재료
    parseIngredients: parseIngredients,
    formatIngredients: formatIngredients,
    ingredientGroup: ingredientGroup,
    uniqueIngredients: uniqueIngredients,
    // 제작/이익
    maxCraftable: maxCraftable,
    unitIngredientCost: unitIngredientCost,
    unitProfit: unitProfit,
    simplexMax: simplexMax,
    optimizeProduction: optimizeProduction
  };
});

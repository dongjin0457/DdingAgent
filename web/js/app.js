/*
 * app.js — 화면(DOM) 구성과 이벤트 처리
 * 의존: data.js(window.DEFAULT_DATA), calc.js(window.Calc), recog.js(window.Recog),
 *       state.js(window.AppState), storage.js(window.AppStorage)
 * 프레임워크 없이 순수 JS. 계산은 전부 Calc/Recog 의 순수 함수에 맡기고 여기서는 표시만 담당.
 *
 * ── 파이썬(자동 인식 엔진) ↔ JS 연동 ──
 *  파이썬 → JS (evaluate_js 로 호출):
 *    window.DdingApp.onRecognized(evt)      evt = {name, category|null, rarity, sell, my, history:[{day, price}], ts, confidence}
 *    window.DdingApp.onCaptureStatus(st)    st  = {enabled, running, minecraftFound, foreground, lastReadAt, lastError, fpsActual}
 *    window.DdingApp.getKnownItems()        → [{name, category, min, max}] (필요하면 파이썬이 직접 가져가도 됨)
 *  JS → 파이썬 (window.pywebview.api 가 있을 때만, 모든 호출은 존재 여부 확인 후 실행):
 *    set_known_items(list) / set_auto_capture(bool) / get_capture_status() / force_read() / set_hotkey(spec)
 *  브라우저에서 화면 확인용: window.DdingApp.__simulate(evt)  ·  주소 끝에 #demo / #demo-hist / #demo-settings
 */
(function () {
  'use strict';

  var C = window.Calc;
  var R = window.Recog;
  var S = window.AppState;
  var ST = window.AppStorage;
  var DD = window.DEFAULT_DATA || { items: [], ingredients: [] };

  /* =====================================================================
   * 화면 관련 설정값 (자유롭게 조정 가능)
   * ===================================================================== */

  // 보유 재료/비용 입력 후 최적 조합을 다시 계산하기까지 기다리는 시간(ms).
  // 너무 짧으면 타이핑 중 계산이 잦아지고, 길면 결과가 늦게 보임.
  var OPTIMIZE_DEBOUNCE_MS = 200;

  // 하단 알림(토스트) 표시 시간(ms)
  var TOAST_MS = 2400;

  // 카운트다운 갱신 주기(ms). 1000 = 1초마다. (자동 인식 상태의 "N초 전" 표시도 같이 갱신)
  var COUNTDOWN_TICK_MS = 1000;

  // 퍼센트 막대 색 구간: 이 값 미만이면 파란색(낮음). 높음(빨강) 기준은 Calc.HIGHLIGHT_THRESHOLD.
  var BAR_LOW_THRESHOLD = 0.3;

  // 가져오기 실패 시 대화상자에 보여줄 최대 오류 줄 수
  var MAX_IMPORT_ERRORS_SHOWN = 12;

  // 자동 인식으로 값이 바뀐 행을 반짝이는 시간(ms). CSS 의 @keyframes rowFlash 길이와 맞추세요.
  var FLASH_MS = 1800;

  // 자동 인식이 켜져 있을 때 파이썬에 상태를 물어보는 주기(ms).
  // 파이썬이 onCaptureStatus 로 직접 알려주지 못한 경우를 대비한 보조 수단.
  var CAPTURE_POLL_MS = 2000;

  // 목록/범위가 바뀐 뒤 파이썬에 아이템 목록(set_known_items)을 보내기까지 기다리는 시간(ms)
  var KNOWN_ITEMS_DEBOUNCE_MS = 600;

  // 앱이 준비되기 전에 도착한 인식 이벤트를 최대 몇 개까지 보관했다가 처리할지
  var MAX_PENDING_EVENTS = 50;

  // 가격 기록 미니 그래프 크기(px)
  var SPARK_W = 288;
  var SPARK_H = 76;

  var CAT_LABEL = { cooking: '요리', craft: '공예품' };
  var CAT_ICON = { cooking: '🍳', craft: '🎨' };
  var REASON_LABEL = {
    noPrice: '판매가 미입력',
    noIngredients: '재료 정보 없음',
    nonPositiveProfit: '이익 0 이하'
  };

  var state = null;           // 전체 앱 상태 (state.js 참고)
  var optTimer = null;        // 최적화 디바운스 타이머
  var optDirty = true;        // 보유 재료 탭 결과를 다시 계산해야 하는지

  // 데모 모드(#demo…): 시뮬레이션 이벤트를 보여 주기만 하고 저장하지 않음 (실제 데이터 보호)
  var demoMode = /^#demo/.test(window.location.hash || '');

  /* =====================================================================
   * 작은 도우미 함수
   * ===================================================================== */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /** HTML 이스케이프 (이름 등 사용자 입력을 innerHTML 에 넣을 때 필수) */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var fmtG = C.formatGold;

  /** 입력칸에 보여줄 숫자: 정수면 쉼표, 소수면 그대로 */
  function fmtInput(n) {
    if (!C.isNum(n)) return '';
    return Number.isInteger(n) ? C.formatInt(n) : String(n);
  }

  /** 개수를 "2세트 5개" 로 */
  function fmtSets(count) {
    var size = setSize();
    var sets = Math.floor(count / size), rest = count % size;
    if (sets === 0) return rest + '개';
    return sets + '세트' + (rest ? ' ' + rest + '개' : '');
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtClock(ms) { var d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }

  /** 몇 초/분 전 */
  function fmtAgo(ms) {
    if (!C.isNum(ms)) return '';
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 3) return '방금';
    if (s < 60) return s + '초 전';
    if (s < 3600) return Math.floor(s / 60) + '분 전';
    return C.formatDateTime(new Date(ms));
  }

  function signClass(n) { return n > 0 ? 'pos' : (n < 0 ? 'neg' : ''); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function master() { return state.master || S.defaultMaster(DD); }
  function itemsOf(cat) { return master().items.filter(function (i) { return i.category === cat; }); }
  function setSize() { return state.settings.setSize; }
  function numOrNull(v) { return C.isNum(v) ? v : null; }
  /** 판매가 (범위 % 기준) */
  function sellOf(cat, name) { return numOrNull(state.sell[cat][name]); }
  /** 나의 판매가 (개인 보너스 포함) */
  function myOf(cat, name) { return numOrNull(state.my[cat][name]); }
  /** 실제 판매 단가 = 나의 판매가, 없으면 판매가 (이익/매출 계산용) */
  function saleOf(cat, name) { return C.salePrice(sellOf(cat, name), myOf(cat, name)); }
  /** 자동 확장을 반영한 실제 최저~최고 범위 */
  function rangeOf(cat, it) { return R.effectiveRange(it, state.rangeOverride[cat][it.name]); }

  function persist() { if (!demoMode) ST.save(state); }

  /** 아이템 이름을 키로 쓰는 상태 맵들 (이름 변경/삭제 시 같이 옮기거나 지움) */
  function itemMaps(cat) {
    return [state.sell[cat], state.my[cat], state.itemUpdatedAt[cat], state.rangeOverride[cat], state.history[cat]];
  }
  function renameItemData(cat, oldName, newName) {
    itemMaps(cat).forEach(function (m) {
      if (has(m, oldName)) { m[newName] = m[oldName]; delete m[oldName]; }
    });
  }
  function deleteItemData(cat, name) {
    itemMaps(cat).forEach(function (m) { delete m[name]; });
  }
  /** 목록에서 사라진 아이템의 가격/기록/확장 범위 정리 */
  function pruneItemData() {
    C.CATEGORIES.forEach(function (cat) {
      itemMaps(cat).forEach(function (m) {
        Object.keys(m).forEach(function (n) { if (!findItem(cat, n)) delete m[n]; });
      });
    });
  }

  /** 마스터 데이터를 처음 편집할 때 기본값을 복사해서 상태에 저장 */
  function ensureMasterCopy() {
    if (!state.master) state.master = JSON.parse(JSON.stringify(S.defaultMaster(DD)));
    return state.master;
  }

  function findItem(cat, name) {
    var list = master().items;
    for (var i = 0; i < list.length; i++) {
      if (list[i].category === cat && list[i].name === name) return list[i];
    }
    return null;
  }

  /** 가격 표에서 이름으로 행 찾기 (CSS 선택자 이스케이프 문제를 피하려고 직접 비교) */
  function findRow(cat, name) {
    var trs = $$('#panel-' + cat + ' tbody tr[data-name]');
    for (var i = 0; i < trs.length; i++) if (trs[i].dataset.name === name) return trs[i];
    return null;
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, TOAST_MS);
  }

  /* =====================================================================
   * 확인/알림 대화상자 (Promise 반환)
   * ===================================================================== */

  var modalResolve = null;
  function openModal(opts) {
    var m = $('#modal');
    $('#modalTitle').textContent = opts.title || '';
    $('#modalBody').textContent = opts.body || '';
    var ok = $('#modalOk'), cancel = $('#modalCancel');
    ok.textContent = opts.okText || '확인';
    ok.classList.toggle('danger-ok', !!opts.danger);
    cancel.hidden = !!opts.alertOnly;
    m.hidden = false;
    setTimeout(function () { (opts.danger ? cancel : ok).focus(); }, 0);
    return new Promise(function (resolve) { modalResolve = resolve; });
  }
  function closeModal(result) {
    $('#modal').hidden = true;
    if (modalResolve) { var r = modalResolve; modalResolve = null; r(result); }
  }
  function confirmDialog(title, body, okText, danger) {
    return openModal({ title: title, body: body, okText: okText, danger: danger });
  }
  function alertDialog(title, body) {
    return openModal({ title: title, body: body, alertOnly: true });
  }

  /* =====================================================================
   * 탭 전환 / 테마
   * ===================================================================== */

  function setTab(tab) {
    if (S.TABS.indexOf(tab) < 0) tab = 'cooking';
    state.settings.activeTab = tab;
    $$('.tab').forEach(function (b) {
      var on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.dataset.panel === tab); });
    if (tab === 'inventory' && optDirty) runOptimize();
    closeHistPop();
    persist();
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.settings.theme === 'light' ? 'light' : 'dark');
    var sel = $('#themeSelect');
    if (sel) sel.value = state.settings.theme;
  }

  /* =====================================================================
   * 가격 탭 (요리 / 공예품)
   * ===================================================================== */

  function renderPricePanel(cat) {
    var panel = $('#panel-' + cat);
    var items = itemsOf(cat);
    var isCook = cat === 'cooking';
    var rows = items.map(function (it, idx) {
      var chips = isCook
        ? '<td class="ings"><div class="chips">' + (it.ingredients || []).map(function (g) {
            // 수량이 1개면 이름만, 2개 이상이면 "×2" 표시 (표를 짧게 유지)
            return '<span class="chip">' + esc(g.name) + (g.qty > 1 ? ' <b>×' + g.qty + '</b>' : '') + '</span>';
          }).join('') + '</div></td>'
        : '';
      return '<tr data-name="' + esc(it.name) + '" data-idx="' + idx + '">' +
        '<td class="name"><div class="name-cell"><span class="nm">' + esc(it.name) + '</span>' +
          '<button type="button" class="hist-btn" data-hist aria-label="' + esc(it.name) + ' 가격 기록">' +
          '<span aria-hidden="true">📈</span><small data-hist-n></small></button></div></td>' +
        '<td class="num muted range-cell" data-min></td>' +
        '<td class="num muted range-cell" data-max></td>' +
        '<td class="num"><input class="field numeric price" data-kind="sell" inputmode="numeric" autocomplete="off" spellcheck="false"' +
        ' value="' + esc(fmtInput(sellOf(cat, it.name))) + '" placeholder="입력" aria-label="' + esc(it.name) + ' 판매가"></td>' +
        '<td class="num"><input class="field numeric price my-price" data-kind="my" inputmode="numeric" autocomplete="off" spellcheck="false"' +
        ' value="' + esc(fmtInput(myOf(cat, it.name))) + '" aria-label="' + esc(it.name) + ' 나의 판매가"></td>' +
        '<td class="pct-cell"><div class="pct"><span class="oor-tag"></span><div class="bar"><span></span></div><span class="pct-text"></span></div></td>' +
        '<td class="num" data-set></td>' + chips + '</tr>';
    }).join('');
    if (!items.length) {
      rows = '<tr><td colspan="' + (isCook ? 8 : 7) + '" class="empty">항목이 없습니다. ⚙️ 설정 탭에서 추가하세요.</td></tr>';
    }

    panel.innerHTML =
      '<div class="panel-head">' +
        '<div class="countdown"><span class="cd-label">다음 가격 변동까지</span>' +
          '<span class="cd-time" data-cd-time>--:--:--</span><span class="cd-at" data-cd-at></span></div>' +
        '<div class="stale" data-stale hidden></div>' +
        '<div class="spacer"></div>' +
        '<span class="top-stat" data-top-stat></span>' +
        '<label class="switch"><input type="checkbox" data-sort' + (state.settings.sortByPct[cat] ? ' checked' : '') + '> % 높은 순 정렬</label>' +
        '<button class="btn danger" data-clear>가격 전체 비우기</button>' +
      '</div>' +
      '<div class="table-wrap"><table class="grid price-table"><thead><tr>' +
        '<th>이름</th><th class="num">최저가</th><th class="num">최고가</th>' +
        '<th class="num" title="게임 툴팁의 &quot;판매가&quot; — 범위 내 위치(%) 계산에 사용">판매가</th>' +
        '<th class="num" title="게임 툴팁의 &quot;나의 판매가&quot;(개인 보너스 포함) — 이익·매출 계산에 사용. 비우면 판매가 사용">나의 판매가</th>' +
        '<th class="num" title="판매가 기준">범위 내 위치</th>' +
        '<th class="num" title="나의 판매가 × 세트 크기 (나의 판매가가 비어 있으면 판매가)">세트 판매액<small>나의 판매가 ×' + setSize() + '</small></th>' +
        (isCook ? '<th>재료</th>' : '') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="legend">' +
        '<span><i class="sw max"></i>가장 높은 % (노란 배경)</span>' +
        '<span><i class="sw high"></i>' + Math.round(C.HIGHLIGHT_THRESHOLD * 100) + '% 초과 (빨간 굵은 글씨)</span>' +
        '<span><i class="sw oor"></i>최저~최고 범위 밖</span>' +
        '<span><b class="exp-legend">▼▲</b>자동 확장된 범위 (클릭하면 기록·원래대로)</span>' +
        '<span>범위 내 위치 = (판매가 − 최저가) ÷ (최고가 − 최저가) · Enter/↑↓ 로 다음 칸 이동</span>' +
      '</div>';

    var tbody = $('tbody', panel);
    $$('tr[data-name]', tbody).forEach(function (tr) { updatePriceRow(cat, tr); });
    applyHighlights(cat);
    applyOrder(cat);
    updateCountdowns();

    // ── 이벤트 ──
    tbody.addEventListener('input', function (e) {
      if (!e.target.classList.contains('price')) return;
      onPriceInput(cat, e.target);
    });
    tbody.addEventListener('keydown', function (e) {
      if (!e.target.classList.contains('price')) return;
      var dir = 0;
      if (e.key === 'Enter' || e.key === 'ArrowDown') dir = 1;
      else if (e.key === 'ArrowUp') dir = -1;
      if (!dir) return;
      e.preventDefault();
      // 같은 열(판매가 ↔ 판매가, 나의 판매가 ↔ 나의 판매가) 안에서 위/아래 이동
      var inputs = $$('input.price[data-kind="' + e.target.dataset.kind + '"]', tbody);
      var next = inputs[inputs.indexOf(e.target) + dir];
      if (next) { next.focus(); next.select(); }
    });
    // 입력칸을 벗어날 때 쉼표 서식 적용
    tbody.addEventListener('focusout', function (e) {
      if (e.target.classList.contains('price')) {
        var v = C.parseNumber(e.target.value);
        if (C.isNum(v)) e.target.value = fmtInput(v);
      }
      // 표 밖으로 포커스가 나갈 때만 재정렬 (입력 중 행이 움직이지 않게)
      if (!e.relatedTarget || !tbody.contains(e.relatedTarget)) applyOrder(cat);
    });
    tbody.addEventListener('focusin', function (e) {
      if (e.target.classList.contains('price')) e.target.select();
    });
    tbody.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-hist], [data-range-mark]');
      if (!btn) return;
      var tr = btn.closest('tr');
      toggleHistPop(cat, tr.dataset.name, btn);
    });
    $('[data-sort]', panel).addEventListener('change', function (e) {
      state.settings.sortByPct[cat] = e.target.checked;
      applyOrder(cat);
      persist();
    });
    $('[data-clear]', panel).addEventListener('click', function () {
      confirmDialog('가격 전체 비우기', CAT_LABEL[cat] + ' 탭의 판매가·나의 판매가를 모두 지울까요?\n' +
        '(최저가/최고가, 가격 기록, 자동 확장된 범위는 그대로 유지됩니다)', '모두 비우기', true)
        .then(function (ok) {
          if (!ok) return;
          state.sell[cat] = {};
          state.my[cat] = {};
          state.itemUpdatedAt[cat] = {};
          state.priceUpdatedAt[cat] = null;
          persist();
          renderPricePanel(cat);
          if (cat === 'cooking') scheduleOptimize();
          toast('가격을 모두 비웠습니다.');
        });
    });
  }

  /** 판매가 / 나의 판매가 입력 처리 */
  function onPriceInput(cat, input) {
    var tr = input.closest('tr');
    var name = tr.dataset.name;
    var kind = input.dataset.kind === 'my' ? 'my' : 'sell';
    var v = C.parseNumber(input.value);
    if (v !== null && (!C.isNum(v) || v < 0)) {
      input.classList.add('invalid');
      input.title = '0 이상의 숫자를 입력하세요';
      return;
    }
    input.classList.remove('invalid');
    input.title = '';
    if (v === null) delete state[kind][cat][name];
    else state[kind][cat][name] = v;
    var now = Date.now();
    state.priceUpdatedAt[cat] = now;
    state.itemUpdatedAt[cat][name] = now;
    persist();
    updatePriceRow(cat, tr);
    applyHighlights(cat);
    updateStale(cat, new Date());
    if (cat === 'cooking') scheduleOptimize();
    if (pop.cat === cat && pop.name === name) renderHistPop();
  }

  /** 최저가/최고가 칸 그리기 (자동 확장됐으면 ▼/▲ 표시 + 툴팁) */
  function setRangeCell(td, value, expanded, baseValue, which) {
    var html = fmtG(value);
    if (expanded) {
      var tip = '자동 확장됨: 원래 ' + C.formatInt(baseValue);
      html = '<button type="button" class="exp-mark" data-range-mark title="' + esc(tip) + '" aria-label="' + esc(tip) + '">' +
        (which === 'min' ? '▼' : '▲') + '</button>' + html;
    }
    if (td._html !== html) { td.innerHTML = html; td._html = html; }
    td.classList.toggle('expanded', !!expanded);
  }

  /** 한 행의 계산 칸(퍼센트, 막대, 세트 가격, 범위 밖 표시, 확장 표시) 갱신 */
  function updatePriceRow(cat, tr) {
    var it = findItem(cat, tr.dataset.name);
    if (!it) return;
    var eff = rangeOf(cat, it);
    var sell = sellOf(cat, it.name), my = myOf(cat, it.name);
    var sale = C.salePrice(sell, my);
    var pct = C.rangePercent(eff.min, eff.max, sell);
    var status = C.rangeStatus(eff.min, eff.max, sell);
    tr._pct = pct;

    setRangeCell($('[data-min]', tr), eff.min, eff.expandedMin, eff.baseMin, 'min');
    setRangeCell($('[data-max]', tr), eff.max, eff.expandedMax, eff.baseMax, 'max');

    var bar = $('.bar', tr), fill = $('.bar > span', tr);
    fill.style.width = (C.isNum(pct) ? Math.max(0, Math.min(1, pct)) * 100 : 0) + '%';
    bar.classList.toggle('low', C.isNum(pct) && pct < BAR_LOW_THRESHOLD);
    bar.classList.toggle('high', C.isNum(pct) && pct > C.HIGHLIGHT_THRESHOLD);
    bar.classList.toggle('oor', status === 'below' || status === 'above');

    var pctText = $('.pct-text', tr);
    if (C.isNum(pct)) pctText.textContent = C.formatPercent(pct);
    else pctText.textContent = sell !== null && eff.min === eff.max ? '—' : '';
    pctText.title = sell !== null && eff.min === eff.max ? '최저가와 최고가가 같아 계산할 수 없습니다' : '';

    var tag = $('.oor-tag', tr);
    tag.textContent = status === 'above' ? '▲ 최고가 초과' : (status === 'below' ? '▼ 최저가 미만' : '');
    $('input[data-kind="sell"]', tr).classList.toggle('out-of-range', status === 'above' || status === 'below');

    // 나의 판매가가 비어 있으면 판매가를 흐리게 보여 줌 (그 값으로 계산된다는 뜻)
    var myInput = $('input[data-kind="my"]', tr);
    myInput.placeholder = sell !== null ? fmtInput(sell) : '입력';
    myInput.title = my === null ? '비어 있으면 판매가로 계산합니다' : '';

    var setCell = $('[data-set]', tr);
    setCell.textContent = sale === null ? '' : fmtG(C.setPrice(sale, setSize()));
    var fallback = my === null && sell !== null;
    setCell.classList.toggle('fallback', fallback);
    setCell.title = fallback ? '나의 판매가 미입력 → 판매가 기준' : '';

    // 가격 기록 개수 + 마지막 갱신 시각
    var hist = state.history[cat][it.name] || [];
    var hb = $('[data-hist]', tr);
    hb.classList.toggle('has-hist', hist.length > 0);
    $('[data-hist-n]', tr).textContent = hist.length ? hist.length : '';
    var upd = state.itemUpdatedAt[cat][it.name];
    hb.title = '가격 기록 ' + hist.length + '개' + (upd ? ' · 마지막 갱신 ' + C.formatDateTime(new Date(upd)) : '');
  }

  /** 강조 규칙 적용: 최고 % 행(노란 배경+빨간 굵은 글씨), 80% 초과(빨간 굵은 글씨) */
  function applyHighlights(cat) {
    var panel = $('#panel-' + cat);
    var trs = $$('tbody tr[data-name]', panel);
    var flags = C.highlightFlags(trs.map(function (tr) { return tr._pct; }));
    var top = null;
    trs.forEach(function (tr, i) {
      tr.classList.toggle('is-max', flags[i].isMax);
      tr.classList.toggle('is-high', flags[i].isHigh);
      if (flags[i].isMax && !top) top = tr;
    });
    var stat = $('[data-top-stat]', panel);
    if (stat) {
      stat.innerHTML = top ? '최고: <b>' + esc(top.dataset.name) + '</b> ' + C.formatPercent(top._pct) : '';
    }
  }

  /** 정렬: 토글이 켜져 있으면 % 높은 순, 아니면 원래 순서 */
  function applyOrder(cat) {
    var tbody = $('#panel-' + cat + ' tbody');
    if (!tbody) return;
    var trs = $$('tr[data-name]', tbody);
    var sortOn = state.settings.sortByPct[cat];
    trs.sort(function (a, b) {
      if (sortOn) {
        var pa = C.isNum(a._pct) ? a._pct : -Infinity;
        var pb = C.isNum(b._pct) ? b._pct : -Infinity;
        if (pa !== pb) return pb - pa;
      }
      return a.dataset.idx - b.dataset.idx;
    });
    // 이미 순서가 같으면 DOM 을 건드리지 않음 (포커스 유지)
    var same = trs.every(function (tr, i) { return tbody.children[i] === tr; });
    if (!same) trs.forEach(function (tr) { tbody.appendChild(tr); });
  }

  /** 카운트다운 + "가격이 바뀌었을 수 있음" 표시 갱신 (1초마다) */
  function updateCountdowns() {
    var now = new Date();
    C.CATEGORIES.forEach(function (cat) {
      var panel = $('#panel-' + cat);
      var t = $('[data-cd-time]', panel);
      if (!t) return;
      var next = C.nextChangeTime(now, cat);
      if (!next) { t.textContent = '일정 없음'; return; }
      t.textContent = C.formatCountdown(next.getTime() - now.getTime());
      var rule = cat === 'cooking'
        ? '매월 ' + C.COOKING_CHANGE_DAYS.join('·') + '일 ' + C.CHANGE_HOUR + '시'
        : '매일 ' + C.CHANGE_HOUR + '시 초기화';
      $('[data-cd-at]', panel).textContent = C.formatDateTime(next) + ' · ' + rule;
      updateStale(cat, now);
    });
  }

  function updateStale(cat, now) {
    var el = $('#panel-' + cat + ' [data-stale]');
    if (!el) return;
    var hasAny = Object.keys(state.sell[cat] || {}).length > 0 || Object.keys(state.my[cat] || {}).length > 0;
    var t = state.priceUpdatedAt[cat];
    var prev = C.prevChangeTime(now, cat);
    var msg = '';
    if (hasAny && t === null) msg = '⚠ 엑셀에서 가져온 예전 가격입니다 — 게임에서 확인한 판매가를 입력하세요';
    else if (hasAny && prev && t < prev.getTime()) {
      msg = '⚠ 마지막 입력(' + C.formatDateTime(new Date(t)) + ') 이후 가격이 바뀌었어요 — 새 판매가를 입력하세요';
    }
    el.hidden = !msg;
    if (el.textContent !== msg) el.textContent = msg;
  }

  /** 자동 인식 후 한 아이템 행 갱신 (입력칸 값까지 다시 채움) */
  function refreshItemRow(cat, name, syncInputs) {
    var tr = findRow(cat, name);
    if (!tr) return null;
    if (syncInputs) {
      var si = $('input[data-kind="sell"]', tr), mi = $('input[data-kind="my"]', tr);
      si.value = fmtInput(sellOf(cat, name)); si.classList.remove('invalid');
      mi.value = fmtInput(myOf(cat, name)); mi.classList.remove('invalid');
    }
    updatePriceRow(cat, tr);
    applyHighlights(cat);
    // 사용자가 이 표에서 입력 중이면 행이 움직이지 않게 재정렬은 미룸
    var tbody = tr.parentNode;
    if (!tbody.contains(document.activeElement)) applyOrder(cat);
    updateStale(cat, new Date());
    return tr;
  }

  /** 행 반짝임 (자동 인식으로 값이 바뀌었을 때) */
  function flashRow(tr) {
    if (!tr) return;
    tr.classList.remove('flash');
    void tr.offsetWidth; // 애니메이션 다시 시작
    tr.classList.add('flash');
    clearTimeout(tr._flashTimer);
    tr._flashTimer = setTimeout(function () { tr.classList.remove('flash'); }, FLASH_MS);
  }

  /* =====================================================================
   * 가격 기록 팝오버 (📈 버튼 / ▼▲ 표시 클릭)
   * ===================================================================== */

  var pop = { cat: null, name: null, anchor: null };

  function toggleHistPop(cat, name, anchor) {
    if (pop.cat === cat && pop.name === name && !$('#histPop').hidden) { closeHistPop(); return; }
    pop.cat = cat; pop.name = name; pop.anchor = anchor;
    renderHistPop();
  }

  function closeHistPop() {
    var el = $('#histPop');
    if (el) el.hidden = true;
    pop.cat = pop.name = pop.anchor = null;
  }

  /** 미니 그래프(SVG): 지난 가격들 + 현재 판매가, 점선 = 최저/최고 */
  function sparklineSvg(points, eff) {
    if (!points.length) return '';
    var vals = points.map(function (p) { return p.price; });
    var lo = Math.min.apply(null, vals.concat([eff.min]));
    var hi = Math.max.apply(null, vals.concat([eff.max]));
    if (hi === lo) { hi = lo + 1; }
    var padX = 8, padY = 8, w = SPARK_W, h = SPARK_H;
    var n = points.length;
    function x(i) { return n === 1 ? w / 2 : padX + (w - 2 * padX) * i / (n - 1); }
    function y(v) { return padY + (h - 2 * padY) * (1 - (v - lo) / (hi - lo)); }
    var line = points.map(function (p, i) { return x(i).toFixed(1) + ',' + y(p.price).toFixed(1); }).join(' ');
    var dots = points.map(function (p, i) {
      return '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(p.price).toFixed(1) + '" r="' + (p.current ? 3.6 : 2.4) + '"' +
        ' class="' + (p.current ? 'cur' : 'pt') + '"><title>' + esc(p.label + ' ' + C.formatInt(p.price) + 'G') + '</title></circle>';
    }).join('');
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" role="img" aria-label="가격 변화 그래프">' +
      '<line class="lim" x1="0" x2="' + w + '" y1="' + y(eff.max).toFixed(1) + '" y2="' + y(eff.max).toFixed(1) + '"/>' +
      '<line class="lim" x1="0" x2="' + w + '" y1="' + y(eff.min).toFixed(1) + '" y2="' + y(eff.min).toFixed(1) + '"/>' +
      '<text class="lim-t" x="' + (w - 2) + '" y="' + (y(eff.max) - 2).toFixed(1) + '">최고</text>' +
      '<text class="lim-t" x="' + (w - 2) + '" y="' + (y(eff.min) + 9).toFixed(1) + '">최저</text>' +
      (n > 1 ? '<polyline class="ln" points="' + line + '"/>' : '') + dots + '</svg>';
  }

  function renderHistPop() {
    var el = $('#histPop');
    var cat = pop.cat, name = pop.name;
    var it = cat ? findItem(cat, name) : null;
    if (!it) { closeHistPop(); return; }
    var eff = rangeOf(cat, it);
    var list = (state.history[cat][name] || []).slice();
    var sell = sellOf(cat, name);
    var upd = state.itemUpdatedAt[cat][name];
    var points = list.map(function (e) {
      var d = R.inferHistoryDate(e.day, e.seenAt);
      return { price: e.price, label: d ? d.m + '/' + d.d : e.day + '일', current: false };
    });
    if (sell !== null) points.push({ price: sell, label: '현재', current: true });
    var expanded = eff.expandedMin || eff.expandedMax;

    var rows = points.slice().reverse().map(function (p) {
      var pct = C.rangePercent(eff.min, eff.max, p.price);
      return '<tr' + (p.current ? ' class="cur"' : '') + '><td>' + esc(p.label) + '</td>' +
        '<td class="num">' + fmtG(p.price) + '</td><td class="num muted">' + (C.isNum(pct) ? C.formatPercent(pct) : '') + '</td></tr>';
    }).join('');

    el.innerHTML =
      '<div class="pop-head"><b>' + CAT_ICON[cat] + ' ' + esc(name) + '</b>' +
        '<button type="button" class="pop-x" data-pop-close aria-label="닫기">✕</button></div>' +
      '<div class="pop-range">범위 <b>' + fmtG(eff.min) + ' ~ ' + fmtG(eff.max) + '</b>' +
        (expanded ? ' <span class="muted">(원래 ' + fmtG(eff.baseMin) + ' ~ ' + fmtG(eff.baseMax) + ')</span>' : '') + '</div>' +
      (expanded ? '<div class="pop-exp"><span class="tag exp">자동 확장됨</span>' +
        '<button type="button" class="btn small" data-pop-reset>범위 원래대로</button></div>' : '') +
      (points.length
        ? sparklineSvg(points, eff) +
          '<div class="pop-list"><table class="mini"><thead><tr><th>날짜</th><th class="num">판매가</th><th class="num">위치</th></tr></thead>' +
          '<tbody>' + rows + '</tbody></table></div>'
        : '<div class="empty small">아직 가격 기록이 없습니다.<br>게임에서 아이템 툴팁을 인식하면 지난 가격이 자동으로 쌓입니다.</div>') +
      '<div class="pop-foot muted">' + (upd ? '마지막 갱신 ' + C.formatDateTime(new Date(upd)) : '갱신 기록 없음') +
        ' · 기록 ' + list.length + '개 (최대 ' + R.HISTORY_MAX + ')</div>';
    el.hidden = false;
    positionHistPop();
  }

  function positionHistPop() {
    var el = $('#histPop');
    var a = pop.anchor;
    if (el.hidden) return;
    // 표가 다시 그려져 버튼이 바뀌었으면 새 버튼 기준으로
    if (!a || !document.body.contains(a)) {
      var tr = findRow(pop.cat, pop.name);
      a = pop.anchor = tr ? $('[data-hist]', tr) : null;
    }
    if (!a) { closeHistPop(); return; }
    var r = a.getBoundingClientRect();
    var w = el.offsetWidth, h = el.offsetHeight;
    var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function resetRange(cat, name) {
    if (!has(state.rangeOverride[cat], name)) return;
    delete state.rangeOverride[cat][name];
    persist();
    refreshItemRow(cat, name, false);
    renderSettingsPanel();
    scheduleKnownItems();
    if (pop.cat === cat && pop.name === name) renderHistPop();
    toast('"' + name + '" 범위를 원래대로 되돌렸습니다.');
  }

  function countExpanded() {
    var n = 0;
    C.CATEGORIES.forEach(function (cat) {
      Object.keys(state.rangeOverride[cat]).forEach(function (name) { if (findItem(cat, name)) n++; });
    });
    return n;
  }

  /* =====================================================================
   * 보유 재료 탭
   * ===================================================================== */

  function renderInventoryPanel() {
    var panel = $('#panel-inventory');
    var recipes = itemsOf('cooking');
    var ings = C.uniqueIngredients(recipes);
    var usedBy = {};
    recipes.forEach(function (r) {
      (r.ingredients || []).forEach(function (g) { (usedBy[g.name] = usedBy[g.name] || []).push(r.name); });
    });

    var groupsHtml = C.INGREDIENT_GROUPS.map(function (g) {
      var list = ings.filter(function (n) { return C.ingredientGroup(n) === g; });
      if (!list.length) return '';
      return '<div class="card"><h3>' + esc(g) + ' <small>' + list.length + '종</small></h3>' +
        '<div class="inv-row head"><span>재료</span><span>보유 수량</span><span>개당 비용</span></div>' +
        list.map(function (name) {
          var haveN = state.inventory[name], cost = state.costs[name];
          return '<div class="inv-row' + (haveN > 0 ? ' has-stock' : '') + '" data-ing="' + esc(name) + '">' +
            '<span class="ing-name" title="사용 요리: ' + esc(usedBy[name].join(', ')) + '">' + esc(name) +
            '<small>' + usedBy[name].length + '</small></span>' +
            '<input class="field numeric" data-kind="inv" inputmode="numeric" autocomplete="off" placeholder="0" value="' +
            esc(C.isNum(haveN) && haveN > 0 ? fmtInput(haveN) : '') + '" aria-label="' + esc(name) + ' 보유 수량">' +
            '<input class="field numeric" data-kind="cost" inputmode="decimal" autocomplete="off" placeholder="0" value="' +
            esc(C.isNum(cost) && cost > 0 ? fmtInput(cost) : '') + '" aria-label="' + esc(name) + ' 개당 비용">' +
            '</div>';
        }).join('') + '</div>';
    }).join('');
    if (!ings.length) groupsHtml = '<div class="card empty">요리 재료가 없습니다. ⚙️ 설정에서 요리 재료를 입력하세요.</div>';

    panel.innerHTML =
      '<div class="panel-head">' +
        '<span class="hint">보유 수량을 입력하면 요리별 제작 가능 수와 <b>총 이익이 가장 큰 조합</b>을 계산합니다. ' +
        '개당 비용은 선택 사항(재료를 사서 쓰는 경우) · 판매 단가는 🍳 요리 탭의 <b>나의 판매가</b>(비어 있으면 판매가)를 사용합니다.</span>' +
        '<div class="spacer"></div>' +
        '<button class="btn" data-clear-cost>비용 전체 비우기</button>' +
        '<button class="btn danger" data-clear-inv>보유 재료 전체 비우기</button>' +
      '</div>' +
      '<div class="inv-layout">' +
        '<div class="inv-groups">' + groupsHtml + '</div>' +
        '<div class="inv-right">' +
          '<div class="card" id="optCard"></div>' +
          '<div class="card"><h3>요리별 제작 가능 <small>각 요리를 단독으로 만들 때</small></h3>' +
            '<div class="table-wrap"><table class="grid" id="dishTable"></table></div></div>' +
        '</div>' +
      '</div>';

    var groups = $('.inv-groups', panel);
    groups.addEventListener('input', function (e) {
      var inp = e.target;
      if (!inp.dataset.kind) return;
      var name = inp.closest('.inv-row').dataset.ing;
      var v = C.parseNumber(inp.value);
      var isInv = inp.dataset.kind === 'inv';
      var bad = v !== null && (!C.isNum(v) || v < 0 || (isInv && !Number.isInteger(v)));
      inp.classList.toggle('invalid', bad);
      inp.title = bad ? (isInv ? '0 이상의 정수를 입력하세요' : '0 이상의 숫자를 입력하세요') : '';
      if (bad) return;
      var map = isInv ? state.inventory : state.costs;
      if (v === null || v === 0) delete map[name]; else map[name] = v;
      if (isInv) inp.closest('.inv-row').classList.toggle('has-stock', v > 0);
      persist();
      scheduleOptimize();
    });
    groups.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || !e.target.dataset.kind) return;
      e.preventDefault();
      var inputs = $$('input[data-kind="' + e.target.dataset.kind + '"]', groups);
      var next = inputs[inputs.indexOf(e.target) + 1];
      if (next) { next.focus(); next.select(); }
    });
    groups.addEventListener('focusin', function (e) { if (e.target.dataset.kind) e.target.select(); });
    groups.addEventListener('focusout', function (e) {
      if (!e.target.dataset.kind) return;
      var v = C.parseNumber(e.target.value);
      if (C.isNum(v)) e.target.value = v === 0 ? '' : fmtInput(v);
    });
    $('[data-clear-inv]', panel).addEventListener('click', function () {
      confirmDialog('보유 재료 전체 비우기', '입력한 보유 수량을 모두 지울까요?', '모두 비우기', true).then(function (ok) {
        if (!ok) return;
        state.inventory = {};
        persist();
        renderInventoryPanel();
        toast('보유 재료를 모두 비웠습니다.');
      });
    });
    $('[data-clear-cost]', panel).addEventListener('click', function () {
      confirmDialog('비용 전체 비우기', '입력한 재료 개당 비용을 모두 지울까요?', '모두 비우기', true).then(function (ok) {
        if (!ok) return;
        state.costs = {};
        persist();
        renderInventoryPanel();
      });
    });
    optDirty = true;
    if (state.settings.activeTab === 'inventory') runOptimize();
  }

  function scheduleOptimize() {
    optDirty = true;
    if (state.settings.activeTab !== 'inventory') return;
    clearTimeout(optTimer);
    optTimer = setTimeout(runOptimize, OPTIMIZE_DEBOUNCE_MS);
  }

  /** 최적 조합 계산 + 결과 표시 (판매 단가 = 나의 판매가, 없으면 판매가) */
  function runOptimize() {
    optDirty = false;
    var card = $('#optCard'), table = $('#dishTable');
    if (!card || !table) return;
    var recipes = itemsOf('cooking');
    var prices = C.salePriceMap(recipes, state.sell.cooking, state.my.cooking);
    var inv = state.inventory, costs = state.costs;
    var res = C.optimizeProduction(recipes, prices, inv, costs);
    var hasInv = Object.keys(inv).some(function (k) { return inv[k] > 0; });
    var hasCost = Object.keys(costs).some(function (k) { return costs[k] > 0; });

    // ── (a) 요리별 단독 제작 표 ──
    var rows = recipes.map(function (r) {
      var price = prices[r.name];
      var fromSell = price !== null && myOf('cooking', r.name) === null;
      var uc = C.unitIngredientCost(r, costs);
      var up = C.unitProfit(r, price, costs);
      var maxN = C.maxCraftable(r, inv);
      // 병목 재료: 제작 수를 가장 많이 제한하는 재료
      var neck = '';
      if ((r.ingredients || []).length) {
        var worst = Infinity;
        r.ingredients.forEach(function (g) {
          var n = Math.floor((inv[g.name] || 0) / g.qty);
          if (n < worst) { worst = n; neck = g.name; }
        });
      }
      var noPrice = price === null;
      // 비용을 하나도 입력하지 않았으면 재료비/개당 이익 칸을 숨기고 매출(=이익)만 표시 (표 폭 절약)
      return '<tr>' +
        '<td class="name">' + esc(r.name) + '</td>' +
        '<td class="num' + (fromSell ? ' fallback' : '') + '"' + (fromSell ? ' title="나의 판매가 미입력 → 판매가 사용"' : '') + '>' +
          (noPrice ? '<span class="muted">미입력</span>' : fmtG(price)) + '</td>' +
        (hasCost
          ? '<td class="num muted">' + (uc ? fmtG(uc) : '0G') + '</td>' +
            '<td class="num ' + (up === null ? '' : signClass(up)) + '">' + (up === null ? '' : fmtG(up)) + '</td>'
          : '') +
        '<td class="num"><b>' + C.formatInt(maxN) + '</b></td>' +
        (hasCost
          ? '<td class="num ' + (up === null ? '' : signClass(maxN * up)) + '">' + (up === null ? '' : fmtG(maxN * up)) + '</td>'
          : '<td class="num">' + (noPrice ? '' : fmtG(maxN * price)) + '</td>') +
        '<td>' + (neck && hasInv ? '<span class="chip">' + esc(neck) + '</span>' : '') + '</td>' +
        '</tr>';
    }).join('');
    table.innerHTML = '<thead><tr><th>요리</th><th class="num" title="나의 판매가 (비어 있으면 판매가, 흐린 글씨)">판매 단가</th>' +
      (hasCost ? '<th class="num">재료비/개</th><th class="num">이익/개</th>' : '') +
      '<th class="num">최대 제작</th><th class="num">' + (hasCost ? '이익' : '매출') + '</th><th>병목 재료</th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="7" class="empty">요리가 없습니다.</td></tr>') + '</tbody>';

    // ── (b) 최적 조합 ──
    var head = '<h3>최적 조합 <small>공유 재료를 나눠 쓸 때 총 이익이 가장 큰 제작 수</small></h3>';
    if (!hasInv) {
      card.innerHTML = head + '<div class="empty">왼쪽에 보유 재료 수량을 입력하면 최적 조합을 계산합니다.</div>';
      return;
    }
    var status = res.optimal
      ? '<span class="badge ok">✓ 최적해</span>' +
        (res.nodes ? '<span class="muted">분기한정 ' + res.nodes + '노드 · ' + res.elapsedMs + 'ms</span>' : '')
      : '<span class="badge warn">⚠ 최적 증명 실패</span><span class="muted">계산 제한(노드/시간)에 걸려 지금까지 찾은 최선의 조합입니다. ' +
        '이론상 최대 ' + fmtG(Math.max(0, res.upperBound - res.totalProfit)) + ' 더 나은 조합이 있을 수 있습니다.</span>';
    var made = res.perRecipe.filter(function (p) { return p.count > 0; });
    var madeRows = made.map(function (p) {
      return '<tr><td class="name">' + esc(p.name) + '</td>' +
        '<td class="num"><b>' + C.formatInt(p.count) + '</b></td>' +
        '<td class="num muted">' + fmtSets(p.count) + '</td>' +
        '<td class="num">' + fmtG(p.revenue) + '</td>' +
        '<td class="num ' + signClass(p.profit) + '">' + fmtG(p.profit) + '</td></tr>';
    }).join('');
    var totalCount = made.reduce(function (s, p) { return s + p.count; }, 0);
    var leftKeys = Object.keys(res.leftoverInventory).filter(function (k) { return res.leftoverInventory[k] > 0; });
    var leftover = leftKeys.length
      ? '<div class="chips">' + leftKeys.map(function (k) {
          return '<span class="chip">' + esc(k) + ' <b>' + C.formatInt(res.leftoverInventory[k]) + '</b></span>';
        }).join('') + '</div>'
      : '<div class="muted">남는 재료가 없습니다.</div>';
    var excluded = res.excluded.length
      ? '<div class="excluded">계산에서 제외: ' + res.excluded.map(function (e) {
          return esc(e.name) + ' (' + (REASON_LABEL[e.reason] || e.reason) + ')';
        }).join(', ') + '</div>'
      : '';

    card.innerHTML = head +
      '<div class="opt-status">' + status + '</div>' +
      '<div class="opt-summary">' +
        '<div class="stat"><div class="label">총 매출</div><div class="value">' + fmtG(res.totalRevenue) + '</div></div>' +
        '<div class="stat"><div class="label">총 재료비</div><div class="value">' + fmtG(res.totalCost) + '</div></div>' +
        '<div class="stat profit"><div class="label">총 이익</div><div class="value">' + fmtG(res.totalProfit) + '</div></div>' +
      '</div>' +
      (made.length
        ? '<div class="table-wrap"><table class="grid"><thead><tr><th>요리</th><th class="num">제작 수</th>' +
          '<th class="num">세트 환산 (×' + setSize() + ')</th><th class="num">매출</th><th class="num">이익</th></tr></thead>' +
          '<tbody>' + madeRows + '</tbody><tfoot><tr><td>합계</td><td class="num">' + C.formatInt(totalCount) + '</td><td></td>' +
          '<td class="num">' + fmtG(res.totalRevenue) + '</td><td class="num ' + signClass(res.totalProfit) + '">' + fmtG(res.totalProfit) + '</td></tr></tfoot></table></div>'
        : '<div class="empty">지금 재료로 이익이 나는 요리를 만들 수 없습니다.</div>') +
      '<div class="subhead">남는 재료</div>' + leftover + excluded;
  }

  /* =====================================================================
   * 설정 탭
   * ===================================================================== */

  function masterRowHtml(it) {
    var isCook = it.category === 'cooking';
    var eff = rangeOf(it.category, it);
    var note = (eff.expandedMin || eff.expandedMax)
      ? '<div class="row-note">자동 확장됨: ' + C.formatInt(eff.min) + ' ~ ' + C.formatInt(eff.max) +
        ' <button type="button" class="link-btn" data-reset-one>원래대로</button></div>'
      : '';
    return '<tr data-cat="' + it.category + '" data-name="' + esc(it.name) + '">' +
      '<td class="w-name"><input class="field" data-f="name" value="' + esc(it.name) + '" aria-label="이름">' +
        '<div class="row-err" hidden></div>' + note + '</td>' +
      '<td class="w-num"><input class="field" data-f="min" inputmode="numeric" value="' + esc(fmtInput(it.min)) + '" aria-label="최저가"></td>' +
      '<td class="w-num"><input class="field" data-f="max" inputmode="numeric" value="' + esc(fmtInput(it.max)) + '" aria-label="최고가"></td>' +
      (isCook ? '<td><input class="field" data-f="ings" value="' + esc(C.formatIngredients(it.ingredients)) + '"' +
        ' placeholder="예: 토마토 베이스 2개 + 비트 묶음 1개" aria-label="재료"></td>' : '') +
      '<td class="w-act"><button class="btn small danger" data-del title="삭제" aria-label="삭제">✕</button></td>' +
      '</tr>';
  }

  function masterCardHtml(cat) {
    var items = itemsOf(cat);
    var isCook = cat === 'cooking';
    return '<div class="card" data-master="' + cat + '">' +
      '<h3>' + CAT_ICON[cat] + ' ' + CAT_LABEL[cat] + ' 목록 <small>' + items.length + '개 · 칸을 벗어나면 저장됩니다 · ' +
        '최저/최고는 원래 값 (자동 확장은 따로 보관)</small></h3>' +
      '<div class="table-wrap"><table class="grid master-table"><thead><tr>' +
        '<th>이름</th><th class="num">최저가</th><th class="num">최고가</th>' +
        (isCook ? '<th>재료 ("이름 N개" 를 " + " 로 연결)</th>' : '') + '<th></th>' +
      '</tr></thead><tbody>' + items.map(masterRowHtml).join('') + '</tbody></table></div>' +
      '<div class="btn-row" style="margin-top:10px"><button class="btn" data-add="' + cat + '">+ ' + CAT_LABEL[cat] + ' 추가</button></div>' +
      '</div>';
  }

  function recogCardHtml() {
    var hotkeyOk = !!pyApi('set_hotkey');
    var nExp = countExpanded();
    return '<div class="card" id="recogCard"><h3>🎥 자동 인식</h3>' +
      '<div class="form-row"><label>범위 자동 확장</label>' +
        '<label class="switch"><input type="checkbox" id="autoExpandToggle"' + (state.settings.autoExpandRange ? ' checked' : '') + '> 켜기</label></div>' +
      '<p class="hint tight">인식한 판매가나 지난 가격이 최저~최고 밖이면 범위를 넓힙니다. 원래 값은 그대로 두고 따로 보관하며, 표에 <b class="exp-legend">▼▲</b> 로 표시됩니다.</p>' +
      '<div class="form-row"><label>확장된 항목</label><span><b>' + nExp + '</b>개</span>' +
        '<button class="btn small" id="resetAllRanges"' + (nExp ? '' : ' disabled') + '>범위 전체 원래대로</button></div>' +
      '<div class="form-row"><label for="hotkeyInput">지금 읽기 단축키</label>' +
        '<input class="field hotkey" id="hotkeyInput" value="' + esc(state.settings.hotkey) + '" autocomplete="off" spellcheck="false" ' +
        'title="칸을 누른 뒤 원하는 키 조합을 누르세요 (예: Ctrl+Shift+R)" aria-label="지금 읽기 단축키">' +
        '<button class="btn small" id="hotkeyApply">적용</button>' +
        '<span class="hk-msg" id="hotkeyMsg">' + (hotkeyOk ? '' : 'exe에서만 사용 가능') + '</span></div>' +
      '<p class="hint tight">자동 인식(화면 읽기)은 exe 에서만 동작합니다. 브라우저에서는 수동 입력만 가능합니다.</p>' +
      '</div>';
  }

  function renderSettingsPanel() {
    var panel = $('#panel-settings');
    var backend = demoMode ? '데모 모드 (저장 안 함)' : (ST.backend() === 'pywebview' ? '프로그램 저장 파일' : '브라우저 저장소(localStorage)');
    panel.innerHTML =
      '<div class="settings-layout">' +
        '<div class="settings-top">' +
          '<div class="card"><h3>일반</h3>' +
            '<div class="form-row"><label for="setSizeInput">세트 크기</label>' +
              '<input class="field numeric" id="setSizeInput" inputmode="numeric" style="width:90px" value="' + setSize() + '">' +
              '<span class="hint">세트 판매액 = 나의 판매가 × 세트 크기 (기본 64)</span></div>' +
            '<div class="form-row"><label for="themeSelect">테마</label>' +
              '<select class="field" id="themeSelect"><option value="dark">어두운 테마</option><option value="light">밝은 테마</option></select></div>' +
            '<div class="form-row"><label>저장 위치</label><span class="muted">' + backend + ' · 자동 저장</span></div>' +
          '</div>' +
          recogCardHtml() +
          '<div class="card"><h3>공유 · 백업</h3>' +
            '<p class="hint" style="margin-top:0">항목 이름·최저가·최고가·재료(마스터 데이터)를 JSON 파일로 친구와 주고받을 수 있어요. ' +
              '가격·보유 재료·가격 기록은 포함되지 않습니다.</p>' +
            '<div class="btn-row">' +
              '<button class="btn primary" id="exportBtn">JSON 내보내기</button>' +
              '<button class="btn" id="importBtn">JSON 가져오기</button>' +
              '<button class="btn" id="copyBtn">클립보드에 복사</button>' +
              '<input type="file" id="importFile" accept=".json,application/json" hidden>' +
            '</div>' +
            '<details class="paste"><summary>JSON 텍스트를 붙여넣어 가져오기</summary>' +
              '<textarea class="field" id="pasteArea" placeholder="{ &quot;items&quot;: [ ... ] }"></textarea>' +
              '<button class="btn" id="pasteImportBtn">붙여넣은 내용 가져오기</button></details>' +
            '<div class="btn-row" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">' +
              '<button class="btn" id="restoreBtn">기본값으로 복원</button>' +
              '<button class="btn danger" id="resetAllBtn">모든 데이터 초기화</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        masterCardHtml('cooking') +
        masterCardHtml('craft') +
      '</div>';

    applyTheme();

    $('#setSizeInput').addEventListener('change', function (e) {
      var v = C.parseNumber(e.target.value);
      if (!C.isNum(v) || v < 1 || v > S.MAX_SET_SIZE || !Number.isInteger(v)) {
        e.target.classList.add('invalid');
        toast('세트 크기는 1 ~ ' + S.MAX_SET_SIZE + ' 사이의 정수여야 합니다.');
        return;
      }
      e.target.classList.remove('invalid');
      state.settings.setSize = v;
      persist();
      renderPricePanel('cooking');
      renderPricePanel('craft');
      optDirty = true;
      toast('세트 크기를 ' + v + '(으)로 변경했습니다.');
    });
    $('#themeSelect').addEventListener('change', function (e) {
      state.settings.theme = e.target.value;
      applyTheme();
      persist();
    });
    bindRecogCard();
    $('#exportBtn').addEventListener('click', exportJson);
    $('#copyBtn').addEventListener('click', copyJson);
    $('#importBtn').addEventListener('click', function () {
      // exe(pywebview)에서는 파이썬 열기 대화상자 사용, 브라우저에서는 <input type=file>
      var openDialog = ST.openFileDialogFn();
      if (openDialog) {
        Promise.resolve(openDialog()).then(function (text) {
          if (typeof text === 'string') importJsonText(text); // null = 취소
        }).catch(function (e) { alertDialog('가져오기 실패', String(e)); });
        return;
      }
      $('#importFile').click();
    });
    $('#importFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { importJsonText(String(reader.result || '')); };
      reader.onerror = function () { alertDialog('가져오기 실패', '파일을 읽을 수 없습니다.'); };
      reader.readAsText(f, 'utf-8');
    });
    $('#pasteImportBtn').addEventListener('click', function () { importJsonText($('#pasteArea').value); });
    $('#restoreBtn').addEventListener('click', function () {
      confirmDialog('기본값으로 복원', '요리/공예품 목록(이름·최저가·최고가·재료)과 세트 크기를 처음 엑셀 값으로 되돌릴까요?\n' +
        '가격과 보유 재료는 유지됩니다.', '복원', true).then(function (ok) {
        if (!ok) return;
        state.master = null;
        state.settings.setSize = S.DEFAULT_SET_SIZE;
        pruneItemData();
        persist();
        renderAll();
        scheduleKnownItems();
        toast('기본값으로 복원했습니다.');
      });
    });
    $('#resetAllBtn').addEventListener('click', function () {
      confirmDialog('모든 데이터 초기화', '가격, 가격 기록, 자동 확장 범위, 보유 재료, 비용, 편집한 목록, 설정을 모두 지우고 처음 상태로 되돌릴까요?\n' +
        '(테마와 자동 인식 켜짐·단축키 설정은 유지)\n되돌릴 수 없습니다.', '초기화', true)
        .then(function (ok) {
          if (!ok) return;
          var keep = state.settings;
          state = S.createDefaultState(DD);
          state.settings.theme = keep.theme;
          state.settings.autoCapture = keep.autoCapture;
          state.settings.hotkey = keep.hotkey;
          state.settings.activeTab = 'settings';
          persist();
          renderAll();
          scheduleKnownItems();
          toast('모든 데이터를 초기화했습니다.');
        });
    });

    // ── 마스터 데이터 편집 ──
    $$('[data-master]', panel).forEach(function (card) {
      var cat = card.dataset.master;
      var tbody = $('tbody', card);
      tbody.addEventListener('change', function (e) {
        if (e.target.dataset.f) commitMasterRow(e.target.closest('tr'));
      });
      tbody.addEventListener('click', function (e) {
        var rb = e.target.closest('[data-reset-one]');
        if (rb) { resetRange(cat, rb.closest('tr').dataset.name); return; }
        var btn = e.target.closest('[data-del]');
        if (!btn) return;
        var tr = btn.closest('tr');
        var name = tr.dataset.name;
        confirmDialog('항목 삭제', '"' + name + '" 을(를) ' + CAT_LABEL[cat] + ' 목록에서 삭제할까요?\n(가격·가격 기록도 함께 지워집니다)', '삭제', true).then(function (ok) {
          if (!ok) return;
          var m = ensureMasterCopy();
          m.items = m.items.filter(function (i) { return !(i.category === cat && i.name === name); });
          deleteItemData(cat, name);
          persist();
          renderAll();
          scheduleKnownItems();
          toast('삭제했습니다.');
        });
      });
      $('[data-add]', card).addEventListener('click', function () {
        var m = ensureMasterCopy();
        var base = '새 ' + CAT_LABEL[cat], name = base, k = 2;
        while (findItem(cat, name)) name = base + ' ' + k++;
        m.items.push({ category: cat, name: name, min: 0, max: 1000, ingredients: [] });
        persist();
        renderAll();
        scheduleKnownItems();
        var rows = $$('[data-master="' + cat + '"] tbody tr');
        var inp = rows.length ? $('input[data-f="name"]', rows[rows.length - 1]) : null;
        if (inp) { inp.focus(); inp.select(); }
      });
    });
  }

  /** 설정 탭 "🎥 자동 인식" 카드 이벤트 */
  function bindRecogCard() {
    $('#autoExpandToggle').addEventListener('change', function (e) {
      state.settings.autoExpandRange = e.target.checked;
      persist();
      toast('범위 자동 확장을 ' + (e.target.checked ? '켰습니다.' : '껐습니다. (이미 확장된 범위는 유지)'));
    });
    $('#resetAllRanges').addEventListener('click', function () {
      confirmDialog('범위 전체 원래대로', '자동으로 넓어진 최저가/최고가를 모두 원래 값으로 되돌릴까요?\n(가격 기록은 유지됩니다)', '되돌리기', true)
        .then(function (ok) {
          if (!ok) return;
          state.rangeOverride = { cooking: {}, craft: {} };
          persist();
          renderPricePanel('cooking');
          renderPricePanel('craft');
          renderSettingsPanel();
          scheduleKnownItems();
          if (pop.cat) renderHistPop();
          toast('모든 범위를 원래대로 되돌렸습니다.');
        });
    });
    var hk = $('#hotkeyInput');
    // 칸에서 키 조합을 누르면 "Ctrl+Shift+R" 형태로 기록 (Tab 은 그대로 이동, 수정키 없이 Backspace = 지우기)
    hk.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') return;
      e.preventDefault();
      if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) { applyHotkey(); return; }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) { hk.value = ''; return; }
      var spec = hotkeyFromEvent(e);
      if (spec) hk.value = spec;
    });
    $('#hotkeyApply').addEventListener('click', applyHotkey);
  }

  // 단축키 이름 변환표 (KeyboardEvent.key → 표시 이름)
  var KEY_NAMES = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc' };

  /** 키 이벤트 → "Ctrl+Shift+R" (수정키만 눌렀으면 null) */
  function hotkeyFromEvent(e) {
    if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].indexOf(e.key) >= 0) return null;
    var parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Win');
    var k = KEY_NAMES[e.key] || e.key;
    // 영문/숫자는 물리 키 기준 (한글 입력 상태에서도 R 로 기록되게)
    if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
    else if (/^Digit[0-9]$/.test(e.code)) k = e.code.slice(5);
    else if (k.length === 1) k = k.toUpperCase();
    parts.push(k);
    return parts.join('+');
  }

  function setHotkeyMsg(text, isErr) {
    var el = $('#hotkeyMsg');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('err', !!isErr);
    el.classList.toggle('ok', !isErr && !!text);
  }

  /** 파이썬 set_hotkey 결과 해석: true / {ok:true} = 성공, false / {ok:false, error} / 문자열 = 실패 */
  function hotkeyError(res) {
    if (res === false) return '단축키를 등록할 수 없습니다';
    if (typeof res === 'string' && res) return res;
    if (res && typeof res === 'object' && res.ok === false) return res.error || '단축키를 등록할 수 없습니다';
    return null;
  }

  function applyHotkey() {
    var spec = $('#hotkeyInput').value.trim();
    if (!spec) { setHotkeyMsg('단축키를 입력하세요', true); return; }
    if (!/[+]/.test(spec) && !/^F([1-9]|1[0-9]|2[0-4])$/i.test(spec)) {
      setHotkeyMsg('Ctrl/Alt/Shift 와 함께 누르세요 (F1~F24 는 단독 가능)', true);
      return;
    }
    var prev = state.settings.hotkey;
    if (!pyApi('set_hotkey')) {
      state.settings.hotkey = spec;
      persist();
      setHotkeyMsg('저장됨 (exe에서만 동작)', false);
      return;
    }
    setHotkeyMsg('적용 중…', false);
    callPy('set_hotkey', [spec]).then(function (res) {
      var err = hotkeyError(res);
      if (err) { setHotkeyMsg(err, true); return; }
      state.settings.hotkey = spec;
      persist();
      setHotkeyMsg('적용됨: ' + spec, false);
    }, function (e) {
      setHotkeyMsg('오류: ' + String(e && e.message || e), true);
      state.settings.hotkey = prev;
    });
  }

  /** 설정 표의 한 행을 검증하고 마스터 데이터에 반영 */
  function commitMasterRow(tr) {
    var cat = tr.dataset.cat, oldName = tr.dataset.name;
    var f = function (k) { return $('input[data-f="' + k + '"]', tr); };
    var errs = [];
    $$('input', tr).forEach(function (i) { i.classList.remove('invalid'); });
    var name = f('name').value.trim();
    if (!name) { errs.push('이름을 입력하세요'); f('name').classList.add('invalid'); }
    else if (name.length > S.MAX_NAME_LEN) { errs.push('이름이 너무 깁니다'); f('name').classList.add('invalid'); }
    else if (name !== oldName && findItem(cat, name)) { errs.push('같은 이름이 이미 있습니다'); f('name').classList.add('invalid'); }
    var min = C.parseNumber(f('min').value), max = C.parseNumber(f('max').value);
    if (!C.isNum(min) || min < 0) { errs.push('최저가는 0 이상의 숫자'); f('min').classList.add('invalid'); }
    if (!C.isNum(max) || max < 0) { errs.push('최고가는 0 이상의 숫자'); f('max').classList.add('invalid'); }
    if (C.isNum(min) && C.isNum(max) && min > max) {
      errs.push('최저가가 최고가보다 큽니다'); f('min').classList.add('invalid'); f('max').classList.add('invalid');
    }
    var ings = [];
    if (cat === 'cooking') {
      try { ings = C.parseIngredients(f('ings').value); } catch (ex) { errs.push(ex.message); f('ings').classList.add('invalid'); }
    }
    var errEl = $('.row-err', tr);
    if (errs.length) {
      errEl.textContent = errs.join(' · ');
      errEl.hidden = false;
      return;
    }
    errEl.hidden = true;
    ensureMasterCopy();
    var it = findItem(cat, oldName);
    if (!it) return;
    var rangeEdited = it.min !== min || it.max !== max;
    it.name = name; it.min = min; it.max = max;
    if (cat === 'cooking') it.ingredients = ings;
    if (name !== oldName) renameItemData(cat, oldName, name);
    // 사용자가 최저/최고를 직접 고쳤으면 자동 확장 값은 버림 (사용자 값이 우선)
    if (rangeEdited && has(state.rangeOverride[cat], name)) {
      delete state.rangeOverride[cat][name];
      var note = $('.row-note', tr);
      if (note) note.remove();
    }
    tr.dataset.name = name;
    f('min').value = fmtInput(min);
    f('max').value = fmtInput(max);
    if (cat === 'cooking') f('ings').value = C.formatIngredients(ings);
    persist();
    scheduleKnownItems();
    // 설정 탭은 그대로 두고(포커스 유지) 다른 탭만 다시 그림
    renderPricePanel(cat);
    if (cat === 'cooking') renderInventoryPanel();
  }

  /* ── 내보내기 / 가져오기 ── */

  function exportPayload() {
    return JSON.stringify(S.buildExport(master(), setSize()), null, 2);
  }

  // 내보내기 파일 기본 이름 앞부분 (뒤에 _YYYYMMDD.json 이 붙음). 파일 이름이라 띄어쓰기 없이 씀
  var EXPORT_FILE_PREFIX = '띵에이전트_목록';

  function exportFileName() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return EXPORT_FILE_PREFIX + '_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.json';
  }

  function exportJson() {
    var json = exportPayload(), name = exportFileName();
    // exe(pywebview)에서는 저장 대화상자 사용 (브라우저식 다운로드가 막혀 있을 수 있음)
    var saveDialog = ST.saveFileDialogFn();
    if (saveDialog) {
      Promise.resolve(saveDialog(name, json)).then(function (path) {
        if (path) toast('저장했습니다: ' + path);
      }).catch(function (e) { alertDialog('내보내기 실패', String(e)); });
      return;
    }
    try {
      var blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
      toast('JSON 파일을 내보냈습니다: ' + name);
    } catch (e) {
      alertDialog('내보내기 실패', '파일로 저장할 수 없습니다. "클립보드에 복사"를 사용하세요.');
    }
  }

  function copyJson() {
    var json = exportPayload();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = json; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      if (ok) toast('클립보드에 복사했습니다.');
      else alertDialog('복사 실패', '클립보드에 접근할 수 없습니다.');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(function () { toast('클립보드에 복사했습니다.'); }, fallback);
    } else fallback();
  }

  function importJsonText(text) {
    var obj;
    try { obj = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) {
      alertDialog('가져오기 실패', '올바른 JSON 형식이 아닙니다.');
      return;
    }
    // 새 식별자(DdingAgent)와 옛 이름 시절 식별자(DdingTycoonCalc) 모두 허용, app 필드 없는 파일도 허용
    if (obj && !S.isAcceptedExportAppId(obj.app)) {
      alertDialog('가져오기 실패', '이 앱에서 내보낸 파일이 아닙니다.');
      return;
    }
    var v = S.validateMaster(obj);
    if (!v.ok) {
      var shown = v.errors.slice(0, MAX_IMPORT_ERRORS_SHOWN);
      if (v.errors.length > shown.length) shown.push('… 외 ' + (v.errors.length - shown.length) + '개');
      alertDialog('가져오기 실패', shown.join('\n'));
      return;
    }
    var nCook = v.master.items.filter(function (i) { return i.category === 'cooking'; }).length;
    var nCraft = v.master.items.length - nCook;
    confirmDialog('목록 가져오기', '요리 ' + nCook + '개, 공예품 ' + nCraft + '개로 목록을 교체할까요?' +
      (v.setSize ? '\n세트 크기: ' + v.setSize : '') + '\n이름이 같은 항목의 가격·기록은 유지됩니다.', '가져오기')
      .then(function (ok) {
        if (!ok) return;
        state.master = v.master;
        if (v.setSize) state.settings.setSize = v.setSize;
        // 목록에서 사라진 항목의 가격/기록/확장 범위 정리
        pruneItemData();
        persist();
        renderAll();
        scheduleKnownItems();
        toast('목록을 가져왔습니다.');
      });
  }

  /* =====================================================================
   * 자동 인식 — 파이썬 API 호출 (exe 에서만)
   * ===================================================================== */

  /** pywebview API 객체 (해당 함수가 있을 때만) */
  function pyApi(name) {
    var api = window.pywebview && window.pywebview.api;
    return api && typeof api[name] === 'function' ? api : null;
  }

  /** 파이썬 함수 안전 호출: 없으면 undefined 로 끝나는 Promise, 예외는 reject 로 */
  function callPy(name, args) {
    var api = pyApi(name);
    if (!api) return Promise.resolve(undefined);
    try { return Promise.resolve(api[name].apply(api, args || [])); } catch (e) { return Promise.reject(e); }
  }

  var cap = {
    supported: false,   // exe(set_auto_capture 있음) 여부
    status: null,       // 마지막으로 받은 캡처 상태
    pollTimer: null,
    polling: false
  };

  /** 파이썬에 보낼 아이템 목록 (자동 확장 반영된 범위) */
  function knownItemsPayload() {
    return master().items.map(function (it) {
      var r = rangeOf(it.category, it);
      return { name: it.name, category: it.category, min: r.min, max: r.max };
    });
  }

  var knownTimer = null;
  function scheduleKnownItems() {
    if (!pyApi('set_known_items') || demoMode) return;
    clearTimeout(knownTimer);
    knownTimer = setTimeout(pushKnownItemsNow, KNOWN_ITEMS_DEBOUNCE_MS);
  }
  function pushKnownItemsNow() {
    clearTimeout(knownTimer);
    if (!pyApi('set_known_items') || demoMode) return;
    callPy('set_known_items', [knownItemsPayload()]).catch(function (e) { console.warn('[recog] set_known_items 실패', e); });
  }

  /** 헤더 자동 인식 영역 초기화 (앱 시작 시 한 번) */
  function initCapture() {
    cap.supported = !!pyApi('set_auto_capture');
    var tg = $('#capToggle');
    tg.disabled = !cap.supported;
    tg.checked = cap.supported && state.settings.autoCapture;
    $('#capSwitch').title = cap.supported
      ? '게임 화면의 가격 툴팁을 자동으로 읽습니다'
      : 'exe에서만 사용 가능 (브라우저에서는 수동 입력)';
    $('#capSwitch').classList.toggle('disabled', !cap.supported);
    $('#capReadNow').hidden = !pyApi('force_read');

    tg.addEventListener('change', function () {
      state.settings.autoCapture = tg.checked;
      persist();
      applyAutoCapture(tg.checked);
    });
    $('#capReadNow').addEventListener('click', function () {
      var btn = $('#capReadNow');
      btn.disabled = true;
      callPy('force_read').then(function (res) {
        var err = hotkeyError(res === false ? '읽기에 실패했습니다' : res);
        if (err) toast('지금 읽기: ' + err);
      }, function (e) {
        toast('지금 읽기 실패: ' + String(e && e.message || e));
      }).then(function () { btn.disabled = false; pollOnce(); });
    });

    if (cap.supported) {
      // 저장된 켜짐/꺼짐 상태를 파이썬에 다시 적용
      applyAutoCapture(state.settings.autoCapture);
    }
    if (pyApi('set_hotkey') && state.settings.hotkey) {
      callPy('set_hotkey', [state.settings.hotkey]).then(function (res) {
        var err = hotkeyError(res);
        if (err) { toast('단축키 등록 실패: ' + err); setHotkeyMsg(err, true); }
      }, function (e) { console.warn('[recog] set_hotkey 실패', e); });
    }
    pushKnownItemsNow();
    renderCapStatus();
  }

  function applyAutoCapture(on) {
    callPy('set_auto_capture', [!!on]).then(function (res) {
      if (res && typeof res === 'object' && 'enabled' in res) onCaptureStatus(res);
      else pollOnce();
    }, function (e) {
      console.warn('[recog] set_auto_capture 실패', e);
      toast('자동 인식 전환 실패: ' + String(e && e.message || e));
    });
    setPolling(on);
    if (!on) cap.status = cap.status ? Object.assign({}, cap.status, { enabled: false, running: false }) : null;
    renderCapStatus();
  }

  function setPolling(on) {
    clearInterval(cap.pollTimer);
    cap.pollTimer = null;
    if (on && pyApi('get_capture_status')) {
      cap.pollTimer = setInterval(pollOnce, CAPTURE_POLL_MS);
      pollOnce();
    }
  }

  function pollOnce() {
    if (cap.polling || !pyApi('get_capture_status')) return;
    cap.polling = true;
    callPy('get_capture_status').then(function (s) {
      cap.polling = false;
      if (s && typeof s === 'object') onCaptureStatus(s);
    }, function (e) {
      cap.polling = false;
      console.warn('[recog] get_capture_status 실패', e);
    });
  }

  /** 파이썬 → JS: 캡처 상태 알림 */
  function onCaptureStatus(status) {
    if (typeof status === 'string') { try { status = JSON.parse(status); } catch (e) { return false; } }
    if (!status || typeof status !== 'object') return false;
    cap.status = {
      enabled: !!status.enabled,
      running: !!status.running,
      minecraftFound: status.minecraftFound !== false,
      foreground: status.foreground !== false,
      lastReadAt: R.cleanTime(status.lastReadAt),
      lastError: status.lastError ? String(status.lastError) : null,
      fpsActual: C.isNum(status.fpsActual) ? status.fpsActual : null
    };
    renderCapStatus();
    return true;
  }

  /** 헤더 상태 표시: 꺼짐 / 마인크래프트 대기 중 / 게임 창 비활성 / 인식 중 / 오류 */
  function renderCapStatus() {
    var el = $('#capStatus');
    if (!el || !state) return;
    var s = cap.status, cls, text, tip;
    if (!s) {
      if (!cap.supported) { cls = 'na'; text = 'exe에서만 사용 가능'; tip = '자동 인식은 exe 프로그램에서만 동작합니다'; }
      else if (state.settings.autoCapture) { cls = 'wait'; text = '시작 중…'; tip = ''; }
      else { cls = 'off'; text = '꺼짐'; tip = '🎥 자동 인식을 켜면 게임 툴팁의 가격을 자동으로 읽습니다'; }
    } else if (!s.enabled) {
      cls = 'off'; text = '꺼짐'; tip = '자동 인식이 꺼져 있습니다';
    } else if (s.lastError) {
      cls = 'err'; text = '오류'; tip = s.lastError;
    } else if (!s.minecraftFound) {
      cls = 'wait'; text = '마인크래프트 대기 중'; tip = '마인크래프트 창을 찾는 중입니다';
    } else if (!s.foreground) {
      cls = 'wait'; text = '게임 창 비활성'; tip = '마인크래프트 창이 앞에 있을 때만 읽습니다';
    } else if (s.running) {
      cls = 'ok'; text = '인식 중' + (s.lastReadAt ? ' · ' + fmtAgo(s.lastReadAt) : '');
      tip = (s.lastReadAt ? '마지막 인식 ' + fmtClock(s.lastReadAt) : '아직 읽은 툴팁 없음') +
        (s.fpsActual !== null ? ' · 초당 ' + s.fpsActual.toFixed(1) + '회 확인' : '');
    } else {
      cls = 'wait'; text = '대기 중'; tip = '';
    }
    var html = '<i class="dot" aria-hidden="true"></i><span class="cap-text">' + esc(text) + '</span>';
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    el.className = 'cap-status ' + cls;
    el.title = tip;
  }

  /* =====================================================================
   * 자동 인식 — 파이썬 → JS: 인식 결과 처리
   * ===================================================================== */

  var pendingEvents = [];   // 앱 준비 전에 도착한 이벤트
  var recentLog = [];       // 최근 인식 기록 (메모리에만, 최신이 앞)
  var logUnseen = 0;        // 서랍을 닫은 동안 쌓인 새 기록 수
  var logUnseenUnknown = false;

  /** 파이썬 → JS: 툴팁 인식 결과 */
  function onRecognized(raw) {
    if (!state) {
      if (pendingEvents.length < MAX_PENDING_EVENTS) pendingEvents.push(raw);
      return { ok: false, queued: true };
    }
    try {
      return handleRecognized(raw);
    } catch (e) {
      console.error('[recog] 인식 결과 처리 실패', e);
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  function handleRecognized(raw) {
    var evt = R.sanitizeEvent(raw, Date.now());
    if (!evt) { console.warn('[recog] 잘못된 인식 이벤트', raw); return { ok: false, error: 'invalid' }; }
    var it = R.matchItem(master().items, evt.name, evt.category);
    if (!it) {
      addLog({ kind: 'unknown', name: evt.name, category: evt.category, sell: evt.sell, my: evt.my,
        histCount: evt.history.length, ts: evt.ts, confidence: evt.confidence, evt: evt });
      return { ok: false, reason: 'unknown', name: evt.name };
    }
    var cat = it.category, name = it.name;
    var prevSell = sellOf(cat, name), prevMy = myOf(cat, name);

    // ① 판매가 / 나의 판매가
    if (evt.sell !== null) state.sell[cat][name] = evt.sell;
    if (evt.my !== null) state.my[cat][name] = evt.my;
    if (evt.sell !== null || evt.my !== null) {
      state.priceUpdatedAt[cat] = Math.max(state.priceUpdatedAt[cat] || 0, evt.ts);
      state.itemUpdatedAt[cat][name] = evt.ts;
    }
    // ② 가격 기록 병합
    var hist = null;
    if (evt.history.length) {
      hist = R.mergeHistory(state.history[cat][name], evt.history, evt.ts);
      state.history[cat][name] = hist.list;
    }
    // ③ 범위 자동 확장 (판매가 + 지난 가격 기준)
    var expanded = false, rejected = [], eff = null;
    if (state.settings.autoExpandRange) {
      var vals = [evt.sell].concat(evt.history.map(function (h) { return h.price; }));
      var er = R.expandRange(it, state.rangeOverride[cat][name], vals);
      rejected = er.rejected;
      if (er.changed) {
        expanded = true;
        eff = er.range;
        if (er.override) state.rangeOverride[cat][name] = er.override;
        scheduleKnownItems();
      }
    }
    persist();

    var tr = refreshItemRow(cat, name, true);
    var priceChanged = prevSell !== sellOf(cat, name) || prevMy !== myOf(cat, name);
    var lr = addLog({
      kind: 'ok', name: name, category: cat, sell: evt.sell, my: evt.my,
      histCount: evt.history.length, histAdded: hist ? hist.added : 0,
      expanded: expanded, range: eff ? { min: eff.min, max: eff.max, baseMin: eff.baseMin, baseMax: eff.baseMax } : null,
      rejected: rejected, ts: evt.ts, confidence: evt.confidence
    });
    if (priceChanged || expanded || !lr.duplicate || (hist && (hist.added || hist.changed))) flashRow(tr);
    if (expanded && $('#panel-settings').classList.contains('active') === false) renderSettingsPanel();
    if (cat === 'cooking') scheduleOptimize();
    if (pop.cat === cat && pop.name === name) renderHistPop();
    return { ok: true, name: name, category: cat, expanded: expanded };
  }

  /* ── 최근 인식 서랍 ── */

  function addLog(entry) {
    var r = R.pushLog(recentLog, entry);
    recentLog = r.log;
    if (!r.duplicate && $('#logDrawer').hidden) {
      logUnseen++;
      if (entry.kind === 'unknown') logUnseenUnknown = true;
    }
    renderLog();
    return r;
  }

  function renderLogBadge() {
    var b = $('#logBadge');
    b.hidden = logUnseen === 0;
    b.textContent = logUnseen > 9 ? '9+' : String(logUnseen);
    b.classList.toggle('warn', logUnseenUnknown);
  }

  function logEntryHtml(e, i) {
    var icon = e.category ? CAT_ICON[e.category] : '❔';
    var prices = [];
    if (e.sell !== null && e.sell !== undefined) prices.push('판매가 <b>' + fmtG(e.sell) + '</b>');
    if (e.my !== null && e.my !== undefined) prices.push('나의 <b>' + fmtG(e.my) + '</b>');
    if (!prices.length) prices.push('<span class="muted">가격 못 읽음</span>');
    if (e.histCount) prices.push('기록 ' + e.histCount + (e.histAdded ? ' (+' + e.histAdded + ')' : ''));
    var tags = [];
    if (e.expanded && e.range) {
      tags.push('<span class="tag exp" title="원래 ' + esc(C.formatInt(e.range.baseMin) + ' ~ ' + C.formatInt(e.range.baseMax)) + '">범위 확장 ' +
        C.formatInt(e.range.min) + ' ~ ' + C.formatInt(e.range.max) + '</span>');
    }
    if (e.rejected && e.rejected.length) {
      tags.push('<span class="tag warn" title="인식 오류로 보여 범위 확장에 쓰지 않은 값">이상값 무시 ' +
        e.rejected.map(function (v) { return C.formatInt(v); }).join(', ') + '</span>');
    }
    if (C.isNum(e.confidence)) tags.push('<span class="tag">신뢰도 ' + Math.round(e.confidence * 100) + '%</span>');
    if (e.count > 1) tags.push('<span class="tag">×' + e.count + '</span>');
    var actions = '';
    if (e.kind === 'unknown') {
      actions = '<div class="log-actions"><span class="unk">알 수 없는 아이템</span>' +
        (e.category
          ? '<button type="button" class="btn small" data-add-item="' + e.category + '">아이템으로 추가</button>'
          : '<button type="button" class="btn small" data-add-item="cooking">🍳 요리로 추가</button>' +
            '<button type="button" class="btn small" data-add-item="craft">🎨 공예품으로 추가</button>') +
        '</div>';
    }
    return '<div class="log-item ' + e.kind + '" data-i="' + i + '"' + (e.kind === 'ok' ? ' role="button" tabindex="0" title="표에서 보기"' : '') + '>' +
      '<div class="log-top"><span class="log-cat" aria-hidden="true">' + icon + '</span>' +
        '<b class="log-name">' + esc(e.name) + '</b><span class="log-time">' + fmtClock(e.ts) + '</span></div>' +
      '<div class="log-prices">' + prices.join(' · ') + '</div>' +
      (tags.length ? '<div class="log-tags">' + tags.join('') + '</div>' : '') +
      actions + '</div>';
  }

  function renderLog() {
    renderLogBadge();
    var list = $('#logList');
    if (!list) return;
    list.innerHTML = recentLog.length
      ? recentLog.map(logEntryHtml).join('')
      : '<div class="empty small">아직 인식한 아이템이 없습니다.<br>' +
        (cap.supported ? '🎥 자동 인식을 켜고 게임에서 아이템에 마우스를 올려 보세요.' : '자동 인식은 exe 에서만 동작합니다.') + '</div>';
  }

  function openLog(open) {
    var d = $('#logDrawer');
    d.hidden = !open;
    $('#logToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    $('#logToggle').classList.toggle('active', open);
    if (open) { logUnseen = 0; logUnseenUnknown = false; renderLog(); }
  }

  /** 기록에서 "표에서 보기" */
  function jumpToItem(cat, name) {
    setTab(cat);
    var tr = findRow(cat, name);
    if (tr) {
      tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
      flashRow(tr);
    }
  }

  /** 알 수 없는 아이템을 목록에 추가 (인식한 가격으로 최저/최고를 미리 채움) */
  function addItemFromLog(idx, cat) {
    var e = recentLog[idx];
    if (!e || !e.evt || (cat !== 'cooking' && cat !== 'craft')) return;
    var evt = e.evt;
    var name = evt.name.trim().slice(0, S.MAX_NAME_LEN);
    if (findItem(cat, name)) { toast('이미 ' + CAT_LABEL[cat] + ' 목록에 있는 이름입니다.'); return; }
    var vals = [evt.sell].concat(evt.history.map(function (h) { return h.price; })).filter(C.isNum);
    var min = vals.length ? Math.floor(Math.min.apply(null, vals)) : 0;
    var max = vals.length ? Math.ceil(Math.max.apply(null, vals)) : 1000;
    ensureMasterCopy().items.push({ category: cat, name: name, min: min, max: max, ingredients: [] });
    recentLog.splice(idx, 1);
    persist();
    renderAll();
    // 방금 인식한 가격/기록을 새 아이템에 반영
    handleRecognized(Object.assign({}, evt, { category: cat }));
    scheduleKnownItems();
    setTab('settings');
    // 설정 표에서 새 행으로 이동 → 최저가 칸에 포커스 (확인/수정 유도)
    var rows = $$('[data-master="' + cat + '"] tbody tr');
    var row = null;
    rows.forEach(function (r) { if (r.dataset.name === name) row = r; });
    if (row) {
      row.classList.add('new-row');
      row.scrollIntoView({ block: 'center' });
      var inp = $('input[data-f="min"]', row);
      if (inp) { inp.focus(); inp.select(); }
    }
    toast('"' + name + '" 을(를) ' + CAT_LABEL[cat] + ' 목록에 추가했습니다. 최저가/최고가' + (cat === 'cooking' ? '·재료' : '') + '를 확인하세요.');
  }

  function bindLog() {
    $('#logToggle').addEventListener('click', function () { openLog($('#logDrawer').hidden); });
    $('#logClose').addEventListener('click', function () { openLog(false); });
    $('#logClear').addEventListener('click', function () { recentLog = []; renderLog(); });
    var list = $('#logList');
    list.addEventListener('click', function (ev) {
      var add = ev.target.closest('[data-add-item]');
      var item = ev.target.closest('.log-item');
      if (!item) return;
      var e = recentLog[+item.dataset.i];
      if (!e) return;
      if (add) { addItemFromLog(+item.dataset.i, add.dataset.addItem); return; }
      if (e.kind === 'ok') jumpToItem(e.category, e.name);
    });
    list.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      var item = ev.target.closest('.log-item.ok');
      if (!item) return;
      ev.preventDefault();
      var e = recentLog[+item.dataset.i];
      if (e) jumpToItem(e.category, e.name);
    });
  }

  /* =====================================================================
   * 데모 모드 (#demo, #demo-hist, #demo-settings) — 브라우저에서 화면 미리보기용 예시 데이터, 저장 안 함
   * ===================================================================== */

  function runDemo() {
    var variant = (window.location.hash || '').replace(/^#/, '');
    $('#demoBanner').hidden = false;
    var now = Date.now();
    onCaptureStatus({ enabled: true, running: true, minecraftFound: true, foreground: true, lastReadAt: now - 2000, lastError: null, fpsActual: 4 });
    var sim = window.DdingApp.__simulate;
    // ① 알려진 아이템 + 최저가(259)보다 낮은 지난 가격(231) → 범위 확장 + 표시
    sim({ name: '토마토 스파게티', category: 'cooking', sell: 402, my: 441, confidence: 0.97,
      history: [{ day: 21, price: 231 }, { day: 18, price: 512 }, { day: 15, price: 688 }, { day: 12, price: 590 }, { day: 9, price: 377 }] });
    // ② 이름 공백이 다르게 인식돼도 찾음 + 최고가(1,026) 초과 기록 → 최고가 확장
    sim({ name: '어니언링', category: null, sell: 980, my: 1050, confidence: 0.9, history: [{ day: 24, price: 1102 }] });
    // ③ 나의 판매가만 따로 (판매가/나의 판매가 둘 다 갱신)
    sim({ name: '갈릭 케이크', category: 'cooking', sell: 700, my: 742, confidence: 0.95 });
    // ④ 목록에 없는 아이템 → 기록에 "알 수 없는 아이템"
    sim({ name: '황금 수박 주스', category: null, sell: 1500, my: 1620, confidence: 0.88 });
    if (variant === 'demo-hist') {
      setTab('cooking');
      var tr = findRow('cooking', '토마토 스파게티');
      if (tr) toggleHistPop('cooking', '토마토 스파게티', $('[data-hist]', tr));
    } else if (variant === 'demo-settings') {
      setTab('settings');
    } else {
      setTab('cooking');
      openLog(true);
    }
  }

  /* =====================================================================
   * 시작
   * ===================================================================== */

  function renderAll() {
    applyTheme();
    renderPricePanel('cooking');
    renderPricePanel('craft');
    renderInventoryPanel();
    renderSettingsPanel();
    setTab(state.settings.activeTab);
  }

  function bindGlobal() {
    $$('.tab').forEach(function (b) {
      b.addEventListener('click', function () { setTab(b.dataset.tab); });
    });
    $('#themeToggle').addEventListener('click', function () {
      state.settings.theme = state.settings.theme === 'light' ? 'dark' : 'light';
      applyTheme();
      persist();
    });
    $('#modalOk').addEventListener('click', function () { closeModal(true); });
    $('#modalCancel').addEventListener('click', function () { closeModal(false); });
    $('#modal').addEventListener('click', function (e) { if (e.target.id === 'modal') closeModal(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('#modal').hidden) { e.preventDefault(); closeModal(false); return; }
      if (!$('#histPop').hidden) { closeHistPop(); return; }
      if (!$('#logDrawer').hidden) openLog(false);
    });
    // 팝오버 바깥을 누르면 닫기
    document.addEventListener('mousedown', function (e) {
      var el = $('#histPop');
      if (el.hidden || el.contains(e.target) || e.target.closest('[data-hist], [data-range-mark]')) return;
      closeHistPop();
    });
    $('#histPop').addEventListener('click', function (e) {
      if (e.target.closest('[data-pop-close]')) { closeHistPop(); return; }
      if (e.target.closest('[data-pop-reset]')) resetRange(pop.cat, pop.name);
    });
    window.addEventListener('resize', positionHistPop);
    // 표/페이지를 스크롤하면 팝오버 위치를 버튼에 맞춤 (팝오버 안쪽 스크롤은 무시)
    document.addEventListener('scroll', function (e) {
      if (e.target && e.target.nodeType === 1 && $('#histPop').contains(e.target)) return;
      positionHistPop();
    }, true);
    bindLog();
  }

  function start(raw) {
    state = S.normalizeState(raw, DD);
    if (demoMode) {
      // 데모는 항상 깨끗한 기본 상태에서 시작 (저장된 데이터는 읽기만 하고 건드리지 않음)
      var theme = state.settings.theme;
      state = S.createDefaultState(DD);
      state.settings.theme = theme;
    }
    bindGlobal();
    renderAll();
    initCapture();
    renderLog();
    $('#loading').hidden = true;
    setInterval(function () {
      updateCountdowns();
      if (cap.status && cap.status.running) renderCapStatus();
    }, COUNTDOWN_TICK_MS);
    // 준비 전에 도착한 인식 이벤트 처리
    var queued = pendingEvents; pendingEvents = [];
    queued.forEach(onRecognized);
    if (demoMode) runDemo();
  }

  // 패키징(pywebview) 쪽에서 호출하는 전역 도우미 — 스크립트 로드 즉시 정의 (앱 준비 전 호출은 대기열에 보관)
  window.DdingApp = {
    getStateJson: function () { return JSON.stringify(state); },
    flush: function () { return ST.flush(); },
    /** 파이썬 → JS: 툴팁 인식 결과. 반환값 {ok, name?, category?, expanded?, reason?} */
    onRecognized: onRecognized,
    /** 파이썬 → JS: 캡처 상태 */
    onCaptureStatus: function (s) { var r = onCaptureStatus(s); return r; },
    /** 파이썬이 직접 가져갈 수 있는 아이템 목록 (set_known_items 와 같은 형식) */
    getKnownItems: function () { return state ? knownItemsPayload() : []; },
    /** 개발용: 브라우저 콘솔에서 인식 이벤트 흉내 — DdingApp.__simulate({name:'토마토 스파게티', sell:500, my:540}) */
    __simulate: function (evt) {
      var e = Object.assign({ category: null, rarity: null, sell: null, my: null, history: [], ts: Date.now(), confidence: 1 }, evt || {});
      return onRecognized(e);
    }
  };

  ST.init().then(start, function (e) {
    console.warn('[app] 저장소 초기화 실패, 기본값 사용', e);
    start(null);
  });
})();

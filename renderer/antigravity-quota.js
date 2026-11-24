(function () {
  'use strict';

  if (window.__T3_AG_QUOTA_LOADED__) return;
  window.__T3_AG_QUOTA_LOADED__ = true;

  var VERSION = '2.1.0';
  var STORAGE_KEY = 't3-antigravity-quota:v2';
  var MIN_INTERVAL_MS = 5000;
  var FRESH_TTL_MS = 60_000;
  var MANUAL_COOLDOWN_MS = 15_000;
  var FETCH_TIMEOUT_MS = 11_000;
  var ACTIVE_SYNC_MS = 60_000;
  var STARTUP_RETRY_DELAYS = [1500, 3500, 7000];
  var nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });

  var state = {
    root: null,
    slot: null,
    mini: null,
    panel: null,
    fab: null,
    fabPct: null,
    apiBase: null,
    open: false,
    miniOpen: false,
    hoverTimer: 0,
    modelsExpanded: false,
    loading: false,
    activeForce: false,
    pendingForce: false,
    payload: null,
    savedAt: 0,
    error: null,
    needsT3Refresh: false,
    lastFetchAt: 0,
    lastSuccessAt: 0,
    lastManualForceAt: 0,
    startupAttempt: 0,
    startupTimer: 0,
    placementRaf: 0,
    observer: null,
    controller: null,
    ticker: 0,
    bgTimer: 0,
    supportsDisplayTransition: undefined,
  };

  function storeGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storeSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }

  function hasUsableWindows(payload) {
    if (!payload || !Array.isArray(payload.accounts)) return false;
    return payload.accounts.some(function (a) { return Array.isArray(a.windows) && a.windows.length > 0; });
  }

  function loadCache() {
    try {
      var raw = storeGet(STORAGE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.payload || !parsed.savedAt) return;
      if (!hasUsableWindows(parsed.payload)) return;
      // Never inherit an old failure/stale flag across sessions; fresh startup sync will confirm live state
      var clean = Object.assign({}, parsed.payload, { stale: false, error: null });
      state.payload = clean;
      state.savedAt = Number(parsed.savedAt) || 0;
    } catch (e) { /* ignore corrupt cache */ }
  }

  function saveCache(payload) {
    var clean = Object.assign({}, payload, { stale: false, error: null });
    state.payload = clean;
    var checkedMs = clean && clean.checkedAt ? Date.parse(clean.checkedAt) : NaN;
    state.savedAt = isFinite(checkedMs) && checkedMs > 0 ? checkedMs : Date.now();
    try {
      storeSet(STORAGE_KEY, JSON.stringify({ payload: clean, savedAt: state.savedAt }));
    } catch (e) { /* ignore */ }
  }

  function normalizeBaseUrl(raw) {
    return String(raw || '').replace(/\/+$/, '');
  }

  function hasDesktopBridge() {
    try {
      return !!(window.desktopBridge && typeof window.desktopBridge.getLocalEnvironmentBootstraps === 'function');
    } catch (e) {
      return false;
    }
  }

  function candidateApiBases() {
    var list = [];
    var push = function (url) {
      var clean = normalizeBaseUrl(url);
      if (clean && list.indexOf(clean) === -1) list.push(clean);
    };

    if (typeof window.__T3_AG_QUOTA_URL__ === 'string') {
      push(window.__T3_AG_QUOTA_URL__);
    }

    // Primary desktop path: live backend URL from T3's desktopBridge (survives reboots & dynamic ports)
    var hasLiveBootstrap = false;
    try {
      var bridge = window.desktopBridge;
      if (bridge && typeof bridge.getLocalEnvironmentBootstraps === 'function') {
        var bootstraps = bridge.getLocalEnvironmentBootstraps();
        if (Array.isArray(bootstraps)) {
          var primary = bootstraps.find(function (b) { return b && b.id === 'primary' && b.httpBaseUrl; });
          if (primary) {
            push(new URL('/__t3_ag_quota', primary.httpBaseUrl).toString());
            hasLiveBootstrap = true;
          }
          bootstraps.forEach(function (b) {
            if (b && b.httpBaseUrl) {
              push(new URL('/__t3_ag_quota', b.httpBaseUrl).toString());
              hasLiveBootstrap = true;
            }
          });
        }
      }
    } catch (e) { /* ignore */ }

    // Same-origin web view (unless fixture preview points to a separate fixture server port)
    if (window.location && /^https?:$/i.test(window.location.protocol) && !window.__T3_AG_FIXTURE_PREVIEW__) {
      push(window.location.origin + '/__t3_ag_quota');
    }

    // Explicit port or standalone helper fallback
    var injectedPort = Number(window.__T3_AG_QUOTA_PORT__);
    if (injectedPort > 0) push('http://127.0.0.1:' + injectedPort);

    for (var p = 47821; p <= 47826; p += 1) {
      push('http://127.0.0.1:' + p);
    }

    // Only consult legacy cached base after live discovery candidates
    if (!hasLiveBootstrap && !window.__T3_AG_FIXTURE_PREVIEW__) {
      var storedBase = storeGet(STORAGE_KEY + ':base');
      if (storedBase) push(storedBase);
    }
    return list;
  }

  async function probeBase(base, signal) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 1500);
    var onAbort = function () { ctrl.abort(); };
    if (signal) signal.addEventListener('abort', onAbort);
    try {
      var res = await fetch(base + '/health', {
        cache: 'no-store',
        signal: ctrl.signal,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return false;
      var json = await res.json();
      return !!(json && json.ok);
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async function ensureApiBase(signal) {
    if (state.apiBase) return state.apiBase;
    var candidates = candidateApiBases();
    for (var i = 0; i < candidates.length; i += 1) {
      if (await probeBase(candidates[i], signal)) {
        state.apiBase = candidates[i];
        if (!window.__T3_AG_FIXTURE_PREVIEW__ && !hasDesktopBridge()) {
          storeSet(STORAGE_KEY + ':base', state.apiBase);
        }
        return state.apiBase;
      }
    }
    throw new Error('额度服务未启动或连接失败');
  }

  function bandOf(pct) {
    if (typeof pct !== 'number' || !isFinite(pct)) return 'unknown';
    if (pct >= 60) return 'green';
    if (pct >= 30) return 'amber';
    if (pct >= 10) return 'orange';
    return 'red';
  }

  function statusWordFor(pct) {
    if (typeof pct !== 'number' || !isFinite(pct)) return '未知';
    if (pct === 0) return '已耗尽';
    if (pct < 10) return '危急';
    if (pct < 30) return '偏低';
    if (pct < 60) return '适中';
    return '充沛';
  }

  function pctText(pct) {
    if (typeof pct !== 'number' || !isFinite(pct)) return '\u2014';
    return nf.format(Math.max(0, Math.min(100, pct)));
  }

  function formatCountdown(iso) {
    if (!iso) return null;
    var ms = Date.parse(iso) - Date.now();
    if (!isFinite(ms)) return null;
    if (ms <= 0) return '已重置';
    var total = Math.floor(ms / 1000);
    var days = Math.floor(total / 86400);
    var hours = Math.floor((total % 86400) / 3600);
    var mins = Math.floor((total % 3600) / 60);
    var secs = total % 60;
    if (days > 0) return days + '天 ' + hours + '小时 ' + mins + '分';
    if (hours > 0) return hours + '小时 ' + mins + '分 ' + secs + '秒';
    return mins + '分 ' + secs + '秒';
  }

  function formatClock(ms) {
    if (!ms) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ms));
    } catch (e) {
      return new Date(ms).toLocaleTimeString();
    }
  }

  function canonicalPools() {
    var payload = state.payload;
    if (!payload || !Array.isArray(payload.accounts)) return [];
    var out = [];
    payload.accounts.forEach(function (account) {
      var pools = Array.isArray(account.pools) && account.pools.length
        ? account.pools
        : (account.windows || []).map(function (w) {
            return { key: w.id, title: w.label, models: [], windows: [w] };
          });
      pools.forEach(function (pool) {
        out.push({ account: account, pool: pool });
      });
    });
    return out;
  }

  function snapshotTimestamp() {
    var payload = state.payload;
    var checkedMs = payload && payload.checkedAt ? Date.parse(payload.checkedAt) : NaN;
    if (isFinite(checkedMs) && checkedMs > 0) return checkedMs;
    return state.savedAt || 0;
  }

  function allWindows() {
    var out = [];
    canonicalPools().forEach(function (entry) {
      (entry.pool.windows || []).forEach(function (win) {
        out.push({ account: entry.account, pool: entry.pool, win: win });
      });
    });
    return out;
  }

  function lowestWindow() {
    var best = null;
    allWindows().forEach(function (item) {
      var pct = item.win.remainingPct;
      if (typeof pct !== 'number' || !isFinite(pct)) return;
      if (!best || pct < best.win.remainingPct) best = item;
    });
    return best;
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function svgIcon(pathD, size) {
    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size || 15));
    svg.setAttribute('height', String(size || 15));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var p = document.createElementNS(svgNS, 'path');
    p.setAttribute('d', pathD);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.9');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  }

  function prismMark(size) {
    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size || 15));
    svg.setAttribute('height', String(size || 15));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.classList.add('t3-ag-fab__mark');

    var defs = document.createElementNS(svgNS, 'defs');
    var grad = document.createElementNS(svgNS, 'linearGradient');
    var gid = 't3ag-prism-' + Math.random().toString(36).slice(2, 7);
    grad.setAttribute('id', gid);
    grad.setAttribute('x1', '0');
    grad.setAttribute('y1', '1');
    grad.setAttribute('x2', '1');
    grad.setAttribute('y2', '0');
    [['0%', '#38bdf8'], ['50%', '#818cf8'], ['100%', '#e879f9']].forEach(function (pair) {
      var stop = document.createElementNS(svgNS, 'stop');
      stop.setAttribute('offset', pair[0]);
      stop.setAttribute('stop-color', pair[1]);
      grad.appendChild(stop);
    });
    defs.appendChild(grad);
    svg.appendChild(defs);

    var outer = document.createElementNS(svgNS, 'path');
    outer.setAttribute('d', 'M5.5 19.2L12 3.8l6.5 15.4');
    outer.setAttribute('fill', 'none');
    outer.setAttribute('stroke', 'url(#' + gid + ')');
    outer.setAttribute('stroke-width', '2.4');
    outer.setAttribute('stroke-linecap', 'round');
    outer.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(outer);

    var arch = document.createElementNS(svgNS, 'path');
    arch.setAttribute('d', 'M8.4 14.2c2.2-1.3 5-1.3 7.2 0');
    arch.setAttribute('fill', 'none');
    arch.setAttribute('stroke', 'url(#' + gid + ')');
    arch.setAttribute('stroke-width', '2');
    arch.setAttribute('stroke-linecap', 'round');
    svg.appendChild(arch);
    return svg;
  }

  var REFRESH_PATH = 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7';
  var CLOSE_PATH = 'M6 6l12 12M18 6L6 18';
  var CHEVRON_PATH = 'M6 9l6 6 6-6';

  function hasNativePopover() {
    return typeof HTMLElement !== 'undefined' && Object.prototype.hasOwnProperty.call(HTMLElement.prototype, 'popover');
  }

  function canTransitionDisplay() {
    if (state.supportsDisplayTransition !== undefined) return state.supportsDisplayTransition;
    if (!window.CSS || !window.CSS.supports || !window.CSS.supports('transition-behavior', 'allow-discrete') || !document.body) {
      return false;
    }
    var probe = document.createElement('div');
    probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
    document.body.appendChild(probe);
    window.getComputedStyle(probe).display;
    probe.style.display = 'none';
    state.supportsDisplayTransition = window.getComputedStyle(probe).display === 'block';
    probe.remove();
    return state.supportsDisplayTransition;
  }

  function supportsTopLayerExit() {
    return !!(window.CSS && window.CSS.supports && window.CSS.supports('overlay', 'auto') && canTransitionDisplay());
  }

  function buildRoot() {
    var root = el('div');
    root.id = 't3-ag-root';

    var fab = el('button', 't3-ag-fab');
    fab.type = 'button';
    fab.id = 't3-ag-fab';
    fab.setAttribute('aria-label', 'Antigravity 额度详情');
    fab.setAttribute('aria-expanded', 'false');
    fab.setAttribute('aria-controls', 't3-ag-panel');
    fab.appendChild(prismMark(15));
    var fabPct = el('span', 't3-ag-fab__pct', 'AG');
    fabPct.id = 't3-ag-fab-pct';
    var fabDot = el('span', 't3-ag-fab__dot');
    fabDot.setAttribute('aria-hidden', 'true');
    fab.appendChild(fabPct);
    fab.appendChild(fabDot);

    var mini = el('aside', 't3-ag-mini');
    mini.id = 't3-ag-mini';
    mini.setAttribute('aria-hidden', 'true');
    if (hasNativePopover()) {
      mini.setAttribute('popover', 'manual');
    }

    var miniNoise = el('div', 't3-ag-noise');
    miniNoise.setAttribute('aria-hidden', 'true');
    mini.appendChild(miniNoise);

    var miniHead = el('div', 't3-ag-mini__head');
    var miniBrand = el('div', 't3-ag-mini__brand');
    miniBrand.appendChild(prismMark(14));
    miniBrand.appendChild(el('span', 't3-ag-mini__title', 'Antigravity'));
    miniHead.appendChild(miniBrand);
    var miniTier = el('span', 't3-ag-tier t3-ag-mini__tier');
    miniTier.id = 't3-ag-mini-tier';
    miniTier.hidden = true;
    miniHead.appendChild(miniTier);
    mini.appendChild(miniHead);

    var miniList = el('div', 't3-ag-mini__list');
    miniList.id = 't3-ag-mini-list';
    mini.appendChild(miniList);

    var miniHint = el('div', 't3-ag-mini__hint', '点击图标查看模型与重置详情');
    miniHint.id = 't3-ag-mini-hint';
    mini.appendChild(miniHint);

    var panel = el('section', 't3-ag-panel');
    panel.id = 't3-ag-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 't3-ag-h2');
    if (hasNativePopover()) {
      panel.setAttribute('popover', 'auto');
    }

    var noise = el('div', 't3-ag-noise');
    noise.setAttribute('aria-hidden', 'true');
    panel.appendChild(noise);

    var head = el('header', 't3-ag-head');
    var brand = el('div', 't3-ag-brand');
    brand.appendChild(prismMark(16));
    var h2 = el('h2', 't3-ag-h2', 'Antigravity');
    h2.id = 't3-ag-h2';
    brand.appendChild(h2);
    var tier = el('span', 't3-ag-tier');
    tier.id = 't3-ag-tier';
    tier.hidden = true;
    brand.appendChild(tier);
    head.appendChild(brand);

    var actions = el('div', 't3-ag-actions');
    var refreshBtn = el('button', 't3-ag-iconbtn');
    refreshBtn.type = 'button';
    refreshBtn.id = 't3-ag-refresh';
    refreshBtn.setAttribute('aria-label', '刷新额度');
    refreshBtn.appendChild(svgIcon(REFRESH_PATH, 14));
    var closeBtn = el('button', 't3-ag-iconbtn');
    closeBtn.type = 'button';
    closeBtn.id = 't3-ag-close';
    closeBtn.setAttribute('aria-label', '关闭额度面板');
    closeBtn.appendChild(svgIcon(CLOSE_PATH, 14));
    actions.appendChild(refreshBtn);
    actions.appendChild(closeBtn);
    head.appendChild(actions);
    panel.appendChild(head);

    var meta = el('div', 't3-ag-meta');
    var account = el('span', 't3-ag-meta__account', '正在连接…');
    account.id = 't3-ag-account';
    var updated = el('span', 't3-ag-meta__updated', '');
    updated.id = 't3-ag-updated';
    meta.appendChild(account);
    meta.appendChild(updated);
    panel.appendChild(meta);

    var hero = el('div', 't3-ag-hero');
    hero.id = 't3-ag-hero';
    var heroLeft = el('div', 't3-ag-hero__left');
    heroLeft.appendChild(el('div', 't3-ag-hero__kicker', '当前最低剩余额度'));
    var heroValue = el('div', 't3-ag-hero__value');
    var heroNum = el('span', 't3-ag-hero__num', '--');
    heroNum.id = 't3-ag-min';
    heroValue.appendChild(heroNum);
    heroValue.appendChild(el('span', 't3-ag-hero__unit', '%'));
    heroLeft.appendChild(heroValue);
    var heroWin = el('div', 't3-ag-hero__win', '');
    heroWin.id = 't3-ag-minlabel';
    heroLeft.appendChild(heroWin);

    var heroRight = el('div', 't3-ag-hero__right');
    var badge = el('span', 't3-ag-badge');
    badge.id = 't3-ag-badge';
    var bDot = el('span', 't3-ag-badge__dot');
    bDot.setAttribute('aria-hidden', 'true');
    var bText = el('span', '', '读取中');
    bText.id = 't3-ag-badge-text';
    badge.appendChild(bDot);
    badge.appendChild(bText);
    var credits = el('span', 't3-ag-credits', '');
    credits.id = 't3-ag-credits';
    credits.hidden = true;
    heroRight.appendChild(badge);
    heroRight.appendChild(credits);

    hero.appendChild(heroLeft);
    hero.appendChild(heroRight);
    panel.appendChild(hero);

    var scroll = el('div', 't3-ag-scroll');
    var body = el('div', 't3-ag-body');
    body.id = 't3-ag-body';
    scroll.appendChild(body);

    var modelsWrap = el('div', 't3-ag-models-wrap');
    modelsWrap.id = 't3-ag-models-wrap';
    modelsWrap.hidden = true;
    var modelsToggle = el('button', 't3-ag-models-toggle');
    modelsToggle.type = 'button';
    modelsToggle.id = 't3-ag-models-toggle';
    modelsToggle.setAttribute('aria-expanded', 'false');
    modelsToggle.setAttribute('aria-controls', 't3-ag-models-list');
    var modelsLabel = el('span', '', '各模型可用性');
    modelsLabel.id = 't3-ag-models-label';
    modelsToggle.appendChild(modelsLabel);
    modelsToggle.appendChild(svgIcon(CHEVRON_PATH, 14));
    var modelsList = el('div', 't3-ag-models-list');
    modelsList.id = 't3-ag-models-list';
    modelsList.hidden = true;
    modelsWrap.appendChild(modelsToggle);
    modelsWrap.appendChild(modelsList);
    scroll.appendChild(modelsWrap);
    panel.appendChild(scroll);

    var foot = el('footer', 't3-ag-foot');
    var status = el('span', 't3-ag-status', '');
    status.id = 't3-ag-status';
    var retry = el('button', 't3-ag-retry', '重试');
    retry.type = 'button';
    retry.id = 't3-ag-retry';
    retry.hidden = true;
    foot.appendChild(status);
    foot.appendChild(retry);
    panel.appendChild(foot);

    root.appendChild(mini);
    root.appendChild(panel);
    root.appendChild(fab);
    return root;
  }

  function renderSkeleton(body) {
    body.textContent = '';
    for (var i = 0; i < 3; i += 1) {
      var row = el('div', 't3-ag-skel');
      row.appendChild(el('div', 't3-ag-skel__line'));
      row.appendChild(el('div', 't3-ag-skel__bar'));
      body.appendChild(row);
    }
  }

  function renderEmpty(body, message) {
    body.textContent = '';
    var box = el('div', 't3-ag-empty');
    box.appendChild(svgIcon('M12 3a9 9 0 1 0 9 9M12 7v5l3 2', 22));
    box.appendChild(el('p', 't3-ag-empty__text', message));
    body.appendChild(box);
  }

  function shortWindowName(win) {
    if (win.kind === '5h') return '5 小时突发窗口';
    if (win.kind === 'weekly') return '每周总额度';
    return win.label || win.id || '额度窗口';
  }

  function renderWindowRow(win) {
    var pct = win.remainingPct;
    var band = bandOf(pct);
    var row = el('div', 't3-ag-row');
    row.setAttribute('data-band', band);
    if (pct === 0) row.setAttribute('data-zero', 'true');

    var top = el('div', 't3-ag-row__top');
    var left = el('div', 't3-ag-row__left');
    left.appendChild(el('span', 't3-ag-row__label', shortWindowName(win)));
    var right = el('span', 't3-ag-row__pct', pctText(pct) + '%');
    top.appendChild(left);
    top.appendChild(right);
    row.appendChild(top);

    var track = el('div', 't3-ag-track');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    if (typeof pct === 'number' && isFinite(pct)) track.setAttribute('aria-valuenow', String(pct));
    track.setAttribute('aria-label', (win.label || win.id || '额度') + ' 剩余百分比');
    var fill = el('div', 't3-ag-fill');
    fill.style.width = (typeof pct === 'number' && isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0) + '%';
    track.appendChild(fill);
    row.appendChild(track);

    var bottom = el('div', 't3-ag-row__bottom');
    bottom.appendChild(el('span', 't3-ag-row__used', pct === 0 ? '已耗尽' : '已用 ' + pctText(win.usedPct) + '%'));
    if (win.untouched) {
      bottom.appendChild(el('span', 't3-ag-row__reset', '满额就绪'));
    } else if (win.resetsAt) {
      var text = formatCountdown(win.resetsAt);
      if (text) {
        var reset = el('span', 't3-ag-row__reset', text === '已重置' ? text : '重置 ' + text);
        reset.setAttribute('data-reset-at', win.resetsAt);
        bottom.appendChild(reset);
      }
    }
    row.appendChild(bottom);
    return row;
  }

  function renderPools(body) {
    body.textContent = '';
    var accounts = state.payload && Array.isArray(state.payload.accounts) ? state.payload.accounts : [];
    var multiAccount = accounts.length > 1;
    canonicalPools().forEach(function (entry) {
      var account = entry.account;
      var pool = entry.pool;
      var section = el('section', 't3-ag-pool');
      var head = el('div', 't3-ag-pool__head');
      var titleText = multiAccount && (account.email || account.label)
        ? pool.title + ' · ' + (account.email || account.label)
        : pool.title;
      head.appendChild(el('div', 't3-ag-pool__title', titleText));
      if (Array.isArray(pool.models) && pool.models.length) {
        head.appendChild(el('div', 't3-ag-pool__models', pool.models.join(' · ')));
      }
      section.appendChild(head);
      var list = el('div', 't3-ag-windows');
      (pool.windows || []).forEach(function (w) { list.appendChild(renderWindowRow(w)); });
      section.appendChild(list);
      body.appendChild(section);
    });
  }

  function renderModelsSection() {
    var wrap = document.getElementById('t3-ag-models-wrap');
    var toggleBtn = document.getElementById('t3-ag-models-toggle');
    var label = document.getElementById('t3-ag-models-label');
    var list = document.getElementById('t3-ag-models-list');
    if (!wrap || !toggleBtn || !label || !list) return;

    var accounts = state.payload && Array.isArray(state.payload.accounts) ? state.payload.accounts : [];
    var models = [];
    accounts.forEach(function (a) {
      if (Array.isArray(a.models)) models = models.concat(a.models);
    });
    if (!models.length) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    label.textContent = '各模型可用性 (' + models.length + ')';
    toggleBtn.setAttribute('aria-expanded', state.modelsExpanded ? 'true' : 'false');
    list.hidden = !state.modelsExpanded;
    list.textContent = '';
    if (!state.modelsExpanded) return;

    models.forEach(function (m) {
      var chip = el('div', 't3-ag-model-chip');
      chip.setAttribute('data-band', bandOf(m.remainingPct));
      chip.appendChild(el('span', 't3-ag-model-chip__name', m.name || m.id));
      chip.appendChild(el('span', 't3-ag-model-chip__pct', pctText(m.remainingPct) + '%'));
      list.appendChild(chip);
    });
  }

  function updateHeroAndPill() {
    var hero = document.getElementById('t3-ag-hero');
    var num = document.getElementById('t3-ag-min');
    var label = document.getElementById('t3-ag-minlabel');
    var badgeText = document.getElementById('t3-ag-badge-text');
    var creditsEl = document.getElementById('t3-ag-credits');
    var fab = state.fab;
    var fabPct = state.fabPct;

    var lowest = lowestWindow();
    if (!lowest) {
      if (hero) hero.setAttribute('data-band', 'unknown');
      if (num) num.textContent = '--';
      if (label) label.textContent = '暂无额度数据';
      if (badgeText) badgeText.textContent = state.loading ? '读取中' : '未就绪';
      if (fab) {
        fab.setAttribute('data-band', 'unknown');
        fab.setAttribute('aria-label', 'Antigravity 额度详情');
        fab.removeAttribute('title');
      }
      if (fabPct) fabPct.textContent = 'AG';
    } else {
      var pct = lowest.win.remainingPct;
      var band = bandOf(pct);
      var word = statusWordFor(pct);
      if (hero) hero.setAttribute('data-band', band);
      if (num) num.textContent = pctText(pct);
      if (label) label.textContent = lowest.win.label || '';
      if (badgeText) badgeText.textContent = word;
      if (fab) {
        var summary = 'Antigravity 最低剩余 ' + pctText(pct) + '%（' + word + '）';
        fab.setAttribute('data-band', band);
        fab.setAttribute('aria-label', summary);
        fab.removeAttribute('title');
      }
      if (fabPct) fabPct.textContent = pctText(pct) + '%';
    }

    if (creditsEl) {
      var firstAcc = state.payload && Array.isArray(state.payload.accounts) ? state.payload.accounts[0] : null;
      var credit = firstAcc && Array.isArray(firstAcc.credits) && firstAcc.credits[0];
      if (credit && credit.minAmount) {
        creditsEl.hidden = false;
        creditsEl.textContent = 'AI Credits ≥ ' + credit.minAmount;
      } else {
        creditsEl.hidden = true;
      }
    }
  }

  function updateMeta() {
    var accountEl = document.getElementById('t3-ag-account');
    var tierEl = document.getElementById('t3-ag-tier');
    var updatedEl = document.getElementById('t3-ag-updated');
    var payload = state.payload;

    if (!payload || !Array.isArray(payload.accounts) || !payload.accounts.length) {
      if (accountEl) accountEl.textContent = '未检测到 Antigravity 账号';
      if (tierEl) tierEl.hidden = true;
    } else {
      var labels = payload.accounts.map(function (a) { return a.email || a.label || 'Antigravity'; });
      if (accountEl) accountEl.textContent = labels.join(' · ');
      var plan = payload.accounts[0] && payload.accounts[0].plan;
      if (tierEl) {
        if (plan && plan !== 'consumer') {
          tierEl.hidden = false;
          tierEl.textContent = plan;
        } else {
          tierEl.hidden = true;
        }
      }
    }
    var when = snapshotTimestamp();
    if (updatedEl) updatedEl.textContent = when ? '更新 ' + formatClock(when) : '';
  }

  function updateStatus() {
    var status = document.getElementById('t3-ag-status');
    var retry = document.getElementById('t3-ag-retry');
    if (!status || !retry) return;
    retry.hidden = true;
    status.classList.remove('t3-ag-status--warn');
    if (state.loading) {
      status.textContent = '正在同步最新额度…';
    } else if (state.error) {
      status.textContent = state.error;
      status.classList.add('t3-ag-status--warn');
      retry.hidden = false;
    } else if (state.payload && state.payload.fixture) {
      status.textContent = 'fixture 预览数据（非真实额度）';
      status.classList.add('t3-ag-status--warn');
    } else if (state.payload && state.payload.stale) {
      status.textContent = '已过期 · 显示上次成功缓存';
      status.classList.add('t3-ag-status--warn');
      retry.hidden = false;
    } else if (state.payload && state.savedAt && Date.now() - state.savedAt > 5 * 60_000) {
      status.textContent = '缓存较旧，建议刷新';
      status.classList.add('t3-ag-status--warn');
    } else if (state.payload) {
      status.textContent = '实时 · 来自本机 Antigravity 凭证';
    } else {
      status.textContent = '';
    }
  }

  function compactMiniLabel(win) {
    var raw = String((win && win.label) || '');
    return raw
      .replace('Claude & GPT (shared)', 'Claude/GPT')
      .replace(' · 5-hour', ' · 5h')
      .replace(' · Weekly', ' · 每周');
  }

  function renderMini() {
    var mini = state.mini;
    var list = document.getElementById('t3-ag-mini-list');
    var tierEl = document.getElementById('t3-ag-mini-tier');
    var hintEl = document.getElementById('t3-ag-mini-hint');
    if (!mini || !list) return;

    var lowest = lowestWindow();
    mini.setAttribute('data-band', lowest ? bandOf(lowest.win.remainingPct) : 'unknown');

    var accounts = state.payload && Array.isArray(state.payload.accounts) ? state.payload.accounts : [];
    var plan = accounts[0] && accounts[0].plan;
    if (tierEl) {
      if (plan && plan !== 'consumer') {
        tierEl.hidden = false;
        tierEl.textContent = plan;
      } else {
        tierEl.hidden = true;
      }
    }

    list.textContent = '';
    var items = allWindows();
    if (!items.length) {
      var msg = state.loading
        ? '正在同步最新额度…'
        : (state.error || (state.payload && state.payload.empty ? '未检测到 Antigravity 账号' : '暂无额度窗口'));
      list.appendChild(el('div', 't3-ag-mini__empty', msg));
    } else {
      items.forEach(function (entry) {
        var win = entry.win;
        var pct = win.remainingPct;
        var band = bandOf(pct);
        var row = el('div', 't3-ag-mini-row');
        row.setAttribute('data-band', band);
        if (pct === 0) row.setAttribute('data-zero', 'true');

        var top = el('div', 't3-ag-mini-row__top');
        top.appendChild(el('span', 't3-ag-mini-row__name', compactMiniLabel(win)));
        top.appendChild(el('span', 't3-ag-mini-row__pct', pctText(pct) + '%'));
        row.appendChild(top);

        var track = el('div', 't3-ag-mini-track');
        var fill = el('div', 't3-ag-mini-fill');
        var width = typeof pct === 'number' && isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
        fill.style.width = width + '%';
        track.appendChild(fill);
        row.appendChild(track);

        var subText = '';
        if (pct === 0) subText = '已耗尽';
        else if (win.untouched) subText = '满额就绪';
        else if (win.resetsAt) {
          var cd = formatCountdown(win.resetsAt);
          if (cd) subText = cd === '已重置' ? cd : '重置 ' + cd;
        }
        if (subText) {
          var subEl = el('div', 't3-ag-mini-row__sub', subText);
          if (win.resetsAt && !win.untouched) subEl.setAttribute('data-mini-reset-at', win.resetsAt);
          row.appendChild(subEl);
        }
        list.appendChild(row);
      });
    }

    if (hintEl) {
      var when = snapshotTimestamp();
      var stamp = when ? '更新 ' + formatClock(when) + ' · ' : '';
      if (state.loading) {
        hintEl.textContent = '正在同步最新额度…';
        hintEl.classList.remove('is-warn');
      } else if (state.error) {
        hintEl.textContent = state.error;
        hintEl.classList.add('is-warn');
      } else {
        hintEl.textContent = stamp + '点击图标展开详细模型与额度';
        hintEl.classList.remove('is-warn');
      }
    }
  }

  function render() {
    if (!state.panel) return;
    var body = document.getElementById('t3-ag-body');
    if (!body) return;
    if (!state.payload && state.loading) {
      renderSkeleton(body);
    } else if (state.payload) {
      if (!allWindows().length) {
        renderEmpty(body, state.payload.empty ? '未检测到反重力账号，请先在 T3 Code 登录 Antigravity' : '未检测到额度窗口');
      } else {
        renderPools(body);
      }
    } else if (state.error) {
      renderEmpty(body, state.error);
    } else {
      renderSkeleton(body);
    }
    renderModelsSection();
    updateHeroAndPill();
    updateMeta();
    updateStatus();
    renderMini();
  }

  function startTicker() {
    stopTicker();
    state.ticker = window.setInterval(function () {
      var nodes = document.querySelectorAll('#t3-ag-root [data-reset-at], #t3-ag-root [data-mini-reset-at]');
      for (var i = 0; i < nodes.length; i += 1) {
        var iso = nodes[i].getAttribute('data-reset-at') || nodes[i].getAttribute('data-mini-reset-at');
        var text = formatCountdown(iso);
        if (text) nodes[i].textContent = text === '已重置' ? text : '重置 ' + text;
      }
      updateStatus();
    }, 1000);
  }

  function stopTicker() {
    if (state.ticker) {
      window.clearInterval(state.ticker);
      state.ticker = 0;
    }
  }

  function setLoadingSpinner(on) {
    var btn = document.getElementById('t3-ag-refresh');
    if (btn) btn.classList.toggle('is-spinning', !!on);
  }

  async function closeTopLayer(panel) {
    if (!panel) return;
    if (hasNativePopover()) {
      if (!supportsTopLayerExit()) {
        panel.setAttribute('data-closing', '');
        var anims = typeof panel.getAnimations === 'function' ? panel.getAnimations({ subtree: true }) : [];
        if (anims.length > 0) {
          await Promise.race([
            Promise.allSettled(anims.map(function (a) { return a.finished; })),
            new Promise(function (r) { setTimeout(r, 400); }),
          ]);
        }
        if (!panel.hasAttribute('data-closing')) return;
        panel.removeAttribute('data-closing');
      }
      try { if (panel.matches(':popover-open')) panel.hidePopover(); } catch (e) {}
    } else {
      panel.removeAttribute('data-ag-open');
    }
  }

  function positionTopCard(card, maxCardW, minHeightCap) {
    var fab = state.fab;
    if (!card || !fab) return;
    var rect = fab.getBoundingClientRect();
    var vw = window.innerWidth || document.documentElement.clientWidth || 1280;
    var vh = window.innerHeight || document.documentElement.clientHeight || 800;
    var cardW = Math.min(Math.round(vw * 0.90), maxCardW);
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      card.style.left = '14px';
      card.style.right = 'auto';
      card.style.top = 'auto';
      card.style.bottom = '58px';
      card.style.maxHeight = Math.min(Math.floor(vh * 0.82), minHeightCap) + 'px';
      return;
    }

    var isDocked = fab.classList.contains('t3-ag-fab--docked');
    var sidebarEl = isDocked ? (fab.closest('[data-slot="sidebar"]') || fab.closest('[data-sidebar="footer"]') || fab.closest('aside')) : null;
    var sbRect = sidebarEl ? sidebarEl.getBoundingClientRect() : null;
    if (isDocked && sbRect && sbRect.right + 12 + cardW <= vw - 12) {
      card.style.left = Math.round(sbRect.right + 12) + 'px';
      card.style.right = 'auto';
      card.style.top = 'auto';
      card.style.bottom = Math.max(12, Math.round(vh - rect.bottom)) + 'px';
      card.style.maxHeight = Math.max(180, Math.min(Math.floor(vh - 24), Math.floor(vh * 0.86), minHeightCap)) + 'px';
      return;
    }

    var left = Math.round(Math.max(12, Math.min(rect.right + 10, vw - cardW - 12)));
    if (rect.left + cardW <= vw - 12 && !isDocked) {
      left = Math.round(Math.max(12, rect.left));
    }
    card.style.left = left + 'px';
    card.style.right = 'auto';
    if (rect.top >= 220) {
      var bottom = Math.max(12, Math.round(vh - rect.top + 10));
      card.style.top = 'auto';
      card.style.bottom = bottom + 'px';
      card.style.maxHeight = Math.max(180, Math.min(Math.floor(rect.top - 22), Math.floor(vh * 0.82), minHeightCap)) + 'px';
    } else {
      var top = Math.round(rect.bottom + 10);
      card.style.top = top + 'px';
      card.style.bottom = 'auto';
      card.style.maxHeight = Math.max(180, Math.min(Math.floor(vh - rect.bottom - 22), Math.floor(vh * 0.82), minHeightCap)) + 'px';
    }
  }

  function positionPanel() {
    positionTopCard(state.panel, 344, 640);
  }

  function positionMini() {
    positionTopCard(state.mini, 248, 360);
  }

  function clearHoverTimer() {
    if (state.hoverTimer) {
      window.clearTimeout(state.hoverTimer);
      state.hoverTimer = 0;
    }
  }

  function needsAutoSync() {
    return (
      !state.payload ||
      state.payload.stale ||
      state.error ||
      !state.lastSuccessAt ||
      Date.now() - state.lastSuccessAt >= FRESH_TTL_MS
    );
  }

  function setMiniOpen(open) {
    if (!state.mini) return;
    if (open) {
      if (state.open) return;
      state.miniOpen = true;
      render();
      positionMini();
      if (hasNativePopover()) {
        state.mini.removeAttribute('data-closing');
        try {
          if (!state.mini.matches(':popover-open')) state.mini.showPopover();
        } catch (e) {
          state.mini.setAttribute('data-ag-open', 'true');
        }
      } else {
        state.mini.setAttribute('data-ag-open', 'true');
      }
      startTicker();
      if (needsAutoSync()) refresh(false);
    } else {
      if (!state.miniOpen && !state.mini.hasAttribute('data-ag-open')) return;
      state.miniOpen = false;
      closeTopLayer(state.mini);
      if (!state.open) stopTicker();
    }
  }

  function onPanelOpened() {
    clearHoverTimer();
    setMiniOpen(false);
    state.open = true;
    if (state.fab) state.fab.setAttribute('aria-expanded', 'true');
    positionPanel();
    render();
    startTicker();
    if (needsAutoSync()) refresh(false);
  }

  function onPanelClosed() {
    state.open = false;
    if (state.fab) state.fab.setAttribute('aria-expanded', 'false');
    if (!state.miniOpen) stopTicker();
    // Leave any in-flight refresh running so the docked indicator still receives fresh data
  }

  function setOpen(open) {
    if (!state.panel || !state.fab) return;
    if (open) {
      clearHoverTimer();
      setMiniOpen(false);
      positionPanel();
      if (hasNativePopover()) {
        state.panel.removeAttribute('data-closing');
        try {
          if (!state.panel.matches(':popover-open')) state.panel.showPopover();
        } catch (e) {
          state.panel.setAttribute('data-ag-open', 'true');
        }
      } else {
        state.panel.setAttribute('data-ag-open', 'true');
      }
      onPanelOpened();
    } else {
      closeTopLayer(state.panel);
      onPanelClosed();
    }
  }

  function toggle() {
    setOpen(!state.open);
  }

  function clearStartupRetry() {
    if (state.startupTimer) {
      window.clearTimeout(state.startupTimer);
      state.startupTimer = 0;
    }
  }

  function scheduleStartupRetry() {
    clearStartupRetry();
    if (state.lastSuccessAt || state.startupAttempt >= STARTUP_RETRY_DELAYS.length) return;
    var delay = STARTUP_RETRY_DELAYS[state.startupAttempt];
    state.startupAttempt += 1;
    state.startupTimer = window.setTimeout(function () {
      state.startupTimer = 0;
      if (!state.lastSuccessAt) refresh(false);
    }, delay);
  }

  async function refresh(force) {
    if (state.loading) {
      if (force && !state.activeForce) state.pendingForce = true;
      return;
    }
    var now = Date.now();
    if (force && state.lastManualForceAt && now - state.lastManualForceAt < MANUAL_COOLDOWN_MS && !state.error) {
      render();
      return;
    }
    if (
      !force &&
      state.lastSuccessAt &&
      !state.error &&
      !(state.payload && state.payload.stale) &&
      now - state.lastFetchAt < MIN_INTERVAL_MS
    ) {
      return;
    }
    state.loading = true;
    state.activeForce = !!force;
    if (force) state.lastManualForceAt = now;
    state.error = null;
    setLoadingSpinner(true);
    render();

    var controller = new AbortController();
    state.controller = controller;
    var timedOut = false;
    var fetchTimer = window.setTimeout(function () {
      timedOut = true;
      try { controller.abort(); } catch (e) { /* ignore */ }
    }, FETCH_TIMEOUT_MS);

    try {
      var base = await ensureApiBase(controller.signal);
      var url = base + '/api/quota' + (force ? '?refresh=1' : '');
      var res = await fetch(url, {
        signal: controller.signal,
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      var data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!data) throw new Error('额度服务返回了无法解析的数据');
      state.lastFetchAt = Date.now();
      if (data.ok && !data.stale) {
        saveCache(data);
        state.lastSuccessAt = Date.now();
        state.error = null;
        state.needsT3Refresh = false;
        clearStartupRetry();
      } else if (data.ok && data.stale) {
        if (hasUsableWindows(data)) state.payload = data;
        state.error = data.error || '实时查询失败，当前显示上次缓存';
        state.needsT3Refresh = data.needsT3Refresh === true;
        scheduleStartupRetry();
      } else {
        state.error = data.error || '额度获取失败';
        state.needsT3Refresh = data.needsT3Refresh === true;
        scheduleStartupRetry();
      }
    } catch (err) {
      state.lastFetchAt = Date.now();
      if (timedOut) {
        state.error = '请求额度超时，请稍后重试';
        scheduleStartupRetry();
      } else if (err && err.name === 'AbortError') {
        return;
      } else {
        state.apiBase = null;
        state.error = err && err.message ? err.message : '额度服务连接失败';
        scheduleStartupRetry();
      }
    } finally {
      window.clearTimeout(fetchTimer);
      if (state.controller === controller) state.controller = null;
      state.loading = false;
      state.activeForce = false;
      setLoadingSpinner(false);
      render();
      if (state.pendingForce) {
        state.pendingForce = false;
        refresh(true);
      }
    }
  }

  function startBackgroundSync() {
    if (state.bgTimer) window.clearInterval(state.bgTimer);
    // Google-friendly compliance: never poll in background while closed; only refresh if user actively keeps a card open
    state.bgTimer = window.setInterval(function () {
      if (document.hidden) return;
      if ((state.open || state.miniOpen) && Date.now() - state.lastSuccessAt >= ACTIVE_SYNC_MS) {
        refresh(false);
      }
    }, ACTIVE_SYNC_MS);
  }

  function findSidebarFooterAnchor() {
    var footers = document.querySelectorAll('[data-sidebar="footer"]');
    for (var i = 0; i < footers.length; i += 1) {
      var footer = footers[i];
      var rect = footer.getBoundingClientRect();
      if (rect.width < 110 || rect.height < 20) continue;
      // TooltipTrigger sets data-slot="tooltip-trigger", so match by data-sidebar="menu-button" or icon button inside footer menu
      var buttons = footer.querySelectorAll('[data-sidebar="menu-button"][data-size="icon"], [data-sidebar="menu"] button[data-size="icon"]');
      if (!buttons || !buttons.length) continue;
      var lastBtn = buttons[buttons.length - 1];
      var menu = lastBtn.closest('[data-sidebar="menu"]') || footer;
      var item = lastBtn;
      while (item && item.parentElement !== menu) {
        item = item.parentElement;
      }
      if (!item) continue;
      return { container: menu, afterNode: item, width: rect.width };
    }
    return null;
  }

  function syncTriggerPlacement() {
    if (!state.root || !state.fab) return;
    if (!state.slot) {
      state.slot = el('li');
      state.slot.id = 't3-ag-slot';
      state.slot.setAttribute('data-sidebar', 'menu-item');
      state.slot.setAttribute('data-slot', 'sidebar-menu-item');
      state.slot.className = 'group/menu-item relative shrink-0';
    }
    var anchor = findSidebarFooterAnchor();
    if (anchor) {
      if (state.fab.parentElement !== state.slot) {
        state.slot.appendChild(state.fab);
      }
      state.fab.classList.add('t3-ag-fab--docked');
      state.fab.classList.remove('t3-ag-fab--floating');
      if (state.slot.parentElement !== anchor.container || state.slot.previousElementSibling !== anchor.afterNode) {
        anchor.afterNode.insertAdjacentElement('afterend', state.slot);
      }
    } else {
      if (state.slot.parentElement) state.slot.remove();
      if (state.fab.parentElement !== state.root) {
        state.root.insertBefore(state.fab, state.panel || null);
      }
      state.fab.classList.remove('t3-ag-fab--docked');
      state.fab.classList.add('t3-ag-fab--floating');
    }
    if (state.open) positionPanel();
    if (state.miniOpen) positionMini();
  }

  function schedulePlacementSync() {
    if (state.placementRaf) return;
    state.placementRaf = window.requestAnimationFrame(function () {
      state.placementRaf = 0;
      syncTriggerPlacement();
    });
  }

  function bind() {
    var fab = state.fab;
    var closeBtn = document.getElementById('t3-ag-close');
    var refreshBtn = document.getElementById('t3-ag-refresh');
    var retry = document.getElementById('t3-ag-retry');
    var modelsToggle = document.getElementById('t3-ag-models-toggle');
    var panelEl = document.getElementById('t3-ag-panel');

    if (fab) {
      fab.addEventListener('mouseenter', function () {
        clearHoverTimer();
        if (!state.open) setMiniOpen(true);
      });
      fab.addEventListener('mouseleave', function () {
        clearHoverTimer();
        state.hoverTimer = window.setTimeout(function () {
          state.hoverTimer = 0;
          setMiniOpen(false);
        }, 90);
      });
      fab.addEventListener('focusin', function () {
        if (!state.open && fab.matches && fab.matches(':focus-visible')) {
          clearHoverTimer();
          setMiniOpen(true);
        }
      });
      fab.addEventListener('focusout', function () {
        clearHoverTimer();
        setMiniOpen(false);
      });
      fab.addEventListener('click', function (event) {
        event.stopPropagation();
        clearHoverTimer();
        setMiniOpen(false);
        toggle();
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        setOpen(false);
        if (state.fab) state.fab.focus();
      });
    }
    if (refreshBtn) refreshBtn.addEventListener('click', function () { refresh(true); });
    if (retry) retry.addEventListener('click', function () { refresh(true); });
    if (modelsToggle) {
      modelsToggle.addEventListener('click', function () {
        state.modelsExpanded = !state.modelsExpanded;
        renderModelsSection();
      });
    }

    if (panelEl && hasNativePopover()) {
      panelEl.addEventListener('toggle', function (event) {
        if (event.newState === 'open' && !state.open) onPanelOpened();
        else if (event.newState === 'closed' && state.open) onPanelClosed();
      });
    }

    if (!hasNativePopover()) {
      document.addEventListener('pointerdown', function (event) {
        var inRoot = state.root && state.root.contains(event.target);
        var inFab = state.fab && state.fab.contains(event.target);
        if (state.open && !inRoot && !inFab) setOpen(false);
      }, true);
    }

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (state.open) {
          setOpen(false);
          if (state.fab) state.fab.focus();
        } else if (state.miniOpen) {
          setMiniOpen(false);
        }
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && (state.open || !state.lastSuccessAt) && needsAutoSync()) {
        refresh(false);
      }
    });

    window.addEventListener('online', function () {
      if (state.open || state.miniOpen || !state.lastSuccessAt || state.error) {
        refresh(false);
      }
    });

    window.addEventListener('resize', schedulePlacementSync, { passive: true });
  }

  function startPlacementObserver() {
    if (state.observer || typeof MutationObserver !== 'function') return;
    var target = document.body || document.documentElement;
    if (!target) return;
    state.observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i += 1) {
        var t = mutations[i].target;
        if (state.root && (t === state.root || state.root.contains(t))) continue;
        if (state.slot && (t === state.slot || state.slot.contains(t))) continue;
        schedulePlacementSync();
        break;
      }
    });
    state.observer.observe(target, { childList: true, subtree: true });
  }

  function mount() {
    if (document.getElementById('t3-ag-root')) return;
    var root = buildRoot();
    state.root = root;
    state.fab = root.querySelector('#t3-ag-fab');
    state.fabPct = root.querySelector('#t3-ag-fab-pct');
    state.mini = root.querySelector('#t3-ag-mini');
    state.panel = root.querySelector('#t3-ag-panel');
    (document.documentElement || document.body).appendChild(root);
    loadCache();
    syncTriggerPlacement();
    startPlacementObserver();
    bind();
    render();
    startBackgroundSync();
    // Guard early React hydration: re-check footer anchor briefly in addition to MutationObserver
    var dockChecks = 0;
    var dockTimer = window.setInterval(function () {
      dockChecks += 1;
      syncTriggerPlacement();
      if ((state.fab && state.fab.classList.contains('t3-ag-fab--docked')) || dockChecks >= 24) {
        window.clearInterval(dockTimer);
      }
    }, 250);
    // Initial lightweight probe so the button shows live status immediately after T3 launches
    setTimeout(function () {
      syncTriggerPlacement();
      refresh(false);
    }, 300);
  }

  function boot() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
      mount();
    }
  }

  window.__T3_AG_QUOTA_UI__ = {
    version: VERSION,
    refresh: refresh,
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    showMini: function () { setMiniOpen(true); },
    hideMini: function () { setMiniOpen(false); },
  };
  boot();
})();

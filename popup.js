// ─── popup.js — main controller ──────────────────────────────────────────────

// ── DOM refs ──────────────────────────────────────────────────────────────────
const dot          = document.getElementById('dot');
const statusText   = document.getElementById('status-text');
const logEl        = document.getElementById('log');
const resultsWrap  = document.getElementById('results-wrap');
const statListings = document.getElementById('stat-listings');
const statMatched  = document.getElementById('stat-matched');
const statOver     = document.getElementById('stat-overpriced');

const btnAnalyze   = document.getElementById('btn-analyze');
const btnRefresh   = document.getElementById('btn-refresh');
const btnSave      = document.getElementById('btn-save');
const btnClearTok  = document.getElementById('btn-clear-token');
const sortSelect   = document.getElementById('sort-select');
const searchInput  = document.getElementById('search-input');
const doneFilter   = document.getElementById('done-filter');

// ── Last results cache (for re-sorting without re-fetching) ───────────────────
let lastResults = [];

// ── Done state ────────────────────────────────────────────────────────────────
// Persisted in chrome.storage.sync — shared across all Chrome profiles/devices
// Key format: "ItemName||float6dp" or "ItemName||nofloat"
let doneSet = new Set();

const DONE_KEY = 'advisor_done';

function makeDoneKey(name, float) {
  const f = float && float !== 'null' && float !== '' ? parseFloat(float) : null;
  return f != null && !isNaN(f) ? `${name}||${f.toFixed(6)}` : `${name}||nofloat`;
}

async function loadDoneSet() {
  // One-time migration: move done set from local → sync if not yet migrated
  const migrationKey = 'advisor_done_migrated';
  const migrated = await chrome.storage.local.get(migrationKey);
  if (!migrated[migrationKey]) {
    const local = await chrome.storage.local.get(DONE_KEY);
    if (local[DONE_KEY]?.length) {
      await chrome.storage.sync.set({ [DONE_KEY]: local[DONE_KEY] });
      await chrome.storage.local.remove(DONE_KEY);
    }
    await chrome.storage.local.set({ [migrationKey]: true });
  }

  const r = await chrome.storage.sync.get(DONE_KEY);
  doneSet = new Set(r[DONE_KEY] || []);
}

async function toggleDone(name, float) {
  const key = makeDoneKey(name, float);
  if (doneSet.has(key)) {
    doneSet.delete(key);
  } else {
    doneSet.add(key);
  }
  await chrome.storage.sync.set({ [DONE_KEY]: [...doneSet] });
  applySearchAndSort();
}

// Settings inputs
const inpClientId   = document.getElementById('sp-client-id');
const inpSecret     = document.getElementById('sp-client-secret');
const inpSheetId    = document.getElementById('sheet-id');
const inpSheetTab   = document.getElementById('sheet-tab');
const inpMargin     = document.getElementById('min-margin');
const inpStagger    = document.getElementById('stagger-pct');
const inpSlowVol    = document.getElementById('slow-mover-vol');
const inpFloodQty   = document.getElementById('flood-qty-pct');
const inpFloodPrice = document.getElementById('flood-price-pct');

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg, type = 'info') {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(state, text) {
  dot.className = 'dot ' + (state === 'ok' ? 'green' : state === 'err' ? 'red' : 'yellow');
  statusText.textContent = text;
}

function setBusy(busy) {
  btnAnalyze.disabled = busy;
  btnRefresh.disabled = busy;
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
  });
});

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  const r   = await chrome.storage.local.get('advisor_settings');
  const s   = r.advisor_settings || {};
  const cfg = (typeof CONFIG !== 'undefined') ? CONFIG : {};

  inpClientId.value   = s.spClientId     || cfg.spClientId     || '';
  inpSecret.value     = s.spClientSecret || cfg.spClientSecret || '';
  inpSheetId.value    = s.sheetId        || cfg.sheetId        || '';
  inpSheetTab.value   = s.sheetTab       || cfg.sheetTab       || 'Investment';
  inpMargin.value     = s.minMarginPct   ?? 5;
  inpStagger.value    = s.staggerPct     ?? 15;
  inpSlowVol.value    = s.slowMoverVol   ?? 5;
  inpFloodQty.value   = s.floodQtyPct    ?? 20;
  inpFloodPrice.value = s.floodPricePct  ?? 10;

  return getSettingsObj();
}

function getSettingsObj() {
  return {
    spClientId:     inpClientId.value.trim(),
    spClientSecret: inpSecret.value.trim(),
    sheetId:        inpSheetId.value.trim(),
    sheetTab:       inpSheetTab.value.trim() || 'Investment',
    minMarginPct:   parseFloat(inpMargin.value)     || 5,
    staggerPct:     parseFloat(inpStagger.value)    || 15,
    slowMoverVol:   parseInt(inpSlowVol.value)      || 5,
    floodQtyPct:    parseFloat(inpFloodQty.value)   || 20,
    floodPricePct:  parseFloat(inpFloodPrice.value) || 10,
  };
}

async function saveSettings() {
  const s = getSettingsObj();
  await chrome.storage.local.set({ advisor_settings: s });
  log('Settings saved ✓', 'ok');
  setStatus('ok', 'Settings saved');
}

// ── Clear Google token ────────────────────────────────────────────────────────
async function clearGoogleToken() {
  return new Promise(resolve => {
    chrome.identity.getAuthToken({ interactive: false }, token => {
      if (token) {
        fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
        chrome.identity.removeCachedAuthToken({ token }, () => {
          log('Google token cleared — next analyze will re-authenticate', 'ok');
          resolve();
        });
      } else {
        log('No cached token found', 'info');
        resolve();
      }
    });
  });
}

// ── Badge rendering ───────────────────────────────────────────────────────────
const BADGE_LABELS = {
  overpriced:      '🔴 Overpriced',
  slightly_high:   '🟡 Slightly high',
  optimal:         '✅ Optimal',
  underpriced:     '💙 Underpriced',
  below_cost:      '💀 Below cost floor',
  underwater:      '🩸 Underwater',
  flood:           '⚠️ Flood',
  trend_up:        '📈 Trending up',
  trend_down:      '📉 Trending down',
  slow:            '🐢 Slow mover',
  stagger:         '🔱 Stagger',
  no_data:         '❓ No data',
  above_suggested:   '👁️ Low visibility',
  incoming_supply:   '📦 Incoming supply',
  locked:            '',  // rendered dynamically with days remaining — see renderBadges
};

function renderBadges(badges, lockDays) {
  return badges.map(b => {
    if (b === 'locked') {
      const label = lockDays > 0 ? `🔒 ${lockDays}d left` : '🔒 Unlocking';
      return `<span class="badge badge-locked">${label}</span>`;
    }
    return `<span class="badge badge-${b}">${BADGE_LABELS[b] || b}</span>`;
  }).join('');
}

// ── Number formatting ─────────────────────────────────────────────────────────
function fmt(n) {
  if (n == null) return '—';
  return n.toFixed(2);
}
function fmtPct(n) {
  if (n == null) return '';
  return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
}

// ── Sort results ──────────────────────────────────────────────────────────────
function sortResults(results, mode) {
  const urgency = r => {
    if (r.badges.includes('underwater'))    return 0;
    if (r.badges.includes('below_cost'))    return 1;
    if (r.badges.includes('flood'))         return 2;
    if (r.badges.includes('overpriced'))    return 3;
    if (r.badges.includes('trend_down'))    return 4;
    if (r.badges.includes('slightly_high')) return 5;
    if (r.badges.includes('slow'))          return 6;
    if (r.badges.includes('optimal'))       return 7;
    return 8;
  };

  const sorted = [...results];
  switch (mode) {
    case 'urgency':
      sorted.sort((a, b) => {
        const ua = urgency(a);
        const ub = urgency(b);
        if (ua !== ub) return ua - ub;
        // Same urgency: locked items go below unlocked
        const la = a.lockDays > 0 ? 1 : 0;
        const lb = b.lockDays > 0 ? 1 : 0;
        return la - lb;
      });
      break;
    case 'price_desc':
      sorted.sort((a, b) => b.yourPrice - a.yourPrice);
      break;
    case 'price_asc':
      sorted.sort((a, b) => a.yourPrice - b.yourPrice);
      break;
    case 'profit_desc':
      // Items with no sheet data go to bottom
      sorted.sort((a, b) => {
        const pa = a.analysis.profitPctAtSuggested ?? -Infinity;
        const pb = b.analysis.profitPctAtSuggested ?? -Infinity;
        return pb - pa;
      });
      break;
    case 'profit_asc':
      sorted.sort((a, b) => {
        const pa = a.analysis.profitPctAtSuggested ?? Infinity;
        const pb = b.analysis.profitPctAtSuggested ?? Infinity;
        return pa - pb;
      });
      break;
    case 'duplicates':
      sorted.sort((a, b) => {
        const aIs = a.badges.includes('stagger') ? 0 : 1;
        const bIs = b.badges.includes('stagger') ? 0 : 1;
        if (aIs !== bIs) return aIs - bIs;
        // Within duplicates, group by name
        return a.name.localeCompare(b.name);
      });
      break;
    case 'slow':
      sorted.sort((a, b) => {
        const aIs = a.badges.includes('slow') ? 0 : 1;
        const bIs = b.badges.includes('slow') ? 0 : 1;
        if (aIs !== bIs) return aIs - bIs;
        return (a.analysis.dailyRate ?? 0) - (b.analysis.dailyRate ?? 0);
      });
      break;
    case 'underwater':
      sorted.sort((a, b) => {
        const aIs = a.badges.includes('underwater') || a.badges.includes('below_cost') ? 0 : 1;
        const bIs = b.badges.includes('underwater') || b.badges.includes('below_cost') ? 0 : 1;
        return aIs - bIs;
      });
      break;
    case 'locked':
      sorted.sort((a, b) => {
        const aLocked = a.lockDays > 0 ? 0 : 1;
        const bLocked = b.lockDays > 0 ? 0 : 1;
        if (aLocked !== bLocked) return aLocked - bLocked;
        // Among locked items: sort by most days remaining first
        return (b.lockDays || 0) - (a.lockDays || 0);
      });
      break;
  }
  return sorted;
}

// ── Render results table ──────────────────────────────────────────────────────
function renderResults(results) {
  // Apply done filter
  const filterMode = doneFilter ? doneFilter.value : 'new';
  const visible = results.filter(r => {
    const isDone = doneSet.has(makeDoneKey(r.name, r.float));
    if (filterMode === 'new')  return !isDone;
    if (filterMode === 'done') return isDone;
    return true; // 'all'
  });

  if (!visible.length) {
    const msg = filterMode === 'done'
      ? 'No listings marked as done yet'
      : filterMode === 'new'
      ? '🎉 All listings marked as done!'
      : 'No active listings found';
    resultsWrap.innerHTML = `
      <div class="empty-state">
        <div class="icon">🎉</div>
        <div>${msg}</div>
      </div>`;
    return;
  }

  // Stats (always based on full results, not filtered)
  const overpriced = results.filter(r => r.badges.includes('overpriced')).length;
  const matched    = results.filter(r => r.analysis.buySEK).length;
  statListings.textContent = results.length;
  statMatched.textContent  = matched;
  statOver.textContent     = overpriced;

  const rows = visible.map(r => {
    const a = r.analysis;
    const isDone   = doneSet.has(makeDoneKey(r.name, r.float));
    const rowClass = isDone ? 'row-done' : '';
    const doneBtn  = `<button class="btn-done ${isDone ? 'is-done' : ''}"
      data-name="${r.name.replace(/"/g, '&quot;')}"
      data-float="${(r.float || '').replace(/"/g, '&quot;')}"
      title="${isDone ? 'Mark as new' : 'Mark as done'}">✓</button>`;
    const floatStr = r.float && r.float !== 'null' && r.float !== ''
      ? `[${parseFloat(r.float).toFixed(4)}]`
      : '';

    // Current price cell
    const profitStr = a.profitSEK != null
      ? `<div class="price-sub">Net: ${fmt(a.netSEK)} SEK (${fmtPct(a.profitPct)})</div>`
      : '';
    const buyPriceStr = a.buySEK
      ? `<div class="price-sub" style="margin-top:3px;color:#444">Buy: ${fmt(a.buySEK)} SEK</div>`
      : '';

    // Break-even and floor lines for suggestion cell
    // Break-even: list price where net received = buySEK
    // For most items fee=8%, so breakEven = buySEK / 0.92
    // If that result is ≥ 10000 then fee would be 6%, so use / 0.94 instead
    let breakEven = null;
    if (a.buySEK) {
      const beStd = a.buySEK / 0.92;
      breakEven = +(beStd >= 10000 ? a.buySEK / 0.94 : beStd).toFixed(2);
    }
    const marginPct = a.floor && a.buySEK
      ? Math.round(((a.floor * (a.floor >= 10000 ? 0.94 : 0.92)) / a.buySEK - 1) * 100)
      : 5;
    const floorLine = a.buySEK && a.floor
      ? `<div class="suggest-floor">Floor (${marginPct}% margin): ${fmt(a.floor)} SEK</div>`
      : '';
    const breakEvenLine = breakEven
      ? `<div class="suggest-floor">Break-even: ${fmt(breakEven)} SEK</div>`
      : '';

    // Suggested price + reason
    const netAtSuggested = r.suggested != null ? +(r.suggested * (r.suggested >= 10000 ? 0.94 : 0.92)).toFixed(2) : null;
    const suggestStr = r.suggested != null
      ? `<div class="suggest-price">${fmt(r.suggested)} SEK</div>
         <div class="suggest-net">→ ${fmt(netAtSuggested)} SEK net</div>
         <div class="suggest-reason">${(r.suggestedReason || '').replace(' (', '<br><span style="color:#666">(').replace(/\)$/, ')</span>')}</div>
         ${floorLine}${breakEvenLine}`
      : `<div style="color:#555;font-size:11px">${r.suggestedReason || '—'}</div>
         ${floorLine}${breakEvenLine}`;

    // Profit column — always show net payout and profit vs buy price
    let profitCell = '';
    if (a.buySEK) {
      // Profit at suggested price
      if (a.profitAtSuggested != null) {
        const cls = a.profitAtSuggested >= 0 ? 'profit-pos' : 'profit-neg';
        profitCell = `
          <div class="profit-label">@ Suggested</div>
          <div class="${cls}">${a.profitAtSuggested >= 0 ? '+' : ''}${fmt(a.profitAtSuggested)} SEK</div>
          <div class="profit-sub">${fmtPct(a.profitPctAtSuggested)}</div>`;
      }
      // Profit at current price
      if (a.profitSEK != null) {
        const cls2 = a.profitSEK >= 0 ? 'profit-pos' : 'profit-neg';
        profitCell += `
          <div class="profit-label" style="margin-top:5px">@ Current</div>
          <div class="${cls2}">${a.profitSEK >= 0 ? '+' : ''}${fmt(a.profitSEK)} SEK</div>
          <div class="profit-sub">${fmtPct(a.profitPct)}</div>`;
      }
      // Always show floor
      if (a.floor) {
        profitCell += `<div class="profit-sub" style="margin-top:4px">Floor: ${fmt(a.floor)} SEK</div>`;
      }
    } else {
      profitCell = `<span style="color:#444;font-size:10px">No sheet data</span>`;
    }

    // Trade lock line (shown above position advice if locked)
    const lockLine = r.lockDays > 0
      ? `<div class="lock-line">🔒 Locked<br>ready in ${r.lockDays}d</div>`
      : '';

    // Position / spread column — action recommendation combining spread + trend + volume
    let positionCell = '<span style="color:#444;font-size:10px">No sheet data</span>';
    if (a.buySEK) {
      const spreadPct = a.profitPctAtSuggested;
      if (spreadPct == null) {
        positionCell = `${lockLine}<span style="color:#444;font-size:10px">No suggestion</span>`;
      } else if (spreadPct < 0) {
        positionCell = `
          ${lockLine}
          <div class="pos-icon">💀</div>
          <div class="pos-label pos-underwater">Cut losses</div>
          <div class="pos-sub">Market dropped below your buy cost</div>`;
      } else if (spreadPct < 5) {
        const urgentExit = r.badges.includes('trend_down') || r.badges.includes('flood');
        positionCell = `
          ${lockLine}
          <div class="pos-icon">🔴</div>
          <div class="pos-label pos-exit">${urgentExit ? 'Sell immediately' : 'Sell soon'}</div>
          <div class="pos-sub">${urgentExit ? 'Trend worsening, spread almost gone' : 'Near breakeven, don\'t wait longer'}</div>`;
      } else if (spreadPct < 15) {
        const holdable = r.badges.includes('trend_up');
        positionCell = `
          ${lockLine}
          <div class="pos-icon">🟡</div>
          <div class="pos-label pos-tight">${holdable ? 'Hold briefly' : 'Sell at median'}</div>
          <div class="pos-sub">${holdable ? 'Trending up, may improve' : 'Thin margin, don\'t overprice'}</div>`;
      } else {
        const slowRisk = r.badges.includes('slow');
        positionCell = `
          ${lockLine}
          <div class="pos-icon">🟢</div>
          <div class="pos-label pos-wide">Room to hold</div>
          <div class="pos-sub">${slowRisk ? 'Good margin but slow — price competitively' : 'Price above median, good position'}</div>`;
      }
    } else if (r.lockDays > 0) {
      // No sheet data but still locked — at least show lock info
      positionCell = lockLine;
    }
    // Market info row
    const mktStr = `
      <div class="market-row">
        ${a.minPrice   != null ? `<span class="market-item">Min: <span class="market-val">${fmt(a.minPrice)}</span></span>` : ''}
        ${a.salesMed7  != null ? `<span class="market-item">Med7d: <span class="market-val">${fmt(a.salesMed7)}</span></span>` : ''}
        ${a.salesMed30 != null ? `<span class="market-item">Med30d: <span class="market-val">${fmt(a.salesMed30)}</span></span>` : ''}
        ${a.qty        != null ? `<span class="market-item">Qty: <span class="market-val">${a.qty}</span></span>` : ''}
        ${a.salesVol7  != null ? `<span class="market-item">Vol7d: <span class="market-val">${a.salesVol7}</span></span>` : ''}
        ${a.dailyRate   > 0    ? `<span class="market-item">Rate: <span class="market-val">${a.dailyRate}/day</span></span>` : ''}
      </div>`;

    // Buy info row
    const buyStr = a.buySEK
      ? `<div class="market-row">
           <span class="market-item">Paid: <span class="market-val">${fmt(a.buySEK)} SEK</span></span>
           ${a.floor ? `<span class="market-item">Floor: <span class="market-val">${fmt(a.floor)} SEK</span></span>` : ''}
         </div>`
      : `<div style="font-size:10px;color:#444;margin-top:3px">No sheet data</div>`;

    return `
      <tr class="${rowClass}">
        <td>
          <div class="item-name">${r.name}</div>
          ${floatStr ? `<div class="item-float">${floatStr}</div>` : ''}
          <div class="badges">${renderBadges(r.badges, r.lockDays)}</div>
          ${mktStr}
          ${buyStr}
        </td>
        <td class="price-cell">
          <div class="price-main">${fmt(r.yourPrice)} SEK</div>
          ${profitStr}
          ${buyPriceStr}
        </td>
        <td class="suggest-cell">${suggestStr}</td>
        <td class="profit-col">${profitCell}</td>
        <td class="position-col">${positionCell}</td>
        <td style="text-align:center;vertical-align:middle">${doneBtn}</td>
      </tr>`;
  }).join('');

  resultsWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Item</th>
          <th>Your Price</th>
          <th>Suggestion</th>
          <th>Profit</th>
          <th>Position</th>
          <th style="text-align:center">✓</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── Main analyze flow ─────────────────────────────────────────────────────────
async function analyze(forceRefresh = false) {
  setBusy(true);
  setStatus('yellow', 'Analyzing…');
  resultsWrap.innerHTML = `<div class="empty-state"><div>⏳ Loading…</div></div>`;

  try {
    const s = getSettingsObj();
    if (!s.spClientId || !s.spClientSecret) {
      throw new Error('Enter Skinport credentials in Settings tab first');
    }
    if (!s.sheetId) {
      throw new Error('Enter your Google Sheet ID in Settings tab first');
    }

    // Clear cache if refresh requested
    if (forceRefresh) {
      await new Promise(r => chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' }, r));
      log('Cache cleared', 'info');
    }

    // ── Step 1: Fetch my listings ──
    log('Fetching your active listings from Skinport…', 'info');
    const listings = await fetchMyListings();
    if (!listings.length) {
      setStatus('ok', 'No active listings');
      resultsWrap.innerHTML = `<div class="empty-state"><div class="icon">🎉</div><div>No active listings found</div></div>`;
      setBusy(false);
      return;
    }
    log(`Found ${listings.length} active listing(s)`, 'ok');

    // ── Prune done set: remove keys for items no longer listed (sold) ──
    // Match by name only — float precision can vary between API calls
    // causing false pruning. If the item name isn't in listings at all, it's sold.
    const activeNames = new Set(listings.map(l => l.name.trim()));
    const before = doneSet.size;
    for (const key of [...doneSet]) {
      const name = key.split('||')[0];
      if (!activeNames.has(name)) doneSet.delete(key);
    }
    if (doneSet.size !== before) {
      await chrome.storage.sync.set({ [DONE_KEY]: [...doneSet] });
      log(`Pruned ${before - doneSet.size} sold item(s) from done list`, 'info');
    }

    // ── Step 2: Get unique names for API batching ──
    const uniqueNames = [...new Set(listings.map(l => l.name))];
    log(`Fetching market data for ${uniqueNames.length} unique item(s)…`, 'info');

    // ── Step 3: Fetch market items (cached 5min) ──
    const { tradableMap, allMap: marketMap } = await fetchMarketItems();
    log(`Market data loaded (${marketMap.size} items tradable=0, ${tradableMap.size} tradable=1)`, 'ok');

    // ── Step 4: Batch fetch sales history (max 8 names per call) ──
    // Split into chunks of 8 to respect rate limits
    const CHUNK = 8;
    const historyMap = new Map();
    for (let i = 0; i < uniqueNames.length; i += CHUNK) {
      const chunk = uniqueNames.slice(i, i + CHUNK);
      log(`Fetching sales history ${i + 1}–${Math.min(i + CHUNK, uniqueNames.length)} / ${uniqueNames.length}…`, 'info');
      try {
        const chunkMap = await fetchSalesHistory(chunk);
        chunkMap.forEach((v, k) => historyMap.set(k, v));
        if (i + CHUNK < uniqueNames.length) {
          await new Promise(r => setTimeout(r, 1500)); // polite delay
        }
      } catch (e) {
        log(`History chunk failed: ${e.message}`, 'warn');
      }
    }
    log(`Sales history loaded for ${historyMap.size} item(s)`, 'ok');

    // ── Step 5: Load buy prices from Google Sheet ──
    log('Loading buy prices from Google Sheet…', 'info');
    let buyMap = new Map();
    try {
      const rows = await readSheetRows(s.sheetId, s.sheetTab);
      buyMap = buildBuyMap(rows);
      log(`Sheet loaded: ${rows.length} rows, ${buyMap.size} unique items`, 'ok');
    } catch (e) {
      log(`Sheet load failed: ${e.message} — continuing without buy prices`, 'warn');
    }

    // ── Step 6: Load previous market snapshot for flood detection ──
    const snapKey = 'market_snapshot';
    let cachedMarketSnapshot = null;
    const cacheResp = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_CACHE' }, r));
    if (cacheResp?.cache?.[snapKey]) {
      cachedMarketSnapshot = cacheResp.cache[snapKey].data;
    }

    // Save new snapshot
    const snapshot = {};
    uniqueNames.forEach(name => {
      const m = marketMap.get(name);
      if (m) snapshot[name] = { qty: m.quantity, minPrice: m.min_price, ts: Date.now() };
    });
    await new Promise(r => chrome.runtime.sendMessage({ type: 'SET_CACHE', key: snapKey, data: snapshot }, r));

    // ── Step 6b: Log sheet match diagnostics ──
    const matchedListings  = listings.filter(l => {
      const entry = lookupBuyPrice(buyMap, l.name, l.float);
      return entry && entry.buySEK > 0;
    });
    const unmatchedListings = listings.filter(l => {
      const entry = lookupBuyPrice(buyMap, l.name, l.float);
      return !entry || !entry.buySEK;
    });
    log(`Sheet match: ${matchedListings.length}/${listings.length} listings have buy prices`, matchedListings.length ? 'ok' : 'warn');
    if (unmatchedListings.length) {
      unmatchedListings.slice(0, 5).forEach(l => {
        const fStr = l.float && l.float !== '' && l.float !== 'null'
          ? ` [float: ${parseFloat(l.float).toFixed(6)}]`
          : ' [no float]';
        log(`  ↳ No sheet match: "${l.name}"${fStr}`, 'warn');
      });
      if (unmatchedListings.length > 5) {
        log(`  ↳ …and ${unmatchedListings.length - 5} more unmatched`, 'warn');
      }
    }

    // ── Step 7: Run pricing engine ──
    log('Running pricing analysis…', 'info');
    const results = analyzeAllListings({
      listings,
      marketMap,
      tradableMap,
      historyMap,
      buyMap,
      cachedMarketSnapshot,
      settings: s,
    });

    // ── Diagnostic: log raw data for each item ──
    results.forEach(r => {
      const a = r.analysis;
      const lockStr = r.lockDays > 0 ? ` | LOCKED ${r.lockDays}d` : ' | unlocked';
      log(`📦 ${r.name} [${r.float || 'no float'}]${lockStr}`, 'info');
      log(`   Market → min:${a.minPrice} (tradable:${a.minPriceTradable ?? '—'} all:${a.minPriceAll ?? '—'}) med7d:${a.salesMed7} med30d:${a.salesMed30} qty:${a.qty} vol7d:${a.salesVol7}`, 'info');
      log(`   Yours:${r.yourPrice} SEK | Suggested:${r.suggested} SEK | Badges: ${r.badges.join(', ')}`, 'info');
      log(`   Reason: ${r.suggestedReason}`, 'info');
      if (a.buySEK) log(`   Buy:${a.buySEK} Floor:${a.floor} BreakEven:${a.buySEK ? +(a.buySEK/0.92).toFixed(2) : '—'}`, 'info');
    });

    // ── Step 8: Render ──
    lastResults = results;
    renderResults(sortResults(results, sortSelect.value));

    const overpriced = results.filter(r => r.badges.includes('overpriced')).length;
    const belowCost  = results.filter(r => r.badges.includes('below_cost')).length;
    const floods     = results.filter(r => r.badges.includes('flood')).length;

    log(`Analysis complete: ${results.length} listings | ${overpriced} overpriced | ${belowCost} below cost | ${floods} flood`, 'ok');
    setStatus('ok', `${results.length} listings analyzed`);

  } catch (e) {
    setStatus('err', e.message);
    log(`Error: ${e.message}`, 'err');
    resultsWrap.innerHTML = `
      <div class="empty-state">
        <div class="icon">❌</div>
        <div style="color:#f44336">${e.message}</div>
      </div>`;
  }

  setBusy(false);
}

// ── Done button delegation (MV3 blocks inline onclick) ───────────────────────
resultsWrap.addEventListener('click', e => {
  const btn = e.target.closest('.btn-done');
  if (!btn) return;
  toggleDone(btn.dataset.name, btn.dataset.float);
});

// ── Search filter ─────────────────────────────────────────────────────────────
function applySearchAndSort() {
  if (!lastResults.length) return;
  const query = searchInput.value.trim().toLowerCase();
  const filtered = query
    ? lastResults.filter(r => r.name.toLowerCase().includes(query))
    : lastResults;
  renderResults(sortResults(filtered, sortSelect.value));
}

// ── Event listeners ───────────────────────────────────────────────────────────
btnAnalyze.addEventListener('click', () => analyze(false));
btnRefresh.addEventListener('click', () => analyze(true));
sortSelect.addEventListener('change', applySearchAndSort);
searchInput.addEventListener('input', applySearchAndSort);
doneFilter.addEventListener('change', applySearchAndSort);
btnSave.addEventListener('click',    saveSettings);
btnClearTok.addEventListener('click', clearGoogleToken);
document.getElementById('btn-popout').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
});

// ── Init ──────────────────────────────────────────────────────────────────────
// If opened as a full tab (not the popup), expand to fill viewport
if (window.outerWidth > 900) {
  document.body.classList.add('full-tab');
}

loadDoneSet().then(() => loadSettings());

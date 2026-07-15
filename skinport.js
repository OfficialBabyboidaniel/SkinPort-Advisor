// ─── skinport.js — Skinport API module ───────────────────────────────────────

const SP_LISTED_URL  = 'https://skinport.com/api/inventory/listed';
const SP_ITEMS_URL   = 'https://api.skinport.com/v1/items';
const SP_HISTORY_URL = 'https://api.skinport.com/v1/sales/history';
const SP_CACHE_TTL   = 5 * 60 * 1000; // 5 min

// ─── Cache helpers (via background service worker) ───────────────────────────
async function cacheGet(key) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_CACHE' }, r => {
      const entry = r?.cache?.[key];
      if (entry && (Date.now() - entry.ts) < SP_CACHE_TTL) {
        resolve(entry.data);
      } else {
        resolve(null);
      }
    });
  });
}

async function cacheSet(key, data) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'SET_CACHE', key, data }, () => resolve());
  });
}

// ─── Fetch your active listings (requires Skinport session cookie) ────────────
async function fetchMyListings() {
  const resp = await fetch(SP_LISTED_URL, {
    credentials: 'include',
    headers: {
      'accept':  'application/json, text/plain, */*',
      'referer': 'https://skinport.com/myitems/listed',
    }
  });
  if (!resp.ok) throw new Error(`Skinport listings: HTTP ${resp.status}`);
  const data = await resp.json();

  if (data?.message === 'MUST_LOGIN') {
    throw new Error('Not logged in to Skinport — open skinport.com and sign in first.');
  }

  const raw = Array.isArray(data) ? data : (data.items || data.data || []);
  if (!raw.length) return [];

  return raw.map(item => {
    const rawPrice = item.price ?? item.salePrice ?? item.listing_price ?? 0;

    // Trade lock: Skinport returns lock expiry as an ISO date string e.g. "2026-07-14T07:00:00.000Z"
    const rawLock = item.lock ?? null;
    let lockUntil = null;
    if (rawLock) {
      const d = new Date(rawLock);
      if (!isNaN(d) && d > new Date()) lockUntil = d;
    }

    return {
      saleId:    item.id ?? item.saleId ?? null,
      name:      item.marketHashName || item.market_hash_name || item.name || '',
      float:     item.wear != null ? String(item.wear) : (item.float != null ? String(item.float) : ''),
      priceSEK:  +(rawPrice / 100).toFixed(2),   // Skinport sends price in öre (1/100 SEK)
      currency:  item.currency || 'SEK',
      lockUntil, // Date object or null
    };
  });
}

// ─── Fetch market-wide item data (min, median, suggested, qty) ────────────────
// Fetches both tradable=1 (buyable now) and tradable=0 (all including locked)
// Returns { tradableMap, allMap } — both Map: marketHashName → item object
async function fetchMarketItems() {
  const cacheKeyT = 'market_items_tradable';
  const cacheKeyA = 'market_items_all';

  const [cachedT, cachedA] = await Promise.all([
    cacheGet(cacheKeyT),
    cacheGet(cacheKeyA),
  ]);

  let tradableMap, allMap;

  if (cachedT) {
    tradableMap = new Map(cachedT);
  } else {
    const resp = await fetch(`${SP_ITEMS_URL}?app_id=730&currency=SEK&tradable=1`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!resp.ok) throw new Error(`Skinport /v1/items (tradable=1): HTTP ${resp.status}`);
    const list = await resp.json();
    tradableMap = new Map(list.map(item => [item.market_hash_name, item]));
    await cacheSet(cacheKeyT, [...tradableMap.entries()]);
  }

  if (cachedA) {
    allMap = new Map(cachedA);
  } else {
    const resp = await fetch(`${SP_ITEMS_URL}?app_id=730&currency=SEK&tradable=0`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!resp.ok) throw new Error(`Skinport /v1/items (tradable=0): HTTP ${resp.status}`);
    const list = await resp.json();
    allMap = new Map(list.map(item => [item.market_hash_name, item]));
    await cacheSet(cacheKeyA, [...allMap.entries()]);
  }

  return { tradableMap, allMap };
}

// ─── Fetch sales history for a batch of item names ────────────────────────────
// Skinport accepts comma-separated market_hash_name values (max ~8 per 5min window)
// Returns a Map: marketHashName → history object
async function fetchSalesHistory(names) {
  if (!names.length) return new Map();

  const cacheKey = 'history_' + names.slice().sort().join(',');
  const cached = await cacheGet(cacheKey);
  if (cached) return new Map(cached);

  const param   = encodeURIComponent(names.join(','));
  const resp    = await fetch(
    `${SP_HISTORY_URL}?app_id=730&currency=SEK&market_hash_name=${param}`,
    { headers: { 'Accept': 'application/json' } }
  );

  if (!resp.ok) {
    if (resp.status === 429) throw new Error('Skinport rate limit hit — wait 5 minutes and try again.');
    throw new Error(`Skinport /v1/sales/history: HTTP ${resp.status}`);
  }

  const list = await resp.json();
  if (list?.errors) throw new Error(list.errors[0]?.message || 'Skinport history error');

  const map = new Map(list.map(h => [h.market_hash_name, h]));
  await cacheSet(cacheKey, [...map.entries()]);
  return map;
}

// ─── sheets.js — Google Sheets module ────────────────────────────────────────

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

// Column indices (0-based) matching your Investment tab
const COL = {
  NAME:     0,  // A
  BUY_CNY:  1,  // B — Buy¥
  BUY_EUR:  2,  // C — Buy€
  BUY_SEK:  3,  // D — BuySEK
  BUY_DATE: 4,  // E — BuyDate
  SELL_EUR: 5,  // F — Sell€
  SELL_SEK: 6,  // G — SellSEK
  SELL_USD: 7,  // H — SellUSD
  SELL_DATE:8,  // I — SellDate
  FLOAT:    9,  // J — Float
};

// ─── Get Google OAuth token ───────────────────────────────────────────────────
async function getGoogleToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, token => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

// ─── Read all rows from the sheet ─────────────────────────────────────────────
async function readSheetRows(sheetId, sheetTab) {
  const token = await getGoogleToken(true);
  const range = encodeURIComponent(`${sheetTab}!A:J`);
  const resp  = await fetch(`${SHEETS_BASE}/${sheetId}/values/${range}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Google Sheets read error: HTTP ${resp.status} — ${err}`);
  }
  const json = await resp.json();
  return json.values || [];
}

// ─── Build a buy-price lookup map from sheet rows ─────────────────────────────
// Key: "ItemName||float6dp"  or  "ItemName||nofloat"
// Value: { buySEK, buyEUR, buyDate, rowIndex }
// For unsold rows only (no Sell€ value yet) — these are your active holdings
function buildBuyMap(rows) {
  const map = new Map();

  for (let i = 1; i < rows.length; i++) {  // skip header row
    const row = rows[i];
    const name    = (row[COL.NAME]     || '').toString().trim();
    const buySEK  = parseFloat(row[COL.BUY_SEK]  || '0') || 0;
    const buyEUR  = parseFloat(row[COL.BUY_EUR]  || '0') || 0;
    const buyDate = (row[COL.BUY_DATE] || '').toString().trim();
    const float   = (row[COL.FLOAT]   || '').toString().trim();
    const sellEUR = (row[COL.SELL_EUR] || '').toString().trim();

    if (!name) continue;
    // Include ALL rows — both sold and unsold — so we can match listings
    // We'll flag sold ones separately

    const key = makeSheetKey(name, float);

    // Allow multiple rows with same key (duplicates) — store as array
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      buySEK,
      buyEUR,
      buyDate,
      rowIndex: i,
      isSold: !!sellEUR,
    });
  }

  return map;
}

// ─── Match key: name + float (6dp) or name + "nofloat" ───────────────────────
function makeSheetKey(name, float) {
  name = name.toString().trim();
  if (!float || float === 'null' || float === '') {
    return `${name}||nofloat`;
  }
  const f = parseFloat(float);
  if (isNaN(f)) return `${name}||nofloat`;
  return `${name}||${f.toFixed(6)}`;
}

// ─── Look up buy price for a listing ─────────────────────────────────────────
// Returns { buySEK, buyEUR, buyDate } or null if not found
function lookupBuyPrice(buyMap, name, float) {
  const key = makeSheetKey(name, float);

  // Try exact float match first
  if (buyMap.has(key)) {
    const entries = buyMap.get(key);
    // Prefer unsold entries
    const unsold = entries.find(e => !e.isSold);
    return unsold || entries[0];
  }

  // Fallback: try name-only match (for agents/stickers with no float)
  const noFloatKey = `${name.trim()}||nofloat`;
  if (buyMap.has(noFloatKey)) {
    const entries = buyMap.get(noFloatKey);
    const unsold = entries.find(e => !e.isSold);
    return unsold || entries[0];
  }

  return null;
}

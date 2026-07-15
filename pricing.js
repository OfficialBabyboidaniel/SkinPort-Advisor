// ─── pricing.js — Pricing engine ─────────────────────────────────────────────
//
// Strategy (evidence-based from live Skinport API analysis):
//
//  • DEFAULT sort on Skinport is "position" (relevance), NOT price-asc
//  • Cheapest listing is NOT automatically shown first to all buyers
//  • Buyers in "percent-desc" sort see items with min_price furthest below suggested_price
//  • suggested_price is Skinport's reference — listing above it hurts visibility
//  • Use 7d SALES MEDIAN (not listing median, not avg) as price anchor
//  • Avg is skewed by stickered/pattern outliers — useless for plain copy pricing
//  • Listing median runs ~5-15% ABOVE sales median — sellers ask more than buyers pay
//  • Fee: 8% standard (< 10,000 SEK), 6% high-tier (≥ 10,000 SEK)
//  • Stagger duplicates: copy1 at floor, copy2 at median, copy3 at median+15%
//  • Flood detection: qty spike + price drop = temporary supply, hold at median

// ─── Fee calculation ──────────────────────────────────────────────────────────
function getFeeRate(listPriceSEK) {
  return listPriceSEK >= 10000 ? 0.06 : 0.08;
}

function netReceived(listPriceSEK) {
  return listPriceSEK * (1 - getFeeRate(listPriceSEK));
}

// ─── Cost floor ───────────────────────────────────────────────────────────────
// Min list price to break even / hit target margin
function calcFloor(buySEK, targetMarginPct = 5) {
  if (!buySEK || buySEK <= 0) return null;
  // Iterative: fee depends on list price, so solve numerically
  // For most items < 10k, fee=8%:  listPrice = buySEK / 0.92 * (1 + margin/100)
  const margin = 1 + targetMarginPct / 100;
  const floorStd = buySEK / 0.92 * margin;
  if (floorStd >= 10000) {
    // High-tier: fee=6%
    return buySEK / 0.94 * margin;
  }
  return floorStd;
}

function calcProfit(buySEK, listPriceSEK) {
  if (!buySEK || buySEK <= 0 || !listPriceSEK) return null;
  const net = netReceived(listPriceSEK);
  return {
    profitSEK: +(net - buySEK).toFixed(2),
    profitPct: +((net - buySEK) / buySEK * 100).toFixed(1),
    netSEK:    +net.toFixed(2),
  };
}

// ─── Flood detection ──────────────────────────────────────────────────────────
// Compares current quantity to previous snapshot stored in cache
// Returns true if a supply flood is detected
function detectFlood(currentQty, cachedQty, currentMin, cachedMin, settings) {
  if (!cachedQty || !cachedMin) return false;
  const qtySpikePct = (currentQty - cachedQty) / cachedQty * 100;
  const priceDrop   = (cachedMin - currentMin) / cachedMin * 100;
  const qtyThresh   = settings.floodQtyPct   ?? 20;
  const priceThresh = settings.floodPricePct ?? 10;
  return qtySpikePct >= qtyThresh && priceDrop >= priceThresh;
}

// ─── Trend detection ──────────────────────────────────────────────────────────
// Uses 7d sales median vs 30d sales median (more reliable than avg)
function detectTrend(history) {
  if (!history) return 'unknown';
  const med7  = history.last_7_days?.median  || 0;
  const med30 = history.last_30_days?.median || 0;
  if (!med7 || !med30) return 'unknown';
  const pct = (med7 - med30) / med30 * 100;
  if (pct >  3) return 'up';
  if (pct < -3) return 'down';
  return 'stable';
}

// ─── Slow mover detection ─────────────────────────────────────────────────────
function isSlowMover(history, settings) {
  const threshold = settings.slowMoverVol ?? 5;
  const vol7 = history?.last_7_days?.volume ?? 0;
  return vol7 <= threshold;
}

// ─── Stagger tiers for duplicate copies ──────────────────────────────────────
// copyIndex: 0-based (0=first copy, 1=second, etc.)
// trend: 'up' | 'down' | 'stable' | 'unknown'
// For copy 0 (sell first): only use min-1% if min is within 15% of median
// AND market isn't trending up. Otherwise anchor to median to avoid
// throwing away margin on an outlier min price.
function staggerPrice(copyIndex, marketMin, salesMedian7d, trend, settings) {
  const gap = settings.staggerPct ?? 15;

  if (copyIndex === 0) {
    // Only undercut min if it's reasonably close to median (within 15%)
    // and market isn't trending up
    const minFarBelowMedian = marketMin < salesMedian7d * 0.85;
    if (trend === 'up' || minFarBelowMedian) {
      // Anchor to median instead — don't give away margin
      return +(salesMedian7d * 0.98).toFixed(2); // 2% below median to still sell first
    }
    return +(marketMin * 0.99).toFixed(2);
  }
  if (copyIndex === 1) return +salesMedian7d.toFixed(2);
  return +(salesMedian7d * (1 + (gap * (copyIndex - 1)) / 100)).toFixed(2);
}

// ─── Trade lock helpers ───────────────────────────────────────────────────────
// Returns number of days remaining on a trade lock (0 if unlocked / past)
function lockDaysRemaining(lockUntil) {
  if (!lockUntil) return 0;
  const ms = lockUntil - new Date();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

// ─── Main pricing function for one listing ────────────────────────────────────
function analyzeItem({
  listing,              // { name, float, priceSEK, lockUntil }
  marketItem,           // from /v1/items tradable=0 (all incl. locked)
  marketItemTradable,   // from /v1/items tradable=1 (buyable now only)
  history,              // from /v1/sales/history
  buyEntry,             // from Google Sheet { buySEK }
  copyIndex,            // 0-based: which copy of this item is this? (0=first listed)
  totalCopies,          // how many copies you own total
  cachedMarket,         // previous snapshot for flood detection
  settings,             // user settings
}) {
  const result = {
    name:        listing.name,
    float:       listing.float,
    yourPrice:   listing.priceSEK,
    saleId:      listing.saleId,
    lockUntil:   listing.lockUntil || null,  // Date or null
    lockDays:    lockDaysRemaining(listing.lockUntil),
    badges:      [],
    suggested:   null,
    suggestedReason: '',
    analysis:    {},
  };

  // ── Trade lock badge ──
  if (result.lockDays > 0) {
    result.badges.push('locked');
  }

  // ── Market data ──
  // For unlocked listings: use tradable=1 min (real buyable competition)
  // For locked listings:   use tradable=0 min (what market looks like when it unlocks)
  const isLocked        = result.lockDays > 0;
  const activeItem      = isLocked ? marketItem : (marketItemTradable || marketItem);
  const minPrice        = activeItem?.min_price        || null;
  const suggested       = activeItem?.suggested_price  || null;
  const qty             = activeItem?.quantity         || 0;

  // Incoming supply: locked listings dragging min below tradable min
  const minPriceTradable = marketItemTradable?.min_price || null;
  const minPriceAll      = marketItem?.min_price         || null;
  const incomingSupply   = !isLocked
    && minPriceTradable && minPriceAll
    && minPriceAll < minPriceTradable * 0.90; // locked min >10% cheaper than tradable min

  const salesMed7   = history?.last_7_days?.median  || null;
  const salesMed30  = history?.last_30_days?.median || null;
  const salesVol7   = history?.last_7_days?.volume  ?? 0;
  const salesVol30  = history?.last_30_days?.volume ?? 0;

  result.analysis = {
    minPrice,
    minPriceTradable,
    minPriceAll,
    suggested,
    qty,
    salesMed7,
    salesMed30,
    salesVol7,
    salesVol30,
    dailyRate: +(salesVol30 / 30).toFixed(1),
  };

  // ── Incoming supply badge ──
  if (incomingSupply) {
    result.badges.push('incoming_supply');
  }

  // ── Buy price / cost floor ──
  const buySEK = buyEntry?.buySEK || null;
  const floor  = buySEK ? calcFloor(buySEK, settings.minMarginPct ?? 5) : null;
  result.analysis.buySEK = buySEK;
  result.analysis.floor  = floor;

  if (buySEK) {
    const p = calcProfit(buySEK, listing.priceSEK);
    result.analysis.profitSEK = p?.profitSEK;
    result.analysis.profitPct = p?.profitPct;
    result.analysis.netSEK    = p?.netSEK;
  }

  // ── No market data ──
  if (!salesMed7 && !minPrice) {
    result.badges.push('no_data');
    result.suggestedReason = 'No sales history — rare item, price manually';
    return result;
  }

  // ── Flood detection ──
  const flooded = cachedMarket && detectFlood(
    qty,
    cachedMarket.qty,
    minPrice,
    cachedMarket.minPrice,
    settings
  );
  if (flooded) {
    result.badges.push('flood');
    result.suggested = salesMed30 || salesMed7;
    result.suggestedReason = `⚠️ FLOOD DETECTED — temporary supply spike. Hold at 30d median (${(salesMed30 || salesMed7)?.toFixed(2)} SEK). Do not chase min price.`;
    if (floor && result.suggested < floor) {
      result.badges.push('below_cost');
      result.suggested = floor;
      result.suggestedReason += ` (raised to cost floor ${floor.toFixed(2)} SEK)`;
    }
    // Compute profit at suggested price before early return
    if (buySEK && result.suggested) {
      const sp = calcProfit(buySEK, result.suggested);
      result.analysis.profitAtSuggested    = sp?.profitSEK;
      result.analysis.profitPctAtSuggested = sp?.profitPct;
    }
    return result;
  }

  // ── Trend ──
  const trend = detectTrend(history);
  if (trend === 'up')   result.badges.push('trend_up');
  if (trend === 'down') result.badges.push('trend_down');

  // ── Slow mover ──
  const slowMover = isSlowMover(history, settings);
  if (slowMover) result.badges.push('slow');

  // For slow movers, 7d sample is too small to be reliable — use 30d median as anchor
  // For liquid items, 7d is fine
  const priceAnchor     = slowMover && salesMed30 ? salesMed30 : (salesMed7 || salesMed30);
  const anchorLabel     = slowMover && salesMed30 ? '30d median' : '7d median';

  // ── Duplicate stagger ──
  let rawSuggested;
  if (totalCopies > 1 && priceAnchor) {
    result.badges.push('stagger');
    if (slowMover) {
      // Slow mover: don't use min price for copy 1 — it's unreliable
      // Stagger around the anchor instead: -3% / anchor / anchor+gap%
      const gap = settings.staggerPct ?? 15;
      if (copyIndex === 0)      rawSuggested = +(priceAnchor * 0.97).toFixed(2);
      else if (copyIndex === 1) rawSuggested = +priceAnchor.toFixed(2);
      else                      rawSuggested = +(priceAnchor * (1 + (gap * (copyIndex - 1)) / 100)).toFixed(2);
    } else {
      rawSuggested = staggerPrice(copyIndex, minPrice || priceAnchor, priceAnchor, trend, settings);
    }
    result.suggestedReason = `Copy ${copyIndex + 1}/${totalCopies} — staggered pricing (anchor: ${anchorLabel})`;
  } else {
    // Single copy strategy based on trend
    if (!priceAnchor) {
      rawSuggested = minPrice ? +(minPrice * 0.99).toFixed(2) : listing.priceSEK;
    } else if (trend === 'up') {
      // Trending up: hold at anchor — don't undercut
      rawSuggested = +priceAnchor.toFixed(2);
      result.suggestedReason = `Trending up — hold at ${anchorLabel}`;
    } else if (trend === 'down') {
      if (slowMover) {
        // Slow mover trending down: don't panic-undercut min, undercut 30d median slightly
        // Chasing the min on a slow item locks in a bad price for weeks
        rawSuggested = +(priceAnchor * 0.97).toFixed(2);
        result.suggestedReason = `Trending down (slow mover) — 3% below ${anchorLabel}, don't chase min`;
      } else {
        // Liquid item trending down: undercut min to exit fast
        rawSuggested = minPrice ? +(minPrice * 0.99).toFixed(2) : +priceAnchor.toFixed(2);
        result.suggestedReason = `Trending down — undercut min to sell fast`;
      }
    } else {
      // Stable: price at anchor
      rawSuggested = +priceAnchor.toFixed(2);
      result.suggestedReason = `Stable market — priced at ${anchorLabel}`;
    }
  }

  // ── Underwater check — use median not min ──
  // min price can be one trade-locked outlier; median reflects actual market
  // For slow movers use 30d, for liquid use 7d
  const underwaterAnchor = slowMover && salesMed30 ? salesMed30 : salesMed7;

  // ── Apply cost floor ──
  if (floor && rawSuggested < floor) {
    // Underwater check: use sales median (not min price) as the real market signal
    // min price can be one trade-locked outlier; median = what buyers actually paid
    // Slow movers: use 30d median (7d sample too small)
    // Liquid items: use 7d median
    const marketAlsoUnderwater = underwaterAnchor && underwaterAnchor < floor;
    if (marketAlsoUnderwater) {
      result.badges.push('below_cost');
      result.badges.push('underwater');
      const lossAtAnchor = calcProfit(buySEK, underwaterAnchor);
      const lossPctStr   = lossAtAnchor ? `${lossAtAnchor.profitPct.toFixed(1)}%` : '?';
      const lossSign     = lossAtAnchor && lossAtAnchor.profitPct >= 0 ? '+' : '';
      result.suggestedReason = `Market underwater — ${anchorLabel} (${underwaterAnchor.toFixed(2)} SEK) is below your cost floor (${floor.toFixed(2)} SEK). Selling now = ${lossSign}${lossPctStr}. Hold or cut losses.`;
      result.suggested = null;
    } else {
      result.badges.push('below_cost');
      rawSuggested = +floor.toFixed(2);
      result.suggestedReason += ` (raised to cost floor — ${floor.toFixed(2)} SEK)`;
    }
  }

  result.suggested = rawSuggested;

  // ── Compare your current price to suggestion ──
  if (rawSuggested && listing.priceSEK) {
    const diff = (listing.priceSEK - rawSuggested) / rawSuggested * 100;
    if (diff > 10) {
      result.badges.push('overpriced');
    } else if (diff > 3) {
      result.badges.push('slightly_high');
    } else if (diff < -5) {
      result.badges.push('underpriced');
    } else {
      result.badges.push('optimal');
    }
  }

  // ── suggested_price visibility check ──
  if (suggested && rawSuggested > suggested * 1.05) {
    result.badges.push('above_suggested');
  }

  // Profit at suggested price
  if (buySEK && rawSuggested) {
    const sp = calcProfit(buySEK, rawSuggested);
    result.analysis.profitAtSuggested    = sp?.profitSEK;
    result.analysis.profitPctAtSuggested = sp?.profitPct;
  }

  return result;
}

// ─── Analyse all listings ─────────────────────────────────────────────────────
function analyzeAllListings({ listings, marketMap, tradableMap, historyMap, buyMap, cachedMarketSnapshot, settings }) {
  // Group listings by name to detect duplicates
  const groups = new Map();
  for (const listing of listings) {
    if (!groups.has(listing.name)) groups.set(listing.name, []);
    groups.get(listing.name).push(listing);
  }

  const results = [];

  for (const [name, copies] of groups) {
    const marketItem         = marketMap?.get(name)     || null;
    const marketItemTradable = tradableMap?.get(name)   || null;
    const history            = historyMap?.get(name)    || null;
    const cachedMkt          = cachedMarketSnapshot?.[name] || null;

    // Sort copies: unlocked first, locked last (by days remaining ascending)
    const sortedCopies = [...copies].sort((a, b) => {
      const la = a.lockUntil ? lockDaysRemaining(a.lockUntil) : 0;
      const lb = b.lockUntil ? lockDaysRemaining(b.lockUntil) : 0;
      return la - lb;
    });

    sortedCopies.forEach((listing, idx) => {
      const buyEntry = lookupBuyPrice(buyMap, listing.name, listing.float);
      const result   = analyzeItem({
        listing,
        marketItem,
        marketItemTradable,
        history,
        buyEntry,
        copyIndex:    idx,
        totalCopies:  copies.length,
        cachedMarket: cachedMkt,
        settings,
      });
      results.push(result);
    });
  }

  // Sort by urgency: overpriced > below_cost > flood > trending_down > slightly_high > optimal
  // Locked items sink below unlocked items of the same urgency level
  const urgency = r => {
    if (r.badges.includes('below_cost'))    return 0;
    if (r.badges.includes('flood'))         return 1;
    if (r.badges.includes('overpriced'))    return 2;
    if (r.badges.includes('trend_down'))    return 3;
    if (r.badges.includes('slightly_high')) return 4;
    if (r.badges.includes('slow'))          return 5;
    if (r.badges.includes('optimal'))       return 6;
    return 7;
  };
  results.sort((a, b) => {
    const ua = urgency(a);
    const ub = urgency(b);
    if (ua !== ub) return ua - ub;
    // Same urgency: locked items go below unlocked
    const la = a.lockDays > 0 ? 1 : 0;
    const lb = b.lockDays > 0 ? 1 : 0;
    return la - lb;
  });

  return results;
}

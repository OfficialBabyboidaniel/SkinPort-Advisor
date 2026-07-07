# Skinport Advisor — Pricing Decision Tree

> One diagram per listing. Runs inside `analyzeItem()` in `pricing.js`.

```
┌─────────────────────────────────────────────────────────────────┐
│                     analyzeItem()                               │
│                  (runs per listing)                             │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │  Any market data at all? │
              │  (salesMed7 or minPrice) │
              └────────────┬────────────┘
                    NO     │     YES
                    │      │
                    ▼      │
             ┌──────────┐  │
             │ ❓no_data │  │
             │ Manual   │  │
             │ pricing  │  │
             └──────────┘  │
                           ▼
              ┌─────────────────────────┐
              │     Flood detected?      │
              │  qty spike ≥20% AND      │
              │  price drop ≥10%         │
              │  vs last snapshot        │
              └────────────┬────────────┘
                   YES     │     NO
                    │      │
                    ▼      │
          ┌─────────────────────┐
          │ ⚠️ flood             │
          │ Hold at 30d median  │
          │ Ignore min price    │
          └─────────────────────┘
                           │
                           ▼
              ┌─────────────────────────┐
              │     How many copies?     │
              └────────────┬────────────┘
                           │
               ┌───────────┴───────────┐
            2+ copies               1 copy
               │                       │
               ▼                       ▼
   ┌───────────────────────┐  ┌────────────────────┐
   │ 🔱 stagger            │  │   Trend detection  │
   │ Copy 1 → min - 1%    │  │  7d median vs 30d  │
   │ Copy 2 → 7d median   │  └────────┬───────────┘
   │ Copy 3 → median +15% │           │
   └───────────────────────┘    ┌─────┼─────┐
                                │     │     │
                               UP  STABLE  DOWN
                                │     │     │
                                ▼     ▼     ▼
                          ┌──────┐ ┌──────┐ ┌──────────┐
                          │ 📈   │ │      │ │ 📉        │
                          │Hold  │ │Price │ │Undercut   │
                          │at 7d │ │at 7d │ │min - 1%  │
                          │median│ │median│ │exit fast  │
                          └──────┘ └──────┘ └──────────┘
                                       │
                           ────────────┘
                                       │
                                       ▼
                        ┌──────────────────────────┐
                        │     Cost floor check      │
                        │  suggestion < buySEK      │
                        │       / 0.92 × 1.05?      │
                        └─────────────┬────────────┘
                                YES   │    NO
                                 │    │
                                 ▼    ▼
                          ┌───────────────┐
                          │💀 below_cost  │
                          │Raise to floor │
                          └───────────────┘
                                      │
                                      ▼
                        ┌─────────────────────────┐
                        │   Compare to your        │
                        │   current listed price   │
                        └─────────────┬───────────┘
                                      │
              ┌───────────┬───────────┼───────────┬───────────┐
              │           │           │           │           │
           >10%        3-10%       ±3%         <-5%      no price
           above       above      of sug       below
              │           │           │           │
              ▼           ▼           ▼           ▼
        ┌─────────┐ ┌──────────┐ ┌────────┐ ┌──────────┐
        │ 🔴      │ │ 🟡       │ │ ✅     │ │ 💙       │
        │over-    │ │slightly  │ │optimal │ │under-    │
        │priced   │ │high      │ │        │ │priced    │
        └─────────┘ └──────────┘ └────────┘ └──────────┘
                                      │
                                      ▼
                        ┌─────────────────────────┐
                        │   Position column        │
                        │  (spread + trend + vol)  │
                        ├─────────────────────────┤
                        │ profitPct @ suggested:   │
                        │  < 0%  → 💀 Cut losses  │
                        │  0–5%  → 🔴 Sell soon   │
                        │  + trend_down → Sell NOW │
                        │  5–15% → 🟡 Sell/Hold   │
                        │  + trend_up  → Hold      │
                        │  > 15% → 🟢 Room to hold │
                        │  + slow → price compet.  │
                        └─────────────────────────┘
```

---

## Badge Reference

| Badge | Meaning |
|---|---|
| ❓ no_data | No sales history — price manually |
| ⚠️ flood | Temporary supply spike — hold at 30d median |
| 🔱 stagger | Multiple copies — tiered pricing applied |
| 📈 trend_up | 7d median >3% above 30d median |
| 📉 trend_down | 7d median >3% below 30d median |
| 🐢 slow | Vol7d < 5 sales — low liquidity item |
| 💀 below_cost | Suggested price raised to cost floor |
| 🔴 overpriced | Your price >10% above suggestion |
| 🟡 slightly_high | Your price 3–10% above suggestion |
| ✅ optimal | Your price within ±3% of suggestion |
| 💙 underpriced | Your price >5% below suggestion |
| 👁️ above_suggested | Listed >5% above Skinport's suggested_price — hurts visibility |

---

## Fee Structure

| Price range | Fee | Net multiplier |
|---|---|---|
| < 10,000 SEK | 8% | × 0.92 |
| ≥ 10,000 SEK | 6% | × 0.94 |

**Cost floor formula:** `buySEK / 0.92 × 1.05` (break-even + 5% margin target)

---

## Position Column Logic

Combines spread (net margin at suggested price), trend, and volume into a single action signal:

| Net margin @ suggested | Conditions | Signal |
|---|---|---|
| < 0% | — | 💀 Cut losses |
| 0–5% | trend_down or flood | 🔴 Sell immediately |
| 0–5% | — | 🔴 Sell soon |
| 5–15% | trend_up | 🟡 Hold briefly |
| 5–15% | — | 🟡 Sell at median |
| > 15% | slow mover | 🟢 Room to hold (price competitively) |
| > 15% | — | 🟢 Room to hold |

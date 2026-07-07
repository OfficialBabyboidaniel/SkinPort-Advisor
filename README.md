# Skinport Advisor

Chrome extension for CS2 skin pricing advice on Skinport.

## Setup

1. Load in Chrome: `chrome://extensions` → Enable Developer Mode → Load Unpacked → select this folder
2. Open **Settings** tab, enter your Skinport API credentials and Google Sheet ID
3. Make sure you are **logged in to skinport.com** in Chrome
4. Click **Analyze Listings**

## What it does

- Fetches your active Skinport listings
- Pulls live market data: min price, 7d sales median, 30d median, volume
- Reads your buy prices from your Google Sheet (column D = BuySEK)
- Calculates: cost floor (8% fee), profit at each price point
- Detects: overpriced, flood, trend up/down, slow movers, duplicates
- Suggests: optimal price per listing with reason

## Pricing logic (evidence-based)

| Scenario | Strategy |
|---|---|
| Single item, stable | Price at 7d sales median |
| Trending up | Hold at 7d median — don't undercut |
| Trending down | Undercut market min -1% |
| Duplicates (2+) | Stagger: min-1% / median / median+15% |
| Flood detected | Hold at 30d median — ignore suppressed min |
| Below cost floor | Raise to floor = buyPrice / 0.92 × 1.05 |

## Fee structure

- Standard (< 10,000 SEK): **8%**
- High-tier (≥ 10,000 SEK): **6%**

## Sheet columns expected

| Col | Field |
|-----|-------|
| A   | Skin name |
| B   | Buy Price ¥ |
| C   | Buy Price € |
| D   | Buy Price SEK ← used for floor calculations |
| E   | Buy Date |
| F   | Sell € |
| G   | Sell SEK |
| H   | Sell USD |
| I   | Sell Date |
| J   | Float ← used for matching |

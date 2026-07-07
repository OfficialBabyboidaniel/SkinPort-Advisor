// background.js — service worker
// Caches market data to avoid hitting rate limits on every popup open

const CACHE_KEY = 'advisor_market_cache';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_CACHE') {
    chrome.storage.local.get(CACHE_KEY, r => {
      const cache = r[CACHE_KEY] || {};
      sendResponse({ cache });
    });
    return true; // async
  }

  if (msg.type === 'SET_CACHE') {
    chrome.storage.local.get(CACHE_KEY, r => {
      const cache = r[CACHE_KEY] || {};
      cache[msg.key] = { data: msg.data, ts: Date.now() };
      chrome.storage.local.set({ [CACHE_KEY]: cache }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (msg.type === 'CLEAR_CACHE') {
    chrome.storage.local.remove(CACHE_KEY, () => sendResponse({ ok: true }));
    return true;
  }
});

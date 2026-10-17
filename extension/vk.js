/*
 * Beatport → VK Track Search — content script для vk.ru / vk.com.
 *
 * Задача скромная, но без неё поиск не работает: вкладка Beatport не может
 * узнать ID владельца аудио, поэтому ссылка сначала открывается как
 * /audios?q=… . Этот скрипт:
 *
 *   1) запоминает ID из адреса /audios<ID> (chrome.storage.local →
 *      detectedAudioOwnerId) — дальше все кнопки строят адрес сразу с ID;
 *   2) если VK при редиректе потерял параметр q, достраивает его сам
 *      (pendingAudioSearch, живёт 2 минуты).
 */
(function () {
  'use strict';

  if (window.__bp2vkVkLoaded) return;
  window.__bp2vkVkLoaded = true;

  var DEFAULTS = (window.BP2VK && window.BP2VK.DEFAULTS) || {
    enabled: true,
    queryEncoding: 'double'
  };

  var PENDING_TTL = 2 * 60 * 1000;
  var settings = Object.assign({}, DEFAULTS);
  var lastId = '';
  var pendingChecked = false;
  var timer = null;

  function storageGet(area, defaults, callback) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage[area]) {
        chrome.storage[area].get(defaults, function (values) {
          try {
            if (chrome.runtime && chrome.runtime.lastError) {
              callback(defaults);
              return;
            }
          } catch (e) { /* ignore */ }
          callback(values || defaults);
        });
        return;
      }
    } catch (e) { /* ignore */ }
    callback(defaults);
  }

  function storageSet(area, values) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage[area]) {
        chrome.storage[area].set(values);
      }
    } catch (e) { /* ignore */ }
  }

  function encodeQuery(query) {
    if (window.BP2VK && typeof window.BP2VK.encodeQuery === 'function') {
      return window.BP2VK.encodeQuery(query, settings.queryEncoding);
    }
    var once = encodeURIComponent(query);
    return settings.queryEncoding === 'single' ? once : encodeURIComponent(once);
  }

  function ownerIdFromPath() {
    var match = /^\/audios\/?(\d+)/.exec(location.pathname);
    return match ? match[1] : '';
  }

  function buildSearchUrl(ownerId, query) {
    return location.origin + '/audios' + ownerId + '?q=' + encodeQuery(query);
  }

  function currentQuery() {
    try {
      return new URLSearchParams(location.search).get('q') || '';
    } catch (e) {
      return '';
    }
  }

  function resolvePending(ownerId) {
    storageGet('local', { pendingAudioSearch: null }, function (local) {
      var pending = local && local.pendingAudioSearch;
      if (!pending || !pending.query) return;

      // Запись одноразовая: забираем её сразу, чтобы не сработала повторно.
      storageSet('local', { pendingAudioSearch: null });

      if (!(Date.now() - Number(pending.ts) < PENDING_TTL)) return;
      // VK сохранил q при редиректе — вмешиваться не нужно.
      if (currentQuery()) return;

      var url = buildSearchUrl(ownerId, String(pending.query));

      // Событие для отладки и тестов: страница остаётся рабочей, даже если
      // переход по каким-то причинам не случится.
      try {
        document.dispatchEvent(new CustomEvent('bp2vk:repair', {
          detail: { url: url, query: String(pending.query) }
        }));
      } catch (e) { /* ignore */ }

      try {
        location.replace(url);
      } catch (e) { /* ignore */ }
    });
  }

  function refresh() {
    var ownerId = ownerIdFromPath();
    if (!ownerId) return;

    // ID учим один раз: как только адрес стал /audios<ID>.
    var learned = ownerId !== lastId;
    if (learned) {
      lastId = ownerId;
      storageSet('local', { detectedAudioOwnerId: ownerId });
    }

    // Отложенный запрос проверяем при первом запуске и в момент, когда ID
    // появился (в том числе после редиректа внутри одной вкладки).
    if (learned || !pendingChecked) {
      pendingChecked = true;
      resolvePending(ownerId);
    }
  }

  function init() {
    storageGet('sync', DEFAULTS, function (values) {
      settings = Object.assign({}, DEFAULTS, values || {});
      settings.queryEncoding = settings.queryEncoding === 'single' ? 'single' : 'double';
      refresh();
      if (timer) clearInterval(timer);
      timer = setInterval(refresh, 800);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/*
 * Beatport → VK Track Search — content script для beatport.com.
 *
 * Рядом с каждым треком на Beatport добавляется кнопка, открывающая поиск
 * этого трека в аудио VK:
 *
 *   https://vk.ru/audios<ID>?q=<дважды URL-encoded запрос>
 *
 * Разметка Beatport, на которой всё держится (проверено на живых страницах):
 *
 *   1) таблицы — топ-100, лейбл, артист, «другие треки» на странице трека:
 *        div[data-testid="tracks-table-row"]  →  a[href*="/track/"]
 *
 *   2) списки — треклист релиза, топ жанра, плейлисты, а также строки-релизы
 *      («Latest … Releases»), где ссылка ведёт на /release/:
 *        div[class*="Lists-shared-style__ItemMeta"]  →  a[href*="/track/"] | a[href*="/release/"]
 *
 *   3) шапка страницы трека:
 *        div[class*="TrackHeader_meta"]  →  h1[class*="TrackHeader_name"]
 *
 *   4) карточки релизов (сетки и карусели «Latest … Music Releases»):
 *        div[class*="ReleaseCard_wrapper"]  →  span[class*="releaseName"]
 *
 *   5) hero-блок релиза (крупный баннер):
 *        div.hero-release  →  span[class*="HeroRelease_releaseName"]
 *
 * У карточек и hero нет отдельного трека — там ищется релиз целиком:
 * «артист — название релиза». Для синглов это ровно то, что нужно.
 *
 * Название и микс на Beatport лежат в одном элементе: текст самого узла —
 * это название, вложенный <span> — микс. Например
 *   <span class="…ItemName…">Freak<!-- --> <span>Extended Mix</span></span>
 * даёт название «Freak» и микс «Extended Mix».
 */
(function () {
  'use strict';

  if (window.__bp2vkContentLoaded) return;
  window.__bp2vkContentLoaded = true;

  var DEFAULTS = (window.BP2VK && window.BP2VK.DEFAULTS) || {
    enabled: true,
    queryTemplate: '{artist} - {title}',
    openInNewTab: true,
    queryEncoding: 'double',
    audioOwnerId: ''
  };
  var VK_ORIGIN = (window.BP2VK && window.BP2VK.VK_ORIGIN) || 'https://vk.ru';

  var BTN_CLASS = 'bp2vk-btn';
  var BTN_SELECTOR = 'a.' + BTN_CLASS;
  var BTN_ATTR = 'data-bp2vk-btn';
  var KEY_ATTR = 'data-bp2vk-key';
  var QUERY_ATTR = 'data-bp2vk-query';

  // Где Beatport показывает трек или релиз.
  var TABLE_ROW = '[data-testid="tracks-table-row"]';
  var LIST_ITEM = '[class*="Lists-shared-style__ItemMeta"]';
  var TRACK_HEADER = '[class*="TrackHeader_meta"]';
  var RELEASE_CARD = '[class*="ReleaseCard_wrapper"]';
  var RELEASE_HERO = '.hero-release, [class*="HeroRelease_wrapper"]';
  var HOST_SELECTOR = [TABLE_ROW, LIST_ITEM, TRACK_HEADER, RELEASE_CARD, RELEASE_HERO].join(',');

  // Ссылки внутри магазина бывают с языковым префиксом: /track/freak/30500496
  // и /es/track/freak/30500496. Поэтому ищем вхождение, а не начало адреса.
  var TRACK_LINK = 'a[href*="/track/"]';
  var RELEASE_LINK = 'a[href*="/release/"]';
  var NAME_SELECTOR = [
    '[class*="ItemName"]',
    '[class*="ReleaseName"]',
    '[class*="releaseName"]',
    '[class*="TrackHeader_name"]'
  ].join(',');
  var ARTISTS_BOX = [
    '[class*="ArtistNames_artistNames"]',
    '[class*="Artists_items"]',
    '[class*="HeroRelease_artists"]',
    '[class*="ReleasesList-style__Artists"]'
  ].join(',');
  var LABEL_LINK = 'a[href*="/label/"]';
  var ARTIST_LINK = 'a[href*="/artist/"]';
  var CONTROLS_BOX = '[class*="CollectionControls_controls"]';
  var HERO_ACTIONS = '[class*="HeroRelease_actions"]';

  var ICON_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true" focusable="false">' +
    '<circle cx="6.9" cy="6.9" r="4.2" stroke="currentColor" stroke-width="1.7"></circle>' +
    '<path d="M10.2 10.2 14 14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"></path>' +
    '</svg>';

  var settings = {};
  var detectedOwnerId = '';
  var scans = 0;
  var scanTimer = null;
  var routeTimer = null;
  var observer = null;
  var lastRoute = '';

  /* ------------------------------------------------------------------ */
  /* Мелкие помощники                                                    */
  /* ------------------------------------------------------------------ */

  function qsa(selector, root) {
    var out = [];
    var scope = root || document;
    try {
      out = Array.prototype.slice.call(scope.querySelectorAll(selector));
    } catch (e) {
      out = [];
    }
    return out;
  }

  function normalizeText(value) {
    if (window.BP2VK && typeof window.BP2VK.normalizeText === 'function') {
      return window.BP2VK.normalizeText(value);
    }
    return String(value == null ? '' : value)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ------------------------------------------------------------------ */
  /* Настройки                                                           */
  /* ------------------------------------------------------------------ */

  function applySettings(values) {
    settings = Object.assign({}, DEFAULTS, values || {});

    settings.enabled = settings.enabled !== false;
    settings.openInNewTab = settings.openInNewTab !== false;
    settings.queryEncoding = settings.queryEncoding === 'single' ? 'single' : 'double';

    var template = normalizeText(settings.queryTemplate);
    // Шаблон обязан содержать название трека, иначе поиск теряет смысл.
    if (!template || template.indexOf('{title}') === -1) template = DEFAULTS.queryTemplate;
    settings.queryTemplate = template;

    settings.audioOwnerId = String(settings.audioOwnerId || '').trim();
    if (!/^\d{1,20}$/.test(settings.audioOwnerId)) settings.audioOwnerId = '';
  }

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

  /* ------------------------------------------------------------------ */
  /* Адрес поиска в VK                                                   */
  /* ------------------------------------------------------------------ */

  function currentOwnerId() {
    return settings.audioOwnerId || detectedOwnerId || '';
  }

  function encodeQuery(query) {
    if (window.BP2VK && typeof window.BP2VK.encodeQuery === 'function') {
      return window.BP2VK.encodeQuery(query, settings.queryEncoding);
    }
    // VK кодирует параметр поиска ещё раз, поэтому в адресах сайта пробел
    // выглядит как %2520, а не %20.
    var once = encodeURIComponent(query);
    return settings.queryEncoding === 'single' ? once : encodeURIComponent(once);
  }

  function buildSearchUrl(query) {
    if (window.BP2VK && typeof window.BP2VK.buildSearchUrl === 'function') {
      return window.BP2VK.buildSearchUrl(query, currentOwnerId(), settings.queryEncoding);
    }
    return VK_ORIGIN + '/audios' + currentOwnerId() + '?q=' + encodeQuery(query);
  }

  // Если ID владельца аудио ещё не известен, запоминаем запрос: vk.js на
  // открывшейся странице VK достроит ?q=, если VK потеряет его при редиректе.
  function rememberPendingSearch(query) {
    query = normalizeText(query);
    if (!query) return;
    storageSet('local', {
      pendingAudioSearch: { query: query, ts: Date.now() }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Чтение трека из разметки Beatport                                   */
  /* ------------------------------------------------------------------ */

  // Название — текст самого узла, микс — текст вложенного <span>.
  function splitName(node) {
    var title = [];
    var mix = [];
    if (node) {
      Array.prototype.forEach.call(node.childNodes, function (child) {
        if (child.nodeType === 3) {
          title.push(child.nodeValue || '');
          return;
        }
        if (child.nodeType !== 1) return;
        var tag = child.tagName;
        if (tag === 'SPAN') {
          mix.push(child.textContent || '');
          return;
        }
        if (tag === 'SVG' || tag === 'BUTTON' || tag === 'IMG' || tag === 'USE') return;
        title.push(child.textContent || '');
      });
    }
    return { title: normalizeText(title.join(' ')), mix: normalizeText(mix.join(' ')) };
  }

  function parseEntityId(href) {
    var value = String(href || '');
    var match = /\/track\/(?:[^\/?#]+\/)?(\d+)/.exec(value);
    if (match) return match[1];
    match = /\/release\/(?:[^\/?#]+\/)?(\d+)/.exec(value);
    return match ? match[1] : '';
  }

  function readArtists(host) {
    var box = host.querySelector(ARTISTS_BOX) || host;
    var artists = [];
    var seen = {};
    qsa(ARTIST_LINK, box).forEach(function (link) {
      var name = normalizeText(link.getAttribute('title') || link.textContent);
      if (!name) return;
      var key = name.toLowerCase();
      if (seen[key]) return;
      seen[key] = 1;
      artists.push(name);
    });
    return artists;
  }

  /*
   * Название ищется по нескольким классам, и среди них бывают обёртки
   * (например ReleaseCard_releaseNameWrapper и ReleaseCard_releaseName).
   * Берём самый вложенный кандидат — это и есть сам текст названия.
   */
  function findNameNode(host) {
    var nodes = qsa(NAME_SELECTOR, host);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var containsAnother = false;
      for (var j = 0; j < nodes.length; j++) {
        if (i !== j && node.contains(nodes[j])) {
          containsAnother = true;
          break;
        }
      }
      if (!containsAnother) return node;
    }
    return null;
  }

  function readInfo(host, kind) {
    // У трека ссылка ведёт на /track/, у релиза — на /release/.
    var anchor = host.querySelector(TRACK_LINK) || host.querySelector(RELEASE_LINK);
    var nameNode = findNameNode(host);

    var parsed = splitName(nameNode);
    var title = parsed.title;
    var mix = parsed.mix;

    if (!title && nameNode) title = normalizeText(nameNode.textContent);
    if (!title && anchor) title = normalizeText(anchor.getAttribute('title'));
    if (!title) return null;

    var labelLink = host.querySelector(LABEL_LINK);

    // Кнопку ставим вплотную к названию, поэтому нужна именно ссылка названия,
    // а не первая ссылка в контейнере (у карточки это обложка).
    var nameAnchor = null;
    if (nameNode && typeof nameNode.closest === 'function') nameAnchor = nameNode.closest('a');
    if (!nameAnchor) nameAnchor = anchor;

    var ownHref = (nameAnchor && nameAnchor.getAttribute('href')) ||
      (anchor && anchor.getAttribute('href')) || '';
    var entityId = kind === 'header'
      ? parseEntityId(location.pathname) || parseEntityId(ownHref)
      : parseEntityId(ownHref) || parseEntityId(location.pathname);

    return {
      title: title,
      mix: mix,
      artists: readArtists(host),
      label: labelLink ? normalizeText(labelLink.getAttribute('title') || labelLink.textContent) : '',
      entityId: entityId,
      nameAnchor: nameAnchor,
      nameNode: nameNode,
      kind: kind,
      host: host
    };
  }

  /* ------------------------------------------------------------------ */
  /* Поисковый запрос                                                    */
  /* ------------------------------------------------------------------ */

  function buildQuery(info) {
    if (window.BP2VK && typeof window.BP2VK.renderQuery === 'function') {
      return window.BP2VK.renderQuery(info, settings);
    }
    var artists = info.artists || [];
    return normalizeText([artists.join(', '), info.title || ''].join(' - '))
      .replace(/^[\s\-–—]+/, '')
      .trim();
  }

  /* ------------------------------------------------------------------ */
  /* Кнопка                                                              */
  /* ------------------------------------------------------------------ */

  function buttonTitle(query) {
    return 'Найти «' + query + '» в аудио VK';
  }

  function stopPropagation(event) {
    event.stopPropagation();
  }

  function onPressStart(event) {
    event.stopPropagation();
    var button = event.currentTarget;
    if (currentOwnerId()) return;
    rememberPendingSearch(button.getAttribute(QUERY_ATTR) || '');
  }

  function onButtonClick(event) {
    var button = event.currentTarget;
    event.stopPropagation();

    var query = normalizeText(button.getAttribute(QUERY_ATTR));
    if (!query) return;

    // ID мог появиться уже после отрисовки кнопки — пересчитываем адрес.
    var url = buildSearchUrl(query);
    if (button.getAttribute('href') !== url) button.setAttribute('href', url);
    if (!currentOwnerId()) rememberPendingSearch(query);

    // openInNewTab = false: ничего не делаем, переход по href откроется в
    // текущей вкладке (target у такой кнопки не выставлен).
  }

  function createButton(info) {
    var query = buildQuery(info);
    if (!query) return null;

    var button = document.createElement('a');
    button.className = BTN_CLASS;
    button.setAttribute(BTN_ATTR, '');
    button.setAttribute('aria-label', buttonTitle(query));
    button.title = buttonTitle(query);
    button.setAttribute(QUERY_ATTR, query);
    button.setAttribute(KEY_ATTR, info.entityId || query);
    button.innerHTML = ICON_SVG;

    button.addEventListener('mousedown', onPressStart);
    button.addEventListener('pointerdown', onPressStart);
    button.addEventListener('mouseup', stopPropagation);
    button.addEventListener('click', onButtonClick);
    button.addEventListener('auxclick', onPressStart);

    syncButton(button, info);
    return button;
  }

  function syncButton(button, info) {
    var query = buildQuery(info);
    if (!query) return;

    var url = buildSearchUrl(query);
    if (button.getAttribute('href') !== url) button.setAttribute('href', url);

    if (settings.openInNewTab) {
      if (button.getAttribute('target') !== '_blank') button.setAttribute('target', '_blank');
      if (button.getAttribute('rel') !== 'noopener noreferrer') {
        button.setAttribute('rel', 'noopener noreferrer');
      }
    } else {
      if (button.hasAttribute('target')) button.removeAttribute('target');
      if (button.hasAttribute('rel')) button.removeAttribute('rel');
    }

    var title = buttonTitle(query);
    if (button.title !== title) button.title = title;
    if (button.getAttribute('aria-label') !== title) button.setAttribute('aria-label', title);

    if (button.getAttribute(QUERY_ATTR) !== query) button.setAttribute(QUERY_ATTR, query);
  }

  function insertionPoint(info) {
    // В шапке трека и в hero-релизе есть готовый ряд кнопок — встаём в него.
    if (info.kind === 'header') {
      var controls = info.host.querySelector(CONTROLS_BOX);
      if (controls) return { parent: controls, before: null };
    }
    if (info.kind === 'hero') {
      var actions = info.host.querySelector(HERO_ACTIONS);
      if (actions) return { parent: actions, before: null };
    }

    // Во всех остальных случаях — сразу после ссылки с названием.
    var anchor = info.nameAnchor;
    if (anchor && anchor.parentElement) {
      return { parent: anchor.parentElement, before: anchor.nextSibling };
    }

    var heading = info.host.querySelector('h1');
    if (heading && heading.parentElement) {
      return { parent: heading.parentElement, before: heading.nextSibling };
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Разметка страницы                                                   */
  /* ------------------------------------------------------------------ */

  function hosts() {
    var found = [];

    function push(host, kind) {
      if (!host) return;
      // Вложенные контейнеры не дублируем: одна кнопка на одну сущность.
      for (var i = 0; i < found.length; i++) {
        if (found[i].host === host || found[i].host.contains(host)) return;
      }
      found.push({ host: host, kind: kind });
    }

    qsa(TABLE_ROW).forEach(function (row) {
      push(row, 'row');
    });

    qsa(LIST_ITEM).forEach(function (meta) {
      // Строка таблицы может содержать такие же мета-блоки — не дублируем.
      if (meta.closest(TABLE_ROW)) return;
      push(meta, 'row');
    });

    qsa(TRACK_HEADER).forEach(function (meta) {
      push(meta, 'header');
    });

    // Карточки и hero-блоки релизов: отдельного трека в них нет, поэтому
    // ищем релиз целиком — «артист — название релиза».
    qsa(RELEASE_CARD).forEach(function (card) {
      push(card, 'card');
    });

    qsa(RELEASE_HERO).forEach(function (hero) {
      push(hero, 'hero');
    });

    return found;
  }

  function pruneButtons(handled) {
    qsa(BTN_SELECTOR).forEach(function (button) {
      var host = button.closest(HOST_SELECTOR);
      if (!host || handled.indexOf(host) === -1) {
        if (button.parentNode) button.parentNode.removeChild(button);
      }
    });
  }

  function scan() {
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }

    if (!settings.enabled) {
      removeAllButtons();
      return;
    }

    var handled = [];

    hosts().forEach(function (entry) {
      var info = readInfo(entry.host, entry.kind);
      if (!info) return;
      if (!buildQuery(info)) return;

      handled.push(entry.host);

      var button = entry.host.querySelector(BTN_SELECTOR);
      if (button) {
        syncButton(button, info);
        return;
      }

      var point = insertionPoint(info);
      if (!point) return;

      var created = createButton(info);
      if (!created) return;

      if (point.before && point.before.parentNode === point.parent) {
        point.parent.insertBefore(created, point.before);
      } else {
        point.parent.appendChild(created);
      }
    });

    pruneButtons(handled);

    // Отметка для отладки и тестов: сколько раз страница уже просмотрена.
    scans += 1;
    document.documentElement.setAttribute('data-bp2vk-scans', String(scans));
    document.documentElement.classList.add('bp2vk-ready');
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(scan, 200);
  }

  function removeAllButtons() {
    qsa(BTN_SELECTOR).forEach(function (button) {
      if (button.parentNode) button.parentNode.removeChild(button);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Жизненный цикл                                                      */
  /* ------------------------------------------------------------------ */

  function startWatching() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(function () {
      scheduleScan();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopWatching() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  function checkRoute() {
    var route = location.pathname + location.search;
    if (route === lastRoute) return;
    lastRoute = route;
    scan();
  }

  function applyEnabledState() {
    document.documentElement.classList.toggle('bp2vk-disabled', !settings.enabled);
    if (settings.enabled) {
      startWatching();
      scheduleScan();
    } else {
      stopWatching();
      removeAllButtons();
    }
  }

  function watchSettings() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
      chrome.storage.onChanged.addListener(function (changes, area) {
        var relevant = false;
        Object.keys(changes || {}).forEach(function (key) {
          if (area === 'sync' && Object.prototype.hasOwnProperty.call(DEFAULTS, key)) relevant = true;
          if (area === 'local' && key === 'detectedAudioOwnerId') relevant = true;
        });
        if (!relevant) return;

        if (area === 'local' && changes.detectedAudioOwnerId) {
          detectedOwnerId = String(changes.detectedAudioOwnerId.newValue || '');
          // ID изменился — обновляем адреса уже нарисованных кнопок.
          qsa(BTN_SELECTOR).forEach(function (button) {
            var query = button.getAttribute(QUERY_ATTR) || '';
            if (!query) return;
            var url = buildSearchUrl(query);
            if (button.getAttribute('href') !== url) button.setAttribute('href', url);
          });
          return;
        }

        applySettings(readSettingsFromChanges(changes));
        applyEnabledState();
        scan();
      });
    } catch (e) { /* ignore */ }
  }

  // Собирает актуальные настройки из события chrome.storage.onChanged.
  function readSettingsFromChanges(changes) {
    var next = Object.assign({}, settings);
    Object.keys(changes || {}).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return;
      next[key] = changes[key].newValue;
    });
    return next;
  }

  function init() {
    lastRoute = location.pathname + location.search;

    storageGet('sync', DEFAULTS, function (values) {
      applySettings(values);
      storageGet('local', { detectedAudioOwnerId: '' }, function (local) {
        detectedOwnerId = String((local && local.detectedAudioOwnerId) || '');
        applyEnabledState();
        scan();

        watchSettings();
        startWatching();

        if (routeTimer) clearInterval(routeTimer);
        routeTimer = setInterval(checkRoute, 800);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

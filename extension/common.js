/*
 * Beatport → VK Track Search — общая часть.
 *
 * Здесь лежат значения по умолчанию и единственная реализация того, как из
 * данных трека Beatport получается поисковый запрос и адрес поиска в VK.
 * Файл подключается первым и в content script (content.js / vk.js),
 * и на страницу настроек.
 */
(function () {
  'use strict';

  var VERSION = '1.1.0';

  var DEFAULTS = {
    // Включено ли расширение целиком.
    enabled: true,
    // Шаблон поискового запроса. Подстановки: {artist}, {artists}, {title}, {mix}, {label}.
    queryTemplate: '{artist} - {title}',
    // Открывать поиск VK в новой вкладке.
    openInNewTab: true,
    // VK кодирует параметр поиска дважды: пробел выглядит как %2520.
    queryEncoding: 'double',
    // Ручной ID владельца аудио (число из адреса vk.ru/audios<ID>).
    audioOwnerId: ''
  };

  var VK_ORIGIN = 'https://vk.ru';

  function normalizeText(value) {
    return String(value == null ? '' : value)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /*
   * Собирает поисковый запрос из данных трека.
   * info: { artists: [...], title, mix, label }
   */
  function renderQuery(info, options) {
    var opts = options || {};
    var template = normalizeText(opts.queryTemplate) || DEFAULTS.queryTemplate;
    if (template.indexOf('{title}') === -1) template = DEFAULTS.queryTemplate;

    var data = info || {};
    var artists = Array.isArray(data.artists) ? data.artists : [];
    var mix = normalizeText(data.mix);

    // Микса нет — убираем и скобки вокруг него, чтобы не получить «()».
    if (!mix) template = template.replace(/\s*\(\s*\{mix\}\s*\)/g, '');

    var query = template
      .replace(/\{artist\}/g, artists[0] || '')
      .replace(/\{artists\}/g, artists.join(', '))
      .replace(/\{title\}/g, normalizeText(data.title))
      .replace(/\{mix\}/g, mix)
      .replace(/\{label\}/g, normalizeText(data.label));

    return normalizeText(query)
      .replace(/\(\s*\)/g, '')
      .replace(/\s+([,;])/g, '$1')
      .replace(/^[\s\-–—:,.]+/, '')
      .replace(/[\s\-–—:,]+$/, '')
      .replace(/\(\s*\)/g, '')
      .trim();
  }

  /*
   * Кодирование параметра q. VK декодирует его дважды, поэтому в адресах,
   * которые генерирует сам сайт, пробел выглядит как %2520.
   */
  function encodeQuery(query, encoding) {
    var once = encodeURIComponent(String(query == null ? '' : query));
    return encoding === 'single' ? once : encodeURIComponent(once);
  }

  /*
   * Адрес страницы музыки с заполненным поиском.
   * ownerId может быть пустым — тогда VK сам подставит ID при редиректе,
   * а vk.js достроит параметр q, если тот потеряется.
   */
  function buildSearchUrl(query, ownerId, encoding) {
    var id = /^\d{1,20}$/.test(String(ownerId || '')) ? String(ownerId) : '';
    return VK_ORIGIN + '/audios' + id + '?q=' + encodeQuery(query, encoding);
  }

  window.BP2VK = window.BP2VK || {};
  window.BP2VK.VERSION = VERSION;
  window.BP2VK.DEFAULTS = DEFAULTS;
  window.BP2VK.VK_ORIGIN = VK_ORIGIN;
  window.BP2VK.normalizeText = normalizeText;
  window.BP2VK.renderQuery = renderQuery;
  window.BP2VK.encodeQuery = encodeQuery;
  window.BP2VK.buildSearchUrl = buildSearchUrl;
})();

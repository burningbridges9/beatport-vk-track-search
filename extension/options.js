/*
 * Страница настроек: читает и сохраняет chrome.storage.sync, показывает
 * предпросмотр запроса и адреса поиска.
 */
(function () {
  'use strict';

  var API = window.BP2VK || {};
  var DEFAULTS = API.DEFAULTS || {
    enabled: true,
    queryTemplate: '{artist} - {title}',
    openInNewTab: true,
    queryEncoding: 'double',
    audioOwnerId: ''
  };

  // Пример из разметки Beatport: несколько артистов и микс.
  var SAMPLE = {
    artists: ['Chromeo', 'Chris Lorenzo'],
    title: 'Fancy Footwork',
    mix: 'Extended Mix',
    label: 'Turbo Blanco'
  };

  var form = document.getElementById('settings');
  var el = {
    enabled: document.getElementById('enabled'),
    queryTemplate: document.getElementById('queryTemplate'),
    openInNewTab: document.getElementById('openInNewTab'),
    queryEncoding: document.getElementById('queryEncoding'),
    audioOwnerId: document.getElementById('audioOwnerId'),
    detected: document.getElementById('detected'),
    preview: document.getElementById('preview'),
    previewUrl: document.getElementById('previewUrl'),
    presets: document.getElementById('presets'),
    reset: document.getElementById('reset'),
    status: document.getElementById('status'),
    version: document.getElementById('version')
  };

  var settings = Object.assign({}, DEFAULTS);
  var detectedOwnerId = '';
  var saveTimer = null;
  var statusTimer = null;

  function normalize(value) {
    return API.normalizeText ? API.normalizeText(value) : String(value || '').trim();
  }

  function queryFromSettings(candidate) {
    if (typeof API.renderQuery === 'function') return API.renderQuery(SAMPLE, candidate);
    return '';
  }

  function ownerIdForUrl() {
    if (/^\d{1,20}$/.test(normalize(settings.audioOwnerId))) return settings.audioOwnerId;
    return detectedOwnerId;
  }

  function searchUrlFor(query, candidate) {
    var source = candidate || settings;
    if (typeof API.buildSearchUrl === 'function') {
      return API.buildSearchUrl(query, ownerIdForUrl(), source.queryEncoding);
    }
    return 'https://vk.ru/audios?q=' + encodeURIComponent(query);
  }

  function flash(text) {
    if (!el.status) return;
    el.status.textContent = text;
    el.status.classList.add('visible');
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(function () {
      el.status.classList.remove('visible');
    }, 1800);
  }

  function isTemplateValid(template) {
    return normalize(template).indexOf('{title}') !== -1;
  }

  function renderPreview() {
    var candidate = {
      queryTemplate: el.queryTemplate.value,
      queryEncoding: el.queryEncoding.value
    };
    var query = queryFromSettings(candidate);

    if (el.preview) {
      el.preview.textContent = query
        ? 'Запрос для VK: ' + query
        : 'Запрос для VK: —';
    }
    if (el.previewUrl) {
      el.previewUrl.textContent = query
        ? searchUrlFor(query, candidate)
        : 'Ссылка появится, когда в шаблоне будет {title}';
    }

    el.queryTemplate.classList.toggle('invalid', !isTemplateValid(el.queryTemplate.value));

    if (el.presets) {
      Array.prototype.forEach.call(el.presets.querySelectorAll('.chip'), function (chip) {
        chip.classList.toggle('active', chip.getAttribute('data-template') === el.queryTemplate.value);
      });
    }
  }

  function readForm() {
    return {
      enabled: el.enabled.checked,
      queryTemplate: el.queryTemplate.value,
      openInNewTab: el.openInNewTab.checked,
      queryEncoding: el.queryEncoding.value,
      audioOwnerId: normalize(el.audioOwnerId.value)
    };
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      var values = readForm();
      settings = Object.assign({}, settings, values);

      if (!isTemplateValid(values.queryTemplate)) {
        flash('В шаблоне нужен {title}');
        return;
      }

      try {
        chrome.storage.sync.set(values, function () {
          flash('Сохранено');
        });
      } catch (e) {
        flash('Не удалось сохранить');
      }
    }, 220);
  }

  function fillForm() {
    el.enabled.checked = settings.enabled !== false;
    el.queryTemplate.value = normalize(settings.queryTemplate) || DEFAULTS.queryTemplate;
    el.openInNewTab.checked = settings.openInNewTab !== false;
    el.queryEncoding.value = settings.queryEncoding === 'single' ? 'single' : 'double';
    el.audioOwnerId.value = settings.audioOwnerId || '';
  }

  function renderDetected() {
    if (!el.detected) return;
    if (/^\d{1,20}$/.test(detectedOwnerId)) {
      el.detected.innerHTML = 'ID владельца аудио определён автоматически: <b>' +
        detectedOwnerId + '</b>. Если это чужой ID, впишите свой в поле выше.';
      return;
    }
    el.detected.textContent =
      'ID владельца аудио пока неизвестен. Откройте свою музыку на vk.ru — ' +
      'расширение запомнит ID из адреса и подставит его в ссылки.';
  }

  function bindEvents() {
    [el.enabled, el.openInNewTab, el.queryEncoding].forEach(function (node) {
      node.addEventListener('change', scheduleSave);
    });

    [el.queryTemplate, el.audioOwnerId].forEach(function (node) {
      node.addEventListener('input', function () {
        renderPreview();
        scheduleSave();
      });
    });

    if (el.presets) {
      el.presets.addEventListener('click', function (event) {
        var chip = event.target.closest('.chip');
        if (!chip) return;
        el.queryTemplate.value = chip.getAttribute('data-template');
        renderPreview();
        scheduleSave();
      });
    }

    if (el.reset) {
      el.reset.addEventListener('click', function () {
        settings = Object.assign({}, DEFAULTS);
        detectedOwnerId = detectedOwnerId || '';
        fillForm();
        renderPreview();
        try {
          chrome.storage.sync.set(DEFAULTS, function () {
            flash('Настройки сброшены');
          });
        } catch (e) { /* ignore */ }
      });
    }

    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
      });
    }
  }

  function init() {
    if (el.version && API.VERSION) el.version.textContent = API.VERSION;

    bindEvents();

    try {
      chrome.storage.sync.get(DEFAULTS, function (values) {
        settings = Object.assign({}, DEFAULTS, values || {});
        fillForm();
        renderPreview();

        chrome.storage.local.get({ detectedAudioOwnerId: '' }, function (local) {
          detectedOwnerId = String((local && local.detectedAudioOwnerId) || '');
          renderDetected();
          renderPreview();
        });
      });
    } catch (e) {
      fillForm();
      renderPreview();
    }
  }

  init();
})();

/*
 * Тесты расширения Beatport → VK Track Search на jsdom.
 *
 * Страница поднимается из test/fixture.html — это разметка Beatport, снятая
 * с живых страниц (таблица топ-100, треклист релиза, шапка страницы трека,
 * карточки релизов и hero-блок). Скрипты расширения выполняются в окне
 * jsdom, после чего проверяется получившийся DOM и chrome.storage.
 *
 * Ожидания построены на условиях, а не на фиксированных паузах: content.js
 * пишет на <html> счётчик сканирований data-bp2vk-scans, поэтому тест ждёт
 * «страница пересканирована», а не «прошло 400 мс».
 *
 * Запуск:
 *   node test/run-tests.mjs
 * (jsdom лежит в test/.deps)
 */
import { existsSync, readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPS = path.join(HERE, '.deps', 'node_modules');
const PNPM_DEPS = path.join(DEPS, '.pnpm', 'node_modules');

if (existsSync(PNPM_DEPS)) {
  process.env.NODE_PATH = PNPM_DEPS;
  Module._initPaths();
}

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require(path.join(DEPS, 'jsdom'));

const EXTENSION = path.join(HERE, '..', 'extension');
const FIXTURE_HTML = readFileSync(path.join(HERE, 'fixture.html'), 'utf8');
const LOCALE_FIXTURE_HTML = readFileSync(path.join(HERE, 'fixture-locale.html'), 'utf8');
// URL как у настоящей страницы Beatport: history.pushState и location.origin
// должны вести себя так же, как в браузере (file:// этого не позволяет).
const FIXTURE_URL = 'https://www.beatport.com/genre/bass-house/91/top-100';

const SOURCES = {
  common: readFileSync(path.join(EXTENSION, 'common.js'), 'utf8'),
  content: readFileSync(path.join(EXTENSION, 'content.js'), 'utf8'),
  vk: readFileSync(path.join(EXTENSION, 'vk.js'), 'utf8'),
  optionsJs: readFileSync(path.join(EXTENSION, 'options.js'), 'utf8'),
  optionsHtml: readFileSync(path.join(EXTENSION, 'options.html'), 'utf8'),
  manifest: JSON.parse(readFileSync(path.join(EXTENSION, 'manifest.json'), 'utf8')),
};

let checks = 0;
let failures = 0;

function check(name, condition, extra) {
  checks++;
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : ''));
  }
}

/* ------------------------------------------------------------------ */
/* Заглушка chrome.storage                                             */
/* ------------------------------------------------------------------ */

function makeChrome(settings, local) {
  const syncStore = Object.assign({}, settings);
  const localStore = Object.assign({}, local);
  const state = {
    syncStore,
    localStore,
    syncWrites: [],
    localWrites: [],
    listeners: [],
    emit(changes, area) {
      state.listeners.forEach((listener) => listener(changes, area));
    },
  };

  function pick(store, defaults) {
    const out = {};
    Object.keys(defaults || {}).forEach((key) => {
      out[key] = Object.prototype.hasOwnProperty.call(store, key) ? store[key] : defaults[key];
    });
    Object.keys(store).forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = store[key];
    });
    return out;
  }

  function area(store, writes) {
    return {
      get(defaults, callback) {
        setTimeout(() => callback(pick(store, defaults || {})), 0);
      },
      set(values, callback) {
        Object.assign(store, values);
        writes.push(Object.assign({}, values));
        if (callback) setTimeout(callback, 0);
      },
    };
  }

  const chrome = {
    runtime: { lastError: null, openOptionsPage() {} },
    storage: {
      sync: area(syncStore, state.syncWrites),
      local: area(localStore, state.localWrites),
      onChanged: {
        addListener(listener) {
          state.listeners.push(listener);
        },
      },
    },
  };

  chrome.__state = state;
  return chrome;
}

/* ------------------------------------------------------------------ */
/* Ожидания                                                            */
/* ------------------------------------------------------------------ */

function waitFor(predicate, timeout = 5000, step = 20) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeout;
    (function tick() {
      let value = false;
      try {
        value = predicate();
      } catch (e) {
        value = false;
      }
      if (value) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, step);
    })();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const IGNORED = [/Not implemented: navigation/i];

function filterErrors(errors) {
  return errors.filter((message) => !IGNORED.some((re) => re.test(message)));
}

function scanCount(window) {
  return Number(window.document.documentElement.getAttribute('data-bp2vk-scans') || 0);
}

// Любое изменение DOM заставляет расширение перечитать страницу; ждём именно
// этого, а не «сколько-то миллисекунд».
async function afterMutation(window) {
  const before = scanCount(window);
  const marker = window.document.createElement('i');
  marker.setAttribute('data-test-marker', '');
  window.document.body.appendChild(marker);
  return waitFor(() => scanCount(window) > before);
}

/* ------------------------------------------------------------------ */
/* Запуск страниц                                                      */
/* ------------------------------------------------------------------ */

async function bootBeatport(options = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(String((error && error.message) || error)));

  const dom = new JSDOM(options.fixture || FIXTURE_HTML, {
    url: options.url || FIXTURE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.chrome = makeChrome(options.settings || {}, options.local || {});
    },
  });

  const { window } = dom;
  window.eval(SOURCES.common);
  window.eval(SOURCES.content);

  const ready = await waitFor(() => scanCount(window) > 0);

  return { dom, window, chrome: window.chrome, errors: filterErrors(errors), ready };
}

async function bootVk(options = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(String((error && error.message) || error)));

  const dom = new JSDOM('<!doctype html><html><body><main id="page"></main></body></html>', {
    url: options.url || 'https://vk.ru/audios123456789',
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      window.chrome = makeChrome(options.settings || {}, options.local || {});
      window.__repairs = [];
      window.document.addEventListener('bp2vk:repair', (event) => {
        window.__repairs.push(event.detail && event.detail.url);
      });
    },
  });

  const { window } = dom;
  window.eval(SOURCES.common);
  window.eval(SOURCES.vk);

  // Даём скрипту прочитать настройки и разобрать отложенный запрос.
  await waitFor(() => window.chrome.__state.localWrites.length > 0 ||
    window.__repairs.length > 0, 3000);
  await sleep(80);

  return { dom, window, chrome: window.chrome, errors: filterErrors(errors) };
}

async function bootOptions(options = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(String((error && error.message) || error)));

  const dom = new JSDOM(SOURCES.optionsHtml, {
    url: pathToFileURL(path.join(EXTENSION, 'options.html')).href,
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      window.chrome = makeChrome(options.settings || {}, options.local || {});
    },
  });

  const { window } = dom;
  window.eval(SOURCES.common);
  window.eval(SOURCES.optionsJs);

  await waitFor(() => {
    const node = window.document.getElementById('previewUrl');
    return !!node && node.textContent.indexOf('https://vk.ru/audios') === 0;
  });

  return { dom, window, chrome: window.chrome, errors: filterErrors(errors) };
}

/* ------------------------------------------------------------------ */
/* Помощники для проверок                                              */
/* ------------------------------------------------------------------ */

function buttons(window, scope) {
  const root = scope ? window.document.querySelector(scope) : window.document;
  if (!root) return [];
  return Array.from(root.querySelectorAll('a.bp2vk-btn'));
}

function queries(window, scope) {
  return buttons(window, scope).map((button) => button.getAttribute('data-bp2vk-query'));
}

function scopeCounts(window) {
  return {
    table: buttons(window, '#table-rows').length,
    list: buttons(window, '#list-rows').length,
    header: buttons(window, '#track-header').length,
    cards: buttons(window, '#cards').length,
    hero: buttons(window, '#hero').length,
    releaseList: buttons(window, '#release-list').length,
    total: buttons(window).length,
  };
}

/* ------------------------------------------------------------------ */
/* Тесты                                                               */
/* ------------------------------------------------------------------ */

async function testLayoutAndDefaults() {
  console.log('\n[1] Разметка Beatport и запрос по умолчанию');
  const { dom, window, errors, ready } = await bootBeatport();

  check('страница поднялась без ошибок', errors.length === 0, errors);
  check('content script просканировал страницу', ready === true);

  const counts = scopeCounts(window);
  check('таблица: 3 кнопки', counts.table === 3, counts);
  check('треклист-список: 2 кнопки', counts.list === 2, counts);
  check('шапка трека: 1 кнопка', counts.header === 1, counts);
  check('карточка релиза: 1 кнопка', counts.cards === 1, counts);
  check('hero-блок релиза: 1 кнопка', counts.hero === 1, counts);
  check('строка-релиз в списке: 1 кнопка', counts.releaseList === 1, counts);
  check('всего 9 кнопок', counts.total === 9, counts);

  const tableQueries = queries(window, '#table-rows');
  check('таблица, строка 1: первый артист + название', tableQueries[0] === 'Ink - Freak', tableQueries);
  check('таблица, строка 2: без микса', tableQueries[1] === 'Space Motion - Push & Pull', tableQueries);
  check(
    'таблица, строка 3: скобки в имени артиста сохранены',
    tableQueries[2] === 'Magdalena (DE) - Tell Me How You Want It',
    tableQueries
  );

  const listQueries = queries(window, '#list-rows');
  check('список: Chromeo - Fancy Footwork', listQueries[0] === 'Chromeo - Fancy Footwork', listQueries);
  check('список: Kepler (UK) - Inner Motion', listQueries[1] === 'Kepler (UK) - Inner Motion', listQueries);
  check('шапка трека: Ink - Freak', queries(window, '#track-header')[0] === 'Ink - Freak');

  const first = buttons(window, '#table-rows')[0];
  check(
    'ссылка без известного ID ведёт на /audios?q=',
    first.getAttribute('href') === 'https://vk.ru/audios?q=Ink%2520-%2520Freak',
    first.getAttribute('href')
  );
  check(
    'амперсанд кодируется дважды (%2526)',
    buttons(window, '#table-rows')[1].getAttribute('href').indexOf('%2526') !== -1,
    buttons(window, '#table-rows')[1].getAttribute('href')
  );
  check(
    'подсказка содержит запрос',
    first.getAttribute('title') === 'Найти «Ink - Freak» в аудио VK',
    first.getAttribute('title')
  );
  check('aria-label совпадает с подсказкой', first.getAttribute('aria-label') === first.getAttribute('title'));
  check('ссылка открывается в новой вкладке', first.getAttribute('target') === '_blank');
  check('rel=noopener noreferrer', first.getAttribute('rel') === 'noopener noreferrer');
  check(
    'у трека в таблице ключ — ID трека, а не обложки-релиза',
    first.getAttribute('data-bp2vk-key') === '30500496',
    first.getAttribute('data-bp2vk-key')
  );

  // Позиция: сразу после ссылки на трек, внутри строки заголовка.
  const anchor = buttons(window, '#table-rows')[0].previousElementSibling;
  check(
    'кнопка стоит сразу после ссылки на трек',
    !!anchor && anchor.tagName === 'A' && /^\/track\//.test(anchor.getAttribute('href')),
    anchor && anchor.getAttribute('href')
  );
  check(
    'кнопка внутри строки заголовка таблицы',
    /Tables-shared-style__TitleRow/.test(first.parentElement.className),
    first.parentElement.className
  );

  const listButton = buttons(window, '#list-rows')[0];
  const listAnchor = listButton.previousElementSibling;
  check(
    'в списке кнопка тоже сразу после ссылки на трек',
    !!listAnchor && /^\/track\//.test(listAnchor.getAttribute('href')),
    listAnchor && listAnchor.getAttribute('href')
  );
  check(
    'в списке кнопка внутри Lists-строки заголовка',
    /Lists-shared-style__TitleRow/.test(listButton.parentElement.className),
    listButton.parentElement.className
  );

  const headerButton = buttons(window, '#track-header')[0];
  check(
    'в шапке трека кнопка стоит рядом с кнопками плеера',
    /CollectionControls_controls/.test(headerButton.parentElement.className),
    headerButton.parentElement.className
  );

  // Карточка релиза: ищем релиз целиком — артист и название релиза.
  const cardButton = buttons(window, '#cards')[0];
  check(
    'карточка релиза: запрос из названия релиза',
    cardButton.getAttribute('data-bp2vk-query') === 'Alex M.O.R.P.H. - Euphoria Rising',
    cardButton.getAttribute('data-bp2vk-query')
  );
  check(
    'карточка релиза: ID релиза в ключе',
    cardButton.getAttribute('data-bp2vk-key') === '7501288',
    cardButton.getAttribute('data-bp2vk-key')
  );
  check(
    'карточка релиза: кнопка у названия, а не у обложки',
    /ReleaseCard_releaseNameWrapper/.test(cardButton.parentElement.className) &&
      !!cardButton.previousElementSibling &&
      cardButton.previousElementSibling.getAttribute('href') === '/release/euphoria-rising/7501288',
    cardButton.parentElement.className
  );

  // Hero-блок релиза: кнопка в ряду действий.
  const heroButton = buttons(window, '#hero')[0];
  check(
    'hero релиза: запрос из названия релиза',
    heroButton.getAttribute('data-bp2vk-query') === 'Activa - Velorum',
    heroButton.getAttribute('data-bp2vk-query')
  );
  check(
    'hero релиза: кнопка в ряду действий',
    /HeroRelease_actions/.test(heroButton.parentElement.className),
    heroButton.parentElement.className
  );

  // Строка-релиз в списке (ссылка на /release/ вместо /track/).
  const releaseRowButton = buttons(window, '#release-list')[0];
  check(
    'строка-релиз: запрос собран из артистов списка',
    releaseRowButton.getAttribute('data-bp2vk-query') === 'Electric Universe - Divine Intervention',
    releaseRowButton.getAttribute('data-bp2vk-query')
  );
  check(
    'строка-релиз: кнопка сразу после ссылки',
    !!releaseRowButton.previousElementSibling &&
      releaseRowButton.previousElementSibling.getAttribute('href') === '/release/divine-intervention/7482887',
    releaseRowButton.previousElementSibling && releaseRowButton.previousElementSibling.getAttribute('href')
  );

  // Повторный скан не должен дублировать кнопки.
  await afterMutation(window);
  check('повторная отрисовка не дублирует кнопки', buttons(window).length === 9, buttons(window).length);

  dom.window.close();
}

async function testQueryTemplates() {
  console.log('\n[2] Шаблон запроса');
  {
    const { dom, window } = await bootBeatport({
      settings: { queryTemplate: '{artist} - {title} ({mix})' },
    });
    const listQueries = queries(window, '#list-rows');
    check('микс в скобках добавляется', listQueries[0] === 'Chromeo - Fancy Footwork (Extended Mix)', listQueries);
    check(
      'без микса скобки не появляются',
      queries(window, '#table-rows')[1] === 'Space Motion - Push & Pull',
      queries(window, '#table-rows')
    );
    check(
      'микс Original Mix тоже подставляется',
      queries(window, '#list-rows')[1] === 'Kepler (UK) - Inner Motion (Original Mix)',
      listQueries
    );
    dom.window.close();
  }
  {
    const { dom, window } = await bootBeatport({ settings: { queryTemplate: '{artists} - {title}' } });
    check(
      'все артисты через запятую',
      queries(window, '#table-rows')[0] === 'Ink, Mesto - Freak',
      queries(window, '#table-rows')
    );
    dom.window.close();
  }
  {
    const { dom, window } = await bootBeatport({ settings: { queryTemplate: '{title} {artist}' } });
    check('обратный порядок', queries(window, '#table-rows')[0] === 'Freak Ink', queries(window, '#table-rows'));
    dom.window.close();
  }
  {
    const { dom, window } = await bootBeatport({ settings: { queryTemplate: '{artist} - {title} [{label}]' } });
    check(
      'метка лейбла подставляется',
      queries(window, '#table-rows')[0] === 'Ink - Freak [Experts Only]',
      queries(window, '#table-rows')
    );
    dom.window.close();
  }
  {
    const { dom, window } = await bootBeatport({ settings: { queryTemplate: 'без подстановки' } });
    check(
      'шаблон без {title} откатывается к значению по умолчанию',
      queries(window, '#table-rows')[0] === 'Ink - Freak',
      queries(window, '#table-rows')
    );
    dom.window.close();
  }
}

async function testOwnerIdAndEncoding() {
  console.log('\n[3] ID владельца аудио и кодирование');
  {
    const { dom, window } = await bootBeatport({ local: { detectedAudioOwnerId: '123456789' } });
    const href = buttons(window, '#table-rows')[0].getAttribute('href');
    check('ID из storage.local подставляется в адрес', href === 'https://vk.ru/audios123456789?q=Ink%2520-%2520Freak', href);
    dom.window.close();
  }
  {
    const { dom, window } = await bootBeatport({
      local: { detectedAudioOwnerId: '123456789' },
      settings: { audioOwnerId: '987654321' },
    });
    const href = buttons(window, '#table-rows')[0].getAttribute('href');
    check('ручной ID из настроек важнее выученного', href.indexOf('/audios987654321?q=') !== -1, href);
    dom.window.close();
  }
  {
    const { dom, window } = await bootBeatport({ settings: { queryEncoding: 'single' } });
    const href = buttons(window, '#table-rows')[0].getAttribute('href');
    check('одинарное кодирование даёт %20', href === 'https://vk.ru/audios?q=Ink%20-%20Freak', href);
    dom.window.close();
  }
  {
    const { dom, window } = await bootBeatport({ settings: { audioOwnerId: 'не число' } });
    const href = buttons(window, '#table-rows')[0].getAttribute('href');
    check('нечисловой ID игнорируется', href === 'https://vk.ru/audios?q=Ink%2520-%2520Freak', href);
    dom.window.close();
  }
}

async function testBehavior() {
  console.log('\n[4] Поведение кнопки и реакция на настройки');
  {
    const { dom, window, chrome } = await bootBeatport();

    // Нажатие кнопки не должно всплывать до обработчиков Beatport.
    let rowClicked = false;
    window.document.querySelector('#table-rows').addEventListener('click', () => {
      rowClicked = true;
    });
    const button = buttons(window, '#table-rows')[0];
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    check('клик по кнопке не всплывает до строки Beatport', rowClicked === false);

    // Нет ID — запрос запоминается для вкладки VK.
    button.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    const pending = chrome.__state.localWrites.filter((write) => write.pendingAudioSearch).pop();
    check(
      'без ID нажатие запоминает отложенный запрос',
      !!pending && pending.pendingAudioSearch.query === 'Ink - Freak',
      chrome.__state.localWrites
    );

    // Появился ID — кнопки обновляют адрес, а запоминать больше не нужно.
    chrome.__state.emit({ detectedAudioOwnerId: { newValue: '555000111' } }, 'local');
    check(
      'новый ID сразу попадает в адрес кнопок',
      buttons(window, '#table-rows')[0].getAttribute('href').indexOf('/audios555000111?q=') !== -1,
      buttons(window, '#table-rows')[0].getAttribute('href')
    );

    const writesBefore = chrome.__state.localWrites.length;
    buttons(window, '#table-rows')[0].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    check('с известным ID отложенный запрос не пишется', chrome.__state.localWrites.length === writesBefore);

    // Смена шаблона через storage.onChanged перерисовывает запросы.
    chrome.__state.emit({ queryTemplate: { newValue: '{artist} — {title} ({mix})' } }, 'sync');
    check(
      'смена шаблона обновляет запрос на месте',
      queries(window, '#list-rows')[0] === 'Chromeo — Fancy Footwork (Extended Mix)',
      queries(window, '#list-rows')
    );
    check('количество кнопок при этом не меняется', buttons(window).length === 9, buttons(window).length);

    // Выключение расширения убирает кнопки, включение — возвращает.
    chrome.__state.emit({ enabled: { newValue: false } }, 'sync');
    check('выключение убирает все кнопки', buttons(window).length === 0, buttons(window).length);
    check('на <html> появляется класс отключения', window.document.documentElement.classList.contains('bp2vk-disabled'));

    chrome.__state.emit({ enabled: { newValue: true } }, 'sync');
    check('включение возвращает кнопки', buttons(window).length === 9, buttons(window).length);

    dom.window.close();
  }
  {
    const { dom, window } = await bootBeatport({ settings: { openInNewTab: false } });
    const button = buttons(window, '#table-rows')[0];
    check('openInNewTab=false: без target', button.getAttribute('target') === null, button.getAttribute('target'));
    check('openInNewTab=false: без rel', button.getAttribute('rel') === null, button.getAttribute('rel'));
    dom.window.close();
  }
}

async function testDynamicPage() {
  console.log('\n[5] Одностраничное приложение Beatport');
  const { dom, window } = await bootBeatport();

  const list = window.document.getElementById('list-rows');
  const listItem = list.querySelector('.Lists-shared-style__Item-sc-32b78157-14');
  listItem.parentNode.removeChild(listItem);
  await afterMutation(window);
  check('удаление строки убирает кнопку', buttons(window, '#list-rows').length === 1, scopeCounts(window));

  const table = window.document.getElementById('table-rows');
  const row = table.querySelector('[data-testid="tracks-table-row"]');
  table.appendChild(row.cloneNode(true));
  await afterMutation(window);
  check('новая строка получает кнопку', buttons(window, '#table-rows').length === 4, scopeCounts(window));
  check('всего стало 9 кнопок', buttons(window).length === 9, scopeCounts(window));

  const scansBefore = scanCount(window);
  window.history.pushState({}, '', '/release/freak-extended-mix/7429942');
  const rescanned = await waitFor(() => scanCount(window) > scansBefore, 5000);
  check('после SPA-перехода страница пересканирована', rescanned === true, scanCount(window));
  check('после SPA-перехода кнопки не дублируются', buttons(window).length === 9, scopeCounts(window));

  dom.window.close();
}

async function testLocalizedPages() {
  console.log('\n[6] Локализованные страницы (/es/…)');
  const { dom, window, errors } = await bootBeatport({
    fixture: LOCALE_FIXTURE_HTML,
    url: 'https://www.beatport.com/es/genre/bass-house/91/top-100',
    local: { detectedAudioOwnerId: '123456789' },
  });

  check('локализованная страница поднялась без ошибок', errors.length === 0, errors);

  const found = buttons(window);
  check('строка с /es/track/ получила кнопку', found.length === 1, found.length);

  if (found.length) {
    check(
      'артисты берутся из /es/artist/',
      found[0].getAttribute('data-bp2vk-query') === 'SHDWS (US) - Mumble',
      found[0].getAttribute('data-bp2vk-query')
    );
    check(
      'ID трека вытащен из /es/track/',
      found[0].getAttribute('data-bp2vk-key') === '30175842',
      found[0].getAttribute('data-bp2vk-key')
    );
    check(
      'ссылка VK собрана с ID',
      found[0].getAttribute('href') === 'https://vk.ru/audios123456789?q=SHDWS%2520(US)%2520-%2520Mumble',
      found[0].getAttribute('href')
    );
  }

  dom.window.close();
}

async function testVkSide() {
  console.log('\n[7] Скрипт на стороне VK');
  {
    const { dom, window, chrome } = await bootVk({ url: 'https://vk.ru/audios123456789' });
    check(
      'ID владельца аудио выучен из адреса',
      chrome.__state.localStore.detectedAudioOwnerId === '123456789',
      chrome.__state.localStore.detectedAudioOwnerId
    );
    check('без отложенного запроса переходов нет', window.__repairs.length === 0, window.__repairs);
    dom.window.close();
  }
  {
    const { dom, window, chrome } = await bootVk({
      url: 'https://vk.ru/audios123456789',
      local: { pendingAudioSearch: { query: 'Ink - Freak', ts: Date.now() } },
    });
    check(
      'потерянный q достраивается в адресе',
      window.__repairs[0] === 'https://vk.ru/audios123456789?q=Ink%2520-%2520Freak',
      window.__repairs
    );
    check('отложенный запрос стирается', !chrome.__state.localStore.pendingAudioSearch, chrome.__state.localStore);
    dom.window.close();
  }
  {
    const { dom, window } = await bootVk({
      url: 'https://vk.ru/audios123456789?q=Ink%2520-%2520Freak',
      local: { pendingAudioSearch: { query: 'Ink - Freak', ts: Date.now() } },
    });
    check('если q доехал сам — переход не повторяется', window.__repairs.length === 0, window.__repairs);
    dom.window.close();
  }
  {
    const { dom, window } = await bootVk({
      url: 'https://vk.ru/audios123456789',
      local: { pendingAudioSearch: { query: 'Ink - Freak', ts: Date.now() - 5 * 60 * 1000 } },
    });
    check('просроченный запрос игнорируется', window.__repairs.length === 0, window.__repairs);
    dom.window.close();
  }
  {
    const { dom, window } = await bootVk({
      url: 'https://vk.ru/audios123456789',
      settings: { queryEncoding: 'single' },
      local: { pendingAudioSearch: { query: 'Ink - Freak', ts: Date.now() } },
    });
    check(
      'одинарное кодирование в переходе',
      window.__repairs[0] === 'https://vk.ru/audios123456789?q=Ink%20-%20Freak',
      window.__repairs
    );
    dom.window.close();
  }
}

async function testOptions() {
  console.log('\n[8] Страница настроек');
  const { dom, window, chrome, errors } = await bootOptions({
    settings: { queryTemplate: '{artist} - {title}', openInNewTab: false, queryEncoding: 'single' },
    local: { detectedAudioOwnerId: '123456789' },
  });

  check('страница настроек без ошибок', errors.length === 0, errors);

  const doc = window.document;
  check('версия показана', doc.getElementById('version').textContent === SOURCES.manifest.version);
  check('шаблон загружен из настроек', doc.getElementById('queryTemplate').value === '{artist} - {title}');
  check('переключатель новой вкладки выключен', doc.getElementById('openInNewTab').checked === false);
  check('кодирование из настроек', doc.getElementById('queryEncoding').value === 'single');
  check(
    'предпросмотр ссылки с выученным ID',
    doc.getElementById('previewUrl').textContent.indexOf('https://vk.ru/audios123456789?q=') === 0,
    doc.getElementById('previewUrl').textContent
  );
  check(
    'определённый ID показан текстом',
    /123456789/.test(doc.getElementById('detected').textContent),
    doc.getElementById('detected').textContent
  );

  const template = doc.getElementById('queryTemplate');
  template.value = '{artist} - {title} ({mix})';
  template.dispatchEvent(new window.Event('input', { bubbles: true }));
  check(
    'предпросмотр реагирует на шаблон',
    doc.getElementById('preview').textContent.indexOf('Chromeo - Fancy Footwork (Extended Mix)') !== -1,
    doc.getElementById('preview').textContent
  );

  const chip = Array.from(doc.querySelectorAll('#presets .chip')).find(
    (node) => node.getAttribute('data-template') === '{artists} - {title}'
  );
  chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('кнопка-пресет подставляет шаблон', template.value === '{artists} - {title}', template.value);
  check('выбранный пресет подсвечен', chip.classList.contains('active'));

  const saved = await waitFor(
    () => chrome.__state.syncWrites.some((write) => write.queryTemplate === '{artists} - {title}'),
    3000
  );
  check('изменения сохраняются в chrome.storage.sync', saved === true, chrome.__state.syncWrites);

  doc.getElementById('reset').click();
  check('сброс возвращает шаблон по умолчанию', template.value === '{artist} - {title}', template.value);
  const resetWritten = await waitFor(() => {
    const last = chrome.__state.syncWrites[chrome.__state.syncWrites.length - 1];
    return !!last && last.queryTemplate === '{artist} - {title}';
  }, 3000);
  check('сброс записывает значения по умолчанию', resetWritten === true, chrome.__state.syncWrites);

  dom.window.close();
}

function testManifest() {
  console.log('\n[9] Манифест');
  const manifest = SOURCES.manifest;

  check('Manifest V3', manifest.manifest_version === 3, manifest.manifest_version);
  check('версия манифеста совпадает с common.js', manifest.version === '1.1.0', manifest.version);
  check('есть разрешение storage', (manifest.permissions || []).includes('storage'), manifest.permissions);

  const scripts = manifest.content_scripts || [];
  const beatport = scripts.find((entry) => entry.matches.some((match) => match.indexOf('beatport.com') !== -1));
  const vk = scripts.find((entry) => entry.matches.some((match) => match.indexOf('vk.ru') !== -1));

  check('content script на Beatport есть', !!beatport);
  check('порядок: common.js, затем content.js', !!beatport && beatport.js.join(',') === 'common.js,content.js', beatport && beatport.js);
  check('стили кнопки подключены на Beatport', !!beatport && (beatport.css || []).includes('content.css'));
  check('content script на VK есть', !!vk);
  check('на VK грузятся common.js и vk.js', !!vk && vk.js.join(',') === 'common.js,vk.js', vk && vk.js);
  check('страница настроек открывается в отдельной вкладке', !!manifest.options_ui && manifest.options_ui.open_in_tab === true);
  check('есть фоновая служба', !!manifest.background && !!manifest.background.service_worker);
  check('иконки 16/32/48/128 на месте', ['16', '32', '48', '128'].every((size) => manifest.icons[size]));
}

async function main() {
  await testLayoutAndDefaults();
  await testQueryTemplates();
  await testOwnerIdAndEncoding();
  await testBehavior();
  await testDynamicPage();
  await testLocalizedPages();
  await testVkSide();
  await testOptions();
  testManifest();

  console.log('\n' + (failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : 'ЕСТЬ ОШИБКИ') + ': ' + (checks - failures) + '/' + checks);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// app.js — UI «RuStore mini» на движке incr.js + pre.js.
//
// Синтаксис (патчится pre.js во время выполнения):
//   DIV(props) { дети }   -> контейнер        DIV(props, "текст") -> лист
//   ALL-CAPS(...)         -> компонент memo   CSS`...` -> scoped-класс
// Компонент обязан создать ровно ОДИН корневой узел (это его identity).

// ------------------------------------------------------------------ сеть
const API     = 'https://backapi.rustore.ru';   // поиск / инфо
const API_NEW = 'https://api.rustore.ru';       // showcase / download-link
const API_WEB = 'https://web-api.rustore.ru';   // веб-шлюз (подсказки)
const HDR = { 'RuStoreVerCode': '1000', 'Accept': 'application/json' };
const THEME_KEY = 'rs_theme_mode'; // 'auto' | 'light' | 'dark'
// version.json для самообновления лежит в GitHub Releases: стабильный URL
// .../releases/latest/download/version.json всегда отдаёт ассет последнего релиза,
// а внутри — такой же стабильный URL на APK. Из bundled-сайта это кросс-доменный
// запрос — читаем через мост обёртки (GM_xmlhttpRequest), CORS там нет вообще.
// Переопределяется через window.RS_VER_URL (локальный web/config.local.js).
const VER_URL = window.RS_VER_URL ||
  'https://github.com/Pifpaf074/rustore-mini/releases/latest/download/version.json';

const safeUrl = u => u ? String(u).replace('//static-m.rustore.ru/', '//static.rustore.ru/') : '';
const mb    = n => n ? (n / 1048576).toFixed(1) + ' МБ' : '—';
const fnum  = n => Number(n || 0).toLocaleString('ru-RU');
const fdate = s => s ? new Date(s).toLocaleDateString('ru-RU') : '—';

// fetch с таймаутом: без него офлайн запросы висят бесконечно («читаем установленные…»).
// Это только ФОЛБЭК: в приложении все запросы идут через мост (см. httpRaw).
const NET_TIMEOUT = 12000;
async function fetchT(url, opts) {
  const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const o = Object.assign({}, opts || {});
  if (ctl) o.signal = ctl.signal;
  const t = setTimeout(function () { if (ctl) ctl.abort(); }, NET_TIMEOUT);
  try { return await fetch(url, o); } finally { clearTimeout(t); }
}
const netError = (e) => /fetch|network|abort|timeout|load failed|failed to load/i.test(String((e && e.message) || e));
// 404 = «нет в RuStore», а не сетевая ошибка. Тело ошибки RuStore НЕ содержит «404»
// ("Couldn't find required data..."), поэтому ориентируемся на HTTP-статус.
const is404 = (e) => !!(e && (e.status === 404 || /404/.test(String(e.message || ''))));

// --- HTTP через мост обёртки -------------------------------------------------
// helpers.js даёт GM_xmlhttpRequest, который ходит нативным httpRequest: без CORS
// (никаких preflight), без cookie, с любыми заголовками и телом. Возвращаем объект,
// похожий на Response — {ok, status, json()} — чтобы код ниже не различал пути.
function gmRequest(url, opts) {
  return new Promise(function (resolve, reject) {
    let req, done = false;
    const t = setTimeout(function () { done = true; try { req.abort(); } catch (e) {} reject(new Error('timeout')); }, NET_TIMEOUT);
    req = GM_xmlhttpRequest({
      method: (opts && opts.method) || 'GET',
      url: url,
      headers: (opts && opts.headers) || {},
      data: (opts && opts.body != null) ? String(opts.body) : '',
      onload: function (res) {
        if (done) return;
        clearTimeout(t);
        const text = res.responseText || '';
        resolve({
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          json: function () { try { return Promise.resolve(JSON.parse(text)); } catch (e) { return Promise.resolve({}); } },
        });
      },
      onerror: function (e) { if (done) return; clearTimeout(t); reject(new Error('network: ' + ((e && e.error) || 'error'))); },
      ontimeout: function () { if (done) return; clearTimeout(t); reject(new Error('timeout')); },
    });
  });
}
const hasBridge = () => typeof GM_xmlhttpRequest === 'function';
async function httpRaw(url, opts) { return hasBridge() ? gmRequest(url, opts) : fetchT(url, opts); }

// Один разбор ответа для всех API (через мост, см. httpRaw). strict: у backapi
// ошибка — любой code кроме 'OK', у нового API — только 'ERROR'.
async function jfetch(url, opts, strict) {
  const r = await httpRaw(url, opts);
  const j = await r.json().catch(() => ({}));
  const bad = !r.ok || (j && j.code && (strict ? j.code !== 'OK' : j.code === 'ERROR'));
  if (bad) {
    const err = new Error((j && j.message) || ('HTTP ' + r.status));
    err.status = r.status;
    throw err;
  }
  return j;
}
async function api(path, opts) {
  const o = Object.assign({}, opts || {});
  if (o.body != null && !o.headers) o.headers = { 'Content-Type': 'application/json' };
  return (await jfetch(API + path, o, true)).body;
}
// Запросы, где обязателен RuStoreVerCode (overallInfo, download-link).
async function apiH(path, opts) {
  const o = Object.assign({ headers: Object.assign({}, HDR) }, opts || {});
  if (o.body != null && !o.headers['Content-Type']) o.headers['Content-Type'] = 'application/json';
  return (await jfetch(API + path, o, true)).body;
}
async function getNew(path) { return jfetch(API_NEW + path, null, false); }
const search = (q, page, size) =>
  api('/applicationData/apps?pageNumber=' + (page || 0) + '&pageSize=' + (size || 20) + '&query=' + encodeURIComponent(q));
// overallInfo требует заголовок RuStoreVerCode — с мостом это просто, preflight не бывает.
const info = pkg => apiH('/applicationData/overallInfo/' + encodeURIComponent(pkg));
const comments = (pkg, page, size) =>
  api('/comment/comment?packageName=' + encodeURIComponent(pkg) + '&sortBy=NEW_FIRST&pageNumber=' + (page || 0) + '&pageSize=' + (size || 10));
const stars = n => { n = Math.max(0, Math.min(5, Number(n) || 0)); return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n); };

// Параметры устройства для выбора правильного APK.
function devParams() {
  const N = window.Native;
  const d = (N && N.deviceInfo) ? (N.deviceInfo() || {}) : {};
  return {
    screenDensity: d.density || 480,
    sdkVersion: d.sdk || 33,
    supportedAbis: (d.abis && d.abis.length) ? d.abis : ['arm64-v8a'],
  };
}
async function downloadLink(appId, firstInstall) {
  const body = JSON.stringify(Object.assign({ appId: appId, firstInstall: !!firstInstall, withoutSplits: true }, devParams()));
  try {
    const r = await httpRaw(API_NEW + '/v3/showcase/apps/download-link',
      { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, HDR), body: body });
    if (r.ok) return await r.json();
  } catch (e) { /* упал -> старый путь */ }
  return apiH('/applicationData/v2/download-link', { method: 'POST', body: body });
}
// Ссылка на APK из RuStore: новый API с фолбэком на старый. hint — текст ошибки, если ссылки нет.
// download-link НЕ отдаёт подпись, поэтому берём её из overallInfo (sig) — иначе нативная
// проверка подписи молча пропускается.
async function resolveApk(appId, firstInstall, hint, sig) {
  const d = await downloadLink(appId, firstInstall);
  const u = (d.downloadUrls || [])[0];
  if (!u) throw new Error(hint || 'RuStore не отдал ссылку');
  return { url: safeUrl(u.url), size: u.size, signer: d.signature || sig || null };
}
// Единая установка через нативный мост: {url,size,signer} + имя + колбэки фаз.
function installApk(a, name, cbs) {
  return window.Native.installApk(Object.assign({ url: a.url, size: a.size, signer: a.signer, name: name }, cbs || {}));
}

// Параллельный обход с ограничением.
async function pool(items, size, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length || 1)) }, worker));
}
// overallInfo с ретраями: сервер иногда отдаёт 429/5xx/сетевую ошибку — без ретрая
// приложение молча выпадает из списка обновлений (отсюда «разный список»).
async function infoRetry(pkg, times) {
  const n = times || 4;
  let last;
  for (let i = 0; i < n; i++) {
    try { return await info(pkg); }
    catch (e) {
      last = e;
      if (is404(e)) throw e; // нет в RuStore — не ретраим
      if (i < n - 1) await sleep(300 * (i + 1));
    }
  }
  throw last;
}
// Кэш info на время проверки: повторные «Проверить» дают стабильный список.
const UPD_TTL = 5 * 60 * 1000;
const updCache = {};
// Маркер «проверить не удалось» (сеть) в результатах checkUpdates: строку не трогаем.
const KEEP = {};
// Пакеты, обновлённые во время текущей проверки: их строки не воскрешаем —
// ответ мог быть получен ДО установки, а строка уже убрана updateOne.
let updDone = null;
async function infoCached(pkg) {
  const c = updCache[pkg], now = Date.now();
  if (c && now - c.ts < UPD_TTL) return c.v;
  const v = await infoRetry(pkg, 4);
  updCache[pkg] = { v: v, ts: now };
  return v;
}

const canNative = () => !!(window.Native && window.Native.installApk);
// Hail (freeze-менеджер) — публичный API через экспортированную ApiActivity.
const hailOk = () => !!(window.Native && window.Native.hailAvailable && window.Native.hailAvailable());
function hail(action, pkg) { const N = window.Native; return !!(N && N.hail && N.hail(action, pkg)); }
// Приложение выключено/приостановлено — но это НЕ обязательно Hail: так же выглядят
// отключённые системные приложения и «заморозка» прошивки (ColorOS и т.п.).
const isDisabled = (a) => !!(a && (a.enabled === false || a.suspended === true));
// «Заморожено» — только если Hail реально установлен, иначе снежинку не показываем.
const isFrozen = (a) => hailOk() && isDisabled(a);
const sleep = (ms) => new Promise(function (r) { setTimeout(r, ms); });
const TABS = [{ id: 'apps', label: 'Приложения' }, { id: 'games', label: 'Игры' }, { id: 'upd', label: 'Обновления' }];

// ------------------------------------------------------------------ состояние
const ST = data({
  tab: 'upd',
  themeMode: savedThemeMode(),
  sysTheme: (document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
  theme: (document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
  homes: { APPS: null, GAMES: null },
  homeLoading: { APPS: false, GAMES: false },
  homeErr: { APPS: '', GAMES: '' },
  query: '', suggests: [], results: null, searching: false,
  detail: null, detailPkg: null, detailLoading: false, detailErr: '',
  comments: null, commentsLoading: false, commentsErr: '', commentsPage: 0, commentsTotal: 0,
  // Одна установка за раз (нативный мост держит один слот pending).
  // rowBusy: пакет -> текст прогресса; '#self' — самообновление приложения.
  // Кнопки рендерятся ИЗ ЭТОГО состояния, а не пишутся в DOM руками.
  rowBusy: {},
  selfUpd: null,
  updTab: 'upd', updates: null, updChecking: false, updProgress: '', updErr: '',
  updBusy: '', updAllBusy: false,
  installed: null,
  toast: '',
});

// ------------------------------------------------------------------ кеш карточек
let metaCache = {};
try { metaCache = JSON.parse(localStorage.getItem('rs_meta_v1') || '{}') || {}; } catch (e) { metaCache = {}; }
let metaSaveT = null;
function saveMetaSoon() {
  clearTimeout(metaSaveT);
  metaSaveT = setTimeout(function () { try { localStorage.setItem('rs_meta_v1', JSON.stringify(metaCache)); } catch (e) {} }, 900);
}
async function metaFor(pkg) {
  if (metaCache[pkg]) return metaCache[pkg];
  let m = null;
  try {
    const b = await search(pkg, 0, 6);
    const list = (b && b.content) || [];
    const hit = list.find(x => x.packageName === pkg); // только точное; иначе — чужое приложение
    if (hit) m = {
      appId: hit.appId, packageName: hit.packageName, appName: hit.appName,
      iconUrl: hit.iconUrl, averageUserRating: hit.averageUserRating,
      roundedDownloadsText: hit.roundedDownloadsText, versionCode: hit.versionCode,
    };
  } catch (e) { /* нет в поиске */ }
  if (!m) {
    try {
      const i = await info(pkg);
      m = { appId: i.appId, packageName: pkg, appName: i.appName, iconUrl: i.iconUrl, versionCode: i.versionCode };
    } catch (e) { /* нет в RuStore */ }
  }
  if (m) { metaCache[pkg] = m; saveMetaSoon(); }
  return m;
}

// ------------------------------------------------------------------ утилиты UI
let toastT = null;
function toast(m) {
  ST.toast = String(m);
  clearTimeout(toastT);
  // Длительность — от длины: короткое подтверждение читается за секунду, а текст
  // ошибки установки — нет (раньше всё исчезало через 2.8 с).
  toastT = setTimeout(function () { ST.toast = ''; }, Math.min(10000, 2600 + String(m).length * 45));
}
function savedThemeMode() { try { const v = localStorage.getItem(THEME_KEY); return (v === 'light' || v === 'dark') ? v : 'auto'; } catch (e) { return 'auto'; } }
// Системная тема: сначала натив (WebView не всегда отдаёт prefers-color-scheme), потом matchMedia.
function systemTheme() {
  const N = window.Native;
  if (N && N.systemTheme) { const t = N.systemTheme(); if (t) return t; }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme() {
  ST.theme = ST.themeMode === 'auto' ? ST.sysTheme : ST.themeMode;
  document.documentElement.classList.toggle('dark', ST.theme === 'dark');
}
function themeTitle() { return 'Тема: ' + (ST.themeMode === 'auto' ? 'авто' : (ST.themeMode === 'dark' ? 'тёмная' : 'светлая')); }
function toggleTheme() {
  ST.themeMode = ST.themeMode === 'auto' ? 'light' : (ST.themeMode === 'light' ? 'dark' : 'auto');
  if (ST.themeMode === 'auto') ST.sysTheme = systemTheme();
  try { localStorage.setItem(THEME_KEY, ST.themeMode); } catch (e) {}
  applyTheme();
}
function syncSystemTheme() { ST.sysTheme = systemTheme(); if (ST.themeMode === 'auto') applyTheme(); }
// Нативный слой сообщает о смене системной темы (см. onConfigurationChanged).
window.__onNativeTheme = function (t) { ST.sysTheme = (t === 'dark') ? 'dark' : 'light'; if (ST.themeMode === 'auto') applyTheme(); };
const mqDark = window.matchMedia('(prefers-color-scheme: dark)');
if (mqDark.addEventListener) mqDark.addEventListener('change', syncSystemTheme);
else if (mqDark.addListener) mqDark.addListener(syncSystemTheme);
// Стартовую тему уже выставил head-скрипт (из натива/matchMedia); ST.theme читает класс.
// Жест «потянуть вниз» (см. native.js): обновляем то, что сейчас на экране.
window.__refreshCurrent = function () {
  syncSystemTheme();
  if (ST.detail || ST.detailLoading || ST.detailErr) { if (ST.detailPkg) openDetail(ST.detailPkg); return; }
  if (searchActive()) { if (ST.query) runSearch(ST.query); return; }
  if (ST.tab === 'upd') { if (ST.updTab === 'installed') refreshInstalled(); else checkUpdates(true); return; }
  loadHome(kindOf(ST.tab));
};
// Pull-to-refresh должен замолчать, когда прокручен СВОЙ скроллер (оверлей карточки):
// натив видит только скролл WebView и иначе дёргает обновление при листании описания вверх.
function ptrSync(scrolled) {
  const N = window.Native;
  if (N && N.setPtrEnabled) N.setPtrEnabled(!scrolled);
}
function launch(pkg, frozen) {
  if (frozen && hailOk() && hail('LAUNCH', pkg)) return; // Hail сам разморозит и запустит
  const N = window.Native;
  if (N && N.launchApp) { if (!N.launchApp(pkg)) toast('Не удалось открыть'); }
  else toast('Только внутри приложения');
}
function openExt(url) {
  const N = window.Native;
  if (N && N.openExternal) N.openExternal(url);
  else window.open(url, '_blank');
}
function shareApp(i) {
  const url = 'https://www.rustore.ru/catalog/app/' + i.packageName;
  const BT = window.WebToApk;
  if (BT && BT.share) BT.share(i.appName || 'RuStore', i.shortDescription || '', url);
  else toast(url);
}
function shotlist(i) {
  return (i.fileUrls || []).filter(f => f.type !== 'ICON').sort((a, b) => a.ordinal - b.ordinal).map(f => f.fileUrl);
}

// ------------------------------------------------------------------ навигация
function kindOf(tab) { return tab === 'games' ? 'GAMES' : 'APPS'; }
function ensureHome(kind) { if (!ST.homes[kind] && !ST.homeLoading[kind]) loadHome(kind); }
function clearSearch() { ST.query = ''; ST.results = null; ST.suggests = []; }
function searchActive() { return ST.results !== null || !!ST.query; }
function setTab(id) {
  if (id === ST.tab) return;
  if (id === 'apps' || id === 'games') clearSearch();
  navPush({ tab: id, detail: null });
}
function ensureUpdData() {
  if (ST.updTab === 'installed' && !ST.installed) loadInstalled();
  if (ST.updTab !== 'installed' && !ST.updates && !ST.updChecking) checkUpdates();
}
function closeDetail() {
  if (navStack.length) navBack();
  else hideDetail();
}

// --- история для аппаратной кнопки «Назад» (нативный onBackPressed → goBack) ---
// JS видит back только как popstate, а popstate возможен лишь при наличии записи
// в истории. Держим ровно один «сторожевой» pushState и свой стек состояний.
const NAV0 = { tab: 'upd', detail: null };
let navStack = [];
let navArmed = false;
function hasBackTarget() { return navStack.length > 0 || searchActive(); }
function armSentinel() {
  if (navArmed || !hasBackTarget()) return;
  try { history.pushState({ sentinel: 1 }, ''); navArmed = true; } catch (e) {}
}
function applyNav(s) {
  const tab = (s && s.tab) || 'apps';
  ST.tab = tab;
  if (tab === 'upd') ensureUpdData();
  else ensureHome(kindOf(tab));
  if (s && s.detail) openDetail(s.detail);
  else hideDetail();
}
function navPush(s) { navStack.push(s); armSentinel(); applyNav(s); }
function navBack() { if (hasBackTarget()) history.back(); }
window.addEventListener('popstate', function () {
  navArmed = false;                       // сторожевой энтри израсходован
  if (navStack.length) {
    navStack.pop();
    applyNav(navStack.length ? navStack[navStack.length - 1] : NAV0);
  } else if (searchActive()) {
    clearSearch();                        // back из поиска — назад к каталогу
  } else {
    return;                               // больше нечего — следующий back выйдет
  }
  if (hasBackTarget()) armSentinel();     // остались уровни — снова вооружаемся
});

// ------------------------------------------------------------------ каталог
function loadHome(kind) {
  if (ST.homeLoading[kind]) return;
  ST.homeLoading[kind] = true; ST.homeErr[kind] = ''; ST.homes[kind] = null;
  (async function () {
    const sec = await getNew('/v5/showcase/sections/' + kind + '?limit=8');
    let pop = null;
    if (kind === 'APPS') { try { pop = await getNew('/v2/showcase/popular/apps?limit=12'); } catch (e) { pop = null; } }
    const rails = [];
    if (pop && pop.apps && pop.apps.length) {
      rails.push({ id: 'popular', title: 'Популярное сейчас', sub: '', pkgs: pop.apps.map(a => a.packageName).filter(Boolean).slice(0, 12) });
    }
    const els = (sec.body && sec.body.elements) || [];
    for (let x = 0; x < els.length; x++) {
      const sel = els[x].selection;
      if (!sel) continue;
      const c = sel.content || {};
      const pkgs = (c.appInfo || []).filter(a => a && a.type === 'APP' && a.packageName).map(a => a.packageName);
      if (!pkgs.length) continue;
      rails.push({
        id: sel.id,
        title: (sel.title && sel.title.value) || c.title || '',
        sub: (sel.subtitle && sel.subtitle.value) || '',
        pkgs: pkgs.slice(0, 12),
      });
    }
    // Сначала рамки с заглушками — карточки донаполнятся лениво.
    ST.homes[kind] = rails.map(r => Object.assign({}, r, { apps: r.pkgs.map(p => ({ packageName: p, appName: '', iconUrl: '' })) }));
    ST.homeLoading[kind] = false;
    // Ссылки на прокси-карточки, чтобы точечно дописывать поля.
    const refs = {};
    for (let x = 0; x < ST.homes[kind].length; x++) {
      const r = ST.homes[kind][x];
      for (let y = 0; y < r.apps.length; y++) {
        const a = r.apps[y];
        (refs[a.packageName] = refs[a.packageName] || []).push(a);
      }
    }
    const uniq = Object.keys(refs);
    pool(uniq, 6, async function (p) {
      const m = await metaFor(p);
      if (!m) return;
      const arr = refs[p] || [];
      for (let z = 0; z < arr.length; z++) Object.assign(arr[z], m);
    });
  })().catch(function (e) {
    ST.homeLoading[kind] = false; ST.homeErr[kind] = 'Не удалось загрузить: ' + e.message;
  });
}

// ------------------------------------------------------------------ поиск
let qT = null;
// Номера запросов: ответы устаревших (поздних) запросов игнорируются.
let sugSeq = 0;
let searchSeq = 0;
// Снять отложенный/летящий запрос подсказок (Enter, выбор подсказки):
// без этого таймер qT через 300 мс снова наполнял ST.suggests — и подсказки
// всплывали поверх уже показанных результатов поиска.
function clearSuggests() { sugSeq++; clearTimeout(qT); ST.suggests = []; }
function onQuery(e) {
  const v = e.target.value;
  const had = searchActive();
  ST.query = v;
  if (!v.trim()) {
    clearSearch();
    if (had && !navStack.length && navArmed) history.back(); // снять сторожевой энти без «пустого» back
  }
  // Набранный запрос — уже «уровень»: без сторожевого энтри back уходил в натив,
  // webView.canGoBack() = false и приложение закрывалось (хотя есть что «отматывать»).
  armSentinel();
  clearTimeout(qT);
  qT = setTimeout(function () { loadSuggests(v); }, 300);
}
function onQueryKey(e) {
  if (e.key === 'Enter') { e.target.blur(); clearSuggests(); runSearch(ST.query); }
}
async function loadSuggests(q) {
  q = String(q || '').trim();
  const my = ++sugSeq;
  if (q.length < 2) { ST.suggests = []; return; }
  try {
    const r = await httpRaw(API_WEB + '/v1/showcase/web/search/suggests?query=' + encodeURIComponent(q));
    const j = await r.json();
    if (my !== sugSeq || String(ST.query).trim() !== q) return; // устарело
    ST.suggests = (j.suggests || []).slice(0, 8);
  } catch (e) { if (my === sugSeq) ST.suggests = []; }
}
async function runSearch(q) {
  q = String(q || '').trim();
  if (!q) return;
  const my = ++searchSeq;
  ST.searching = true; ST.results = null;
  try {
    const b = await search(q);
    if (my !== searchSeq) return;   // этот поиск уже неактуален — не трогаем чужой список
    ST.results = (b && b.content) || [];
  } catch (e) {
    if (my !== searchSeq) return;
    ST.results = []; toast('Ошибка: ' + e.message);
  }
  ST.searching = false;
  armSentinel(); // чтобы back вернул из поиска к каталогу, а не вышел
}
function pickSuggest(s) {
  clearSuggests();
  if (s.packageName) navPush({ tab: ST.tab, detail: s.packageName });
  else { ST.query = s.text; runSearch(s.text); }
}

// ------------------------------------------------------------------ карточка приложения
// Номер текущего запроса карточки: ответы устаревших запросов игнорируются.
let detailSeq = 0;
async function openDetail(pkg) {
  const my = ++detailSeq;
  ptrSync(false);   // карточка открывается сверху — жест снова доступен
  ST.detail = null; ST.detailPkg = pkg; ST.detailErr = ''; ST.detailLoading = true;
  ST.comments = null; ST.commentsLoading = false; ST.commentsErr = ''; ST.commentsPage = 0; ST.commentsTotal = 0;
  let d = null, err = '';
  try { d = await info(pkg); }
  catch (e) { err = 'Ошибка: ' + e.message; }
  if (my !== detailSeq) return;   // карточку закрыли/переключили — ответ уже не наш
  ST.detail = d; ST.detailErr = err; ST.detailLoading = false;
}
// Закрытие карточки. detailLoading обязателен к сбросу: иначе оверлей
// остаётся открытым ('open' при detailLoading), и пришедший ответ показывает
// карточку заново — «закрыл, а она открылась». Счётчик гасит ответы в полёте.
function hideDetail() {
  detailSeq++;
  ptrSync(false);   // оверлея больше нет — вернуть жест на место
  ST.detail = null; ST.detailErr = ''; ST.detailLoading = false;
  ST.comments = null; ST.commentsLoading = false; ST.commentsErr = '';
}
// Отзывы грузятся лениво — по кнопке (только просмотр).
const CMT_PAGE = 10;
async function loadComments(pkg, page) {
  if (ST.commentsLoading) return;
  ST.commentsLoading = true;
  if (page === 0) { ST.comments = []; ST.commentsErr = ''; }
  try {
    const b = await comments(pkg, page, CMT_PAGE);
    if (ST.detailPkg !== pkg) return;   // карточку успели сменить/закрыть — не пишем в чужую
    const list = (b && b.content) || [];
    ST.comments = (page === 0 ? [] : (ST.comments || [])).concat(list);
    ST.commentsPage = page;
    ST.commentsTotal = (b && b.totalElements) || 0;
  } catch (e) {
    if (ST.detailPkg !== pkg) return;
    ST.commentsErr = 'Ошибка: ' + e.message; toast('Отзывы: ' + e.message);
  }
  ST.commentsLoading = false;
}
// Открытие карточки из UI — через историю (аппаратный back её закроет).
function openApp(pkg) { navPush({ tab: ST.tab, detail: pkg }); }
// Что делать с приложением из карточки: установить / обновить / открыть.
function installState(i) {
  const N = window.Native;
  if (!N || !N.installApk) return 'web';
  if (!N.isInstalled || !N.isInstalled(i.packageName)) return 'install';
  const cur = N.installedVersion ? Number(N.installedVersion(i.packageName)) : -1;
  if (cur >= 0 && Number(i.versionCode) > cur) return 'update';
  return 'open';
}
// Запись установленного приложения (нужна для признака «заморожено»).
// Список установленных грузится лениво — если его ещё нет, подгружаем.
function installedRec(pkg) {
  if (!ST.installed) refreshInstalled();
  const arr = ST.installed || [];
  for (let k = 0; k < arr.length; k++) if (arr[k].packageName === pkg) return arr[k];
  return null;
}
async function doDownload(i) {
  const pkg = i.packageName;
  const label = i.appName || i.label || pkg;
  const wasUpdate = installState(i) === 'update';
  if (installBusy()) { toast('Другая установка ещё идёт'); return; }
  // Обновление пакета системно снимает «заморозку» (enabled 2→0), поэтому замороженное
  // приложение надо разморозить до установки и заморозить обратно после (как в строке списка).
  const wasFrozen = hailOk() && isFrozen(installedRec(pkg));
  let manual = false;   // откат на системный установщик — статус установки нам неизвестен
  setBusy(pkg, 'Получаем ссылку…');
  try {
    if (wasFrozen) { hail('UNFREEZE', pkg); await sleep(900); }
    const apk = await resolveApk(i.appId, true, 'RuStore не отдал ссылку (внешний источник?)', i.signature);
    if (canNative()) {
      const res = await installApk(apk, pkg + '-' + i.versionCode + '.apk', {
        onProgress: function (got, total) { setBusy(pkg, total ? Math.round(got / total * 100) + '%' : mb(got)); },
        onPending: function (phase) {
          if (phase === 'permission') { setBusy(pkg, 'Разрешите установку'); toast('Разрешите установку из этого источника'); }
          else { setBusy(pkg, 'Разверните приложение'); toast('Скачано — вернитесь в приложение для установки'); }
        },
      });
      // installed:true — PackageInstaller-сессия вернула SUCCESS (промис ждёт реального конца
      // установки, не «открытия установщика»). installed:false — откат на ACTION_VIEW: статус
      // нам не придёт, поэтому ничего не утверждаем.
      if (res && res.installed === false) {
        manual = true;
        toast('Открыт системный установщик — подтвердите установку');
      } else {
        await sleep(700);
        const now = window.Native.installedVersion ? Number(window.Native.installedVersion(pkg)) : -1;
        if (now < 0 || now >= Number(i.versionCode)) {
          // Та же уборка, что и в строке списка: сбросить кэш info, не дать текущей проверке
          // вернуть строку обратно и убрать её из списка обновлений.
          delete updCache[pkg];
          if (updDone) updDone.add(pkg);
          ST.updates = (ST.updates || []).filter(x => x.a.packageName !== pkg);
          toast(now < 0 ? (label + ' — установлено (проверить не удалось)')
                        : (wasUpdate ? label + ' обновлён' : label + ' установлен'));
        } else toast('Установка не применилась: ' + label);
      }
    } else {
      const a = document.createElement('a');
      a.href = apk.url; a.rel = 'noopener'; a.download = '';
      document.body.appendChild(a); a.click(); a.remove();
      toast('Загрузка началась');
    }
  } catch (e) { toast('Ошибка: ' + e.message); }
  finally {
    setBusy(pkg, null);
    // Морозим обратно только если реально дождались конца установки.
    if (wasFrozen && !manual) { await sleep(1200); hail('FREEZE', pkg); }
  }
}

// ------------------------------------------------------------------ обновления
// Свой список установленных: без самого приложения и прочих webtoapk-обёрток.
function listInstalled() {
  const N = window.Native;
  if (!N || !N.installedApps) return [];
  try {
    const me = (N.appInfo() || {}).packageName;
    return (N.installedApps() || []).filter(a => a.packageName !== me && !a.packageName.endsWith('.webtoapk'));
  } catch (e) { return []; }
}
function refreshInstalled() { ST.installed = listInstalled(); }
function loadInstalled() { refreshInstalled(); }
// Иконки установленных приложений: ленивый кэш (base64 PNG из нативного моста).
const appIconCache = {};
function appIcon(pkg) {
  if (!(pkg in appIconCache)) {
    let d = '';
    try { const N = window.Native; if (N && N.appIcon) d = N.appIcon(pkg) || ''; } catch (e) {}
    appIconCache[pkg] = d;
  }
  return appIconCache[pkg];
}
// Заморозить/разморозить через Hail (работает асинхронно — перечитываем список позже).
function toggleFrozen(a) {
  if (!hailOk()) { toast('Hail не установлен'); return; }
  const fr = isFrozen(a);
  if (hail(fr ? 'UNFREEZE' : 'FREEZE', a.packageName)) {
    toast(fr ? 'Разморозка…' : 'Заморозка…');
    setTimeout(function () { refreshInstalled(); if (ST.tab === 'upd' && ST.updTab === 'upd') checkUpdates(); }, 1600);
  } else toast('Hail недоступен');
}
// Системный экран «Информация о приложении» (удаление и пр.).
function nativeAppInfo(pkg) {
  const N = window.Native;
  if (N && N.openAppInfo) N.openAppInfo(pkg);
  else toast(pkg);
}
// Тап по «Установленному»: карточка в RuStore, а если приложения там нет — системные сведения.
async function openInstalled(a) {
  try { await info(a.packageName); openApp(a.packageName); }
  catch (e) { if (netError(e)) toast('Нет сети'); else nativeAppInfo(a.packageName); }
}
async function checkUpdates(force) {
  const N = window.Native;
  if (!canNative()) return;
  if (ST.updChecking) return; // уже идёт (кнопка + pull-to-refresh + автостарт) — не плодим параллельные
  if (force) { for (const k in updCache) delete updCache[k]; } // кнопка «Проверить» — реальный опрос
  ST.updChecking = true; ST.updProgress = 'Читаем установленные…'; ST.updErr = '';
  try {
    const apps = listInstalled();
    ST.installed = apps;
    if (!apps.length) {
      // Список пуст — скорее всего нет доступа к установленным приложениям.
      ST.updates = [];
      ST.updErr = 'Нет доступа к списку приложений. Разрешите доступ к установленным приложениям.';
      ST.updChecking = false;
      return;
    }
    // Порядок фиксируем ДО опроса (по названию) и только ДОПИСЫВАЕМ в конец:
    // найденное видно сразу, но строки не переставляются — юзер не промахнётся кнопкой.
    const order = apps.slice().sort((x, y) => String(x.label || '').localeCompare(String(y.label || '')));
    // Строки уже удалённых приложений убираем сразу: order строится из текущих
    // установленных, и больше их никто не тронул бы — висели бы до перезапуска.
    const have = new Set(apps.map(a => a.packageName));
    ST.updates = (ST.updates || []).filter(x => have.has(x.a.packageName));
    const results = new Array(order.length);
    let commitAt = 0, done = 0, netFail = 0;
    // Выдаём строго по порядку (ответы приходят не по порядку) и правим АКТУАЛЬНЫЙ
    // ST.updates, а не локальную копию: иначе одиночное обновление, сделанное во
    // время проверки, «воскресало» следующим flush'ем из старой копии.
    const flush = () => {
      while (commitAt < results.length && results[commitAt] !== undefined) {
        const r = results[commitAt], pkg = order[commitAt].packageName;
        commitAt++;
        if (r === KEEP) continue;   // не смогли проверить — найденную строку не сносим
        if (updDone && updDone.has(pkg)) continue;   // только что обновили — не возвращаем
        const list = (ST.updates || []).slice();
        const at = list.findIndex(x => x.a.packageName === pkg);
        if (r) { if (at < 0) list.push(r); else list[at] = r; }  // новое — в конец
        else if (at >= 0) list.splice(at, 1);                    // обновление пропало
        ST.updates = list;          // новая ссылка -> реактивность
      }
    };
    updDone = new Set();   // пакеты, обновлённые во время этой проверки (см. flush)
    await pool(order, 3, async function (a, i) {
      let item = null, failed = false;
      try {
        let v = null;
        try { v = await infoCached(a.packageName); }
        catch (e) { if (!is404(e)) { netFail++; failed = true; } }   // 404 — приложение ушло из RuStore
        if (v && Number(v.versionCode) > Number(a.versionCode)) {
          let compatible = true;
          if (v.signature && N.installedSigner) {
            const sigs = String(N.installedSigner(a.packageName) || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
            compatible = sigs.length === 0 || sigs.indexOf(String(v.signature).toLowerCase()) >= 0;
          }
          item = { a: a, v: v, compatible: compatible };
        }
      } catch (e) { failed = true; }  // неожиданная ошибка — строку тоже не сносим
      results[i] = failed ? KEEP : item;
      done++;
      const found = (ST.updates || []).length;
      ST.updProgress = 'Проверено ' + done + '/' + order.length + (found ? '  ·  найдено: ' + found : '');
      flush();
    });
    flush();
    ST.updErr = netFail === 0 ? '' : (netFail >= order.length ? 'Нет соединения с RuStore' : ('Не удалось проверить (сеть): ' + netFail));
  } catch (e) { toast('Ошибка: ' + e.message); ST.updErr = 'Ошибка: ' + e.message; }
  updDone = null;
  ST.updChecking = false;
}
const updAllReady = () => !!(ST.updates && ST.updates.some(x => x.compatible));
// Занятость установок — в состоянии (движок проксирует вложенные объекты,
// так что ST.rowBusy[pkg] = '42%' перерисовывает только нужные места).
function installBusy() { return Object.keys(ST.rowBusy).length > 0; }
function setBusy(pkg, text) { if (text == null) delete ST.rowBusy[pkg]; else ST.rowBusy[pkg] = text; }
// prog — необязательный приёмник текста прогресса (строка массового обновления).
async function updateOne(it, prog) {
  if (!it || !it.compatible) return;
  const pkg = it.a.packageName;
  if (installBusy()) return;   // уже что-то ставится — вторую установку не начинаем
  setBusy(pkg, '…');            // сразу занимаем: до первого тика прогресса кнопка не должна быть активной
  const say = function (s) { setBusy(pkg, s); if (prog) prog(s); };
  const wasFrozen = isFrozen(it.a) && hailOk();
  const label = it.a.label || pkg;
  let manual = false;   // откат на системный установщик — статус установки нам неизвестен
  try {
    if (wasFrozen) { hail('UNFREEZE', pkg); await sleep(900); }
    const apk = await resolveApk(it.v.appId, false, it.v.aggregatorInfo ? 'внешний источник — нет прямого APK' : 'RuStore не отдал ссылку', it.v.signature);
    const res = await installApk(apk, pkg + '.apk', {
      onProgress: function (got, total) { say(total ? Math.round(got / total * 100) + '%' : '…'); },
      onPending: function (phase) {
        if (phase === 'permission') { say('Разрешите установку'); toast('Разрешите установку из этого источника'); }
        else { say('Разверните'); toast('Скачано — вернитесь в приложение для установки'); }
      },
    });
    if (res && res.installed === false) {
      // PackageInstaller-сессия не открылась -> ACTION_VIEW: система сама спросит подтверждение,
      // а нам статус не придёт. Поэтому версию не проверяем, строку не убираем и НЕ морозим
      // обратно — иначе заморозим приложение, пока его ещё ставят.
      manual = true;
      toast(label + ': подтвердите установку в системном установщике');
      return 'manual';
    }
    await sleep(700);
    const now = window.Native.installedVersion ? Number(window.Native.installedVersion(it.a.packageName)) : -1;
    if (now < 0 || now >= Number(it.v.versionCode)) {
      // now < 0 — версию не прочитать (нет доступа к списку приложений); считаем, что установка прошла.
      delete updCache[pkg]; // сбросить кэш info, иначе приложение всплывёт снова
      if (updDone) updDone.add(pkg);   // не даём текущей проверке вернуть эту строку
      ST.updates = (ST.updates || []).filter(x => x.a.packageName !== pkg);
      toast(now < 0 ? (label + ' — установлено (проверить не удалось)') : (label + ' обновлён'));
    } else {
      toast('Установка не применилась: ' + label);
    }
  } catch (e) {
    toast('Ошибка: ' + e.message);
  } finally {
    setBusy(pkg, null);
    // Вернуть заморозку (даже при ошибке) — если она была и если мы реально дождались
    // конца установки (иначе заморозим приложение прямо во время установки).
    if (wasFrozen && !manual) { await sleep(1200); hail('FREEZE', pkg); }
  }
}
async function updateAll() {
  if (ST.updAllBusy || installBusy()) return;
  const list = (ST.updates || []).filter(x => x.compatible && !ST.rowBusy[x.a.packageName]);
  if (!list.length) return;
  ST.updAllBusy = true;
  for (let i = 0; i < list.length; i++) {
    const label = list[i].a.label || list[i].a.packageName;
    const head = 'Обновляем ' + label + '  ·  ' + (i + 1) + '/' + list.length;
    ST.updBusy = head;
    let st;
    try { st = await updateOne(list[i], function (s) { ST.updBusy = head + '  ·  ' + s; }); } catch (e) {}
    // Откат на системный установщик: подтверждение ждёт пользователь — не открываем
    // следующий установщик поверх и не считаем это успехом.
    if (st === 'manual') { ST.updBusy = ''; ST.updAllBusy = false; toast('Дальше — вручную: подтвердите установку'); return; }
  }
  ST.updBusy = ''; ST.updAllBusy = false;
  toast('Готово');
}

// ------------------------------------------------------------------ самообновление
async function installSelf() {
  const j = ST.selfUpd;
  if (!j || !canNative() || installBusy()) return;
  setBusy('#self', 'получаем ссылку…');
  try {
    await installApk({ url: j.url, size: j.size, signer: j.signer }, 'webtoapk-' + j.versionCode + '.apk', {
      onProgress: function (got, total) { setBusy('#self', total ? Math.round(got / total * 100) + '%' : mb(got)); },
      onPending: function (phase) {
        if (phase === 'permission') { setBusy('#self', 'разрешите установку'); toast('Разрешите установку из этого источника'); }
        else { setBusy('#self', 'разверните приложение'); toast('Скачано — вернитесь в приложение для установки'); }
      },
    });
  } catch (e) { toast('Ошибка: ' + e.message); }
  setBusy('#self', null);
}
async function checkSelfUpdate() {
  const N = window.Native;
  if (!N || !N.appInfo || !VER_URL) return;
  try {
    const r = await httpRaw(VER_URL, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) return;
    const j = await r.json();
    const me = N.appInfo() || {};
    if (Number(j.versionCode) > Number(me.versionCode || 0)) ST.selfUpd = j;
  } catch (e) { /* нет version.json — не страшно */ }
}

// ================================================================== компоненты

const APP = memo(() => {
  DIV({ class: 'app' }) {
    TOPBAR()
    VIEW()
    DETAILVIEW()
    TOASTBAR()
  }
});

const TOPBAR = memo(() => {
  DIV({ class: 'hdr' }) {
    DIV({ class: 'bar' }) {
      DIV({ class: 'brand' }) {
        EMIT('RuStore')
        SPAN({ class: 'acc' }, 'mini')
      }
      DIV({ class: 'grow' })
      BUTTON({ class: 'ibtn', title: themeTitle(), onClick: toggleTheme }, ST.themeMode === 'auto' ? '◐' : (ST.theme === 'dark' ? '☾' : '☀'))
    }
    DIV({ class: 'tabs' }) {
      for (let i = 0; i < TABS.length; i++) {
        const t = TABS[i];
        window.ID = t.id;
        TAB(t);
      }
    }
  }
});

const TAB = memo((t) => {
  BUTTON({ class: 'tab' + (ST.tab === t.id ? ' on' : ''), onClick: () => setTab(t.id) }, t.label);
});

const VIEW = memo(() => {
  DIV({ class: 'views' }) {
    SELFBANNER()
    DIV({ class: 'view', hidden: ST.tab !== 'apps' }) { CATALOG('APPS') }
    DIV({ class: 'view', hidden: ST.tab !== 'games' }) { CATALOG('GAMES') }
    DIV({ class: 'view', hidden: ST.tab !== 'upd' }) { UPDVIEW() }
  }
});

const SELFBANNER = memo(() => {
  const busy = !!ST.rowBusy['#self'];
  DIV({ class: 'banner', hidden: !ST.selfUpd }) {
    EMIT(busy ? ('Обновляем приложение · ' + (ST.rowBusy['#self'] || '…')) : 'Доступно обновление приложения')
    BUTTON({ class: 'primary small', disabled: installBusy(), onClick: installSelf }, busy ? '…' : 'Обновить');
  }
});

// ---- каталог: поиск + подборки ----
const CATALOG = memo((kind) => {
  DIV({ class: 'pane' }) {
    SEARCHBAR()
    if (ST.query && ST.suggests && ST.suggests.length) SUGGLIST()
    if (ST.results !== null) RESULTS()
    else RAILS(kind)
  }
});

const SEARCHBAR = memo(() => {
  DIV({ class: 'searchwrap' }) {
    INPUT({
      class: 'q', type: 'search', placeholder: 'Поиск приложений…', value: ST.query,
      autocomplete: 'off', enterkeyhint: 'search', onInput: onQuery, onKeydown: onQueryKey,
    });
  }
});

const RAILS = memo((kind) => {
  DIV({ class: 'rails' }) {
    if (ST.homeLoading[kind]) DIV({ class: 'hint' }, 'Загружаем подборки…');
    else if (ST.homeErr[kind]) {
      DIV({ class: 'hint' }, ST.homeErr[kind]);
      DIV({ class: 'mid' }) { BUTTON({ class: 'ghost', onClick: () => loadHome(kind) }, 'Повторить') }
    } else if (ST.homes[kind]) {
      if (!ST.homes[kind].length) DIV({ class: 'hint' }, 'Пусто');
      else for (let i = 0; i < ST.homes[kind].length; i++) {
        const r = ST.homes[kind][i];
        window.ID = r.id;
        RAIL(r);
      }
    }
  }
});

const RAIL = memo((r) => {
  DIV({ class: 'rail' }) {
    DIV({ class: 'railhead' }) {
      DIV({ class: 'railtitle' }, r.title || '');
      if (r.sub) DIV({ class: 'railsub' }, r.sub);
    }
    DIV({ class: 'railbody' }) {
      for (let i = 0; i < r.apps.length; i++) {
        const a = r.apps[i];
        window.ID = a.packageName;
        TILE(a);
      }
    }
  }
});

const TILE = memo((a) => {
  DIV({ class: 'tile', onClick: () => openApp(a.packageName) }) {
    if (a.iconUrl) IMG({ class: 'tic', src: safeUrl(a.iconUrl), loading: 'lazy', referrerpolicy: 'no-referrer', alt: '' });
    else DIV({ class: 'tic ph' }, (a.appName || a.packageName || '?').trim().charAt(0).toUpperCase());
    DIV({ class: 'tname' }, a.appName || a.packageName);
    if (a.averageUserRating) DIV({ class: 'trate' }, '★ ' + a.averageUserRating);
  }
});

// ---- результаты поиска ----
const RESULTS = memo(() => {
  DIV({ class: 'rlist' }) {
    if (ST.searching) DIV({ class: 'hint' }, 'Поиск…');
    else if (!ST.results.length) DIV({ class: 'hint' }, 'Ничего не найдено');
    else for (let i = 0; i < ST.results.length; i++) {
      const a = ST.results[i];
      window.ID = a.packageName;
      RCARD(a);
    }
  }
});

const SUGGLIST = memo(() => {
  DIV({ class: 'sugg' }) {
    for (let i = 0; i < ST.suggests.length; i++) {
      const s = ST.suggests[i];
      window.ID = (s.packageName || ('t:' + s.text)) + '#' + i;
      SUGROW(s);
    }
  }
});

const SUGROW = memo((s) => {
  DIV({ class: 'sugrow', onClick: () => pickSuggest(s) }) {
    if (s.iconUrl) IMG({ class: 'sic', src: safeUrl(s.iconUrl), loading: 'lazy', referrerpolicy: 'no-referrer', alt: '' });
    else SPAN({ class: 'sic em' }, s.packageName ? '📦' : '🔎');
    DIV({ class: 'sugtxt' }, s.text);
  }
});

const RCARD = memo((a) => {
  DIV({ class: 'rcard', onClick: () => openApp(a.packageName) }) {
    if (a.iconUrl) IMG({ class: 'ric', src: safeUrl(a.iconUrl), loading: 'lazy', referrerpolicy: 'no-referrer', alt: '' });
    else DIV({ class: 'ric ph' }, (a.appName || a.packageName || '?').trim().charAt(0).toUpperCase());
    DIV({ class: 'rct' }) {
      DIV({ class: 'cname' }) { SPAN({ class: 'nm' }, a.appName || a.packageName); }
      DIV({ class: 'cpkg' }, a.packageName);
      if (a.averageUserRating) DIV({ class: 'crate' }) {
        EMIT('★ ' + a.averageUserRating);
        if (a.roundedDownloadsText) SPAN({ class: 'muted' }, '  ·  ' + a.roundedDownloadsText);
      }
    }
  }
});

// ---- обновления / установленные ----
const UPDVIEW = memo(() => {
  DIV({ class: 'pane' }) {
    if (!canNative()) {
      DIV({ class: 'hint' }, 'Список приложений доступен только внутри обёртки RuStore mini.');
    } else {
      DIV({ class: 'seg' }) {
        SEGUPD('upd', 'Обновления');
        SEGUPD('installed', 'Установленные');
      }
      DIV({ class: 'sub', hidden: ST.updTab !== 'upd' }) { UPDATESVIEW() }
      DIV({ class: 'sub', hidden: ST.updTab !== 'installed' }) { INSTALLEDVIEW() }
    }
  }
});

const SEGUPD = memo((id, label) => {
  BUTTON({ class: 'segbtn' + (ST.updTab === id ? ' on' : ''), onClick: () => { ST.updTab = id; ensureUpdData(); } }, label);
});

const UPDATESVIEW = memo(() => {
  DIV({ class: 'sub' }) {
    DIV({ class: 'updbar' }) {
      BUTTON({ class: 'ghost', onClick: () => checkUpdates(true) }, 'Проверить');
      BUTTON({ class: 'primary', disabled: ST.updChecking || ST.updAllBusy || !updAllReady(), onClick: updateAll }, 'Обновить все');
    }
    UPDHINT()
    // Найденное показываем сразу, не дожидаясь конца проверки (только дописываем в конец).
    if (ST.updates && ST.updates.length) {
      for (let i = 0; i < ST.updates.length; i++) {
        const it = ST.updates[i];
        window.ID = it.a.packageName;
        UPDROW(it);
      }
    } else if (!ST.updChecking) {
      if (!ST.updates) DIV({ class: 'hint' }, 'Нажмите «Проверить обновления».');
      else if (ST.updErr) DIV({ class: 'mid' }) { BUTTON({ class: 'ghost', onClick: () => checkUpdates(true) }, 'Повторить') }
      else DIV({ class: 'hint' }, 'Обновлений нет 🎉');
    }
  }
});

// Прогресс/ошибка — отдельным компонентом: иначе UPDATESVIEW перерисовывался бы на
// каждом тике прогресса (54 раза) и дёргал бы строки списка без надобности.
// Высоту строки резервируем всегда (.off -> visibility) — иначе список съезжает.
// Приоритет: прогресс массового обновления -> прогресс проверки -> ошибка.
const UPDHINT = memo(() => {
  const t = ST.updBusy || (ST.updChecking ? (ST.updProgress || 'Проверяем…') : (ST.updErr || ''));
  DIV({ class: 'hint stat' + (t ? '' : ' off') + (ST.updBusy ? ' busy' : '') }, t);
});

const UPDROW = memo((it) => {
  const fr = isFrozen(it.a);
  DIV({ class: 'rcard', onClick: () => openApp(it.a.packageName) }) {
    if (it.v.iconUrl) IMG({ class: 'ric', src: safeUrl(it.v.iconUrl), loading: 'lazy', referrerpolicy: 'no-referrer', alt: '' });
    else DIV({ class: 'ric ph' }, (it.a.label || it.a.packageName || '?').trim().charAt(0).toUpperCase());
    DIV({ class: 'rct' }) {
      DIV({ class: 'cname' }) {
        SPAN({ class: 'nm' }, it.a.label || it.a.packageName);
        if (fr) SPAN({ class: 'snow' }, '❄');
      }
      DIV({ class: 'cpkg' }, it.a.packageName);
      DIV({ class: 'cver' }) {
        EMIT((it.a.versionName || '') + ' (' + it.a.versionCode + ') → ');
        SPAN({ class: 'acc' }, (it.v.versionName || '') + ' (' + it.v.versionCode + ')');
      }
      if (!it.compatible) DIV({ class: 'bad' }, 'другая подпись — обновление недоступно');
    }
    if (it.compatible) BUTTON({
      class: 'primary small',
      disabled: ST.updAllBusy || installBusy(),
      onClick: (e) => { e.stopPropagation(); updateOne(it); },
    }, ST.rowBusy[it.a.packageName] || 'Обновить');
    else BUTTON({ class: 'ghost small', disabled: true }, 'Недоступно');
  }
});

const INSTALLEDVIEW = memo(() => {
  DIV({ class: 'sub' }) {
    if (!ST.installed) DIV({ class: 'hint' }, 'Загрузка…');
    else if (!ST.installed.length) DIV({ class: 'hint' }, 'Нет доступа к списку приложений. Разрешите доступ к установленным приложениям.');
    else {
      const frozen = ST.installed.filter(isFrozen);
      const normal = ST.installed.filter(a => !isFrozen(a));
      DIV({ class: 'insthead' }, 'Приложений: ' + ST.installed.length + (frozen.length ? '  ·  заморожено: ' + frozen.length : ''));
      if (normal.length) {
        DIV({ class: 'sechead' }, 'Установленные');
        for (let i = 0; i < normal.length; i++) { window.ID = normal[i].packageName; IROW(normal[i]); }
      }
      if (frozen.length) {
        DIV({ class: 'sechead' }, 'Замороженные (Hail)');
        for (let i = 0; i < frozen.length; i++) { window.ID = frozen[i].packageName; IROW(frozen[i]); }
      }
    }
  }
});

const IROW = memo((a) => {
  const fr = isFrozen(a);
  const ic = appIcon(a.packageName);
  DIV({ class: 'rcard', onClick: () => openInstalled(a) }) {
    if (ic) IMG({ class: 'ric', src: ic, alt: '' });
    else DIV({ class: 'ric ph' }, (a.label || a.packageName || '?').trim().charAt(0).toUpperCase());
    DIV({ class: 'rct' }) {
      DIV({ class: 'cname' }) {
        SPAN({ class: 'nm' }, a.label || a.packageName);
        if (fr) SPAN({ class: 'snow' }, '❄');
      }
      DIV({ class: 'cpkg' }, a.packageName + (a.versionName ? '  ·  ' + a.versionName : ''));
    }
    DIV({ class: 'iact' }) {
      BUTTON({ class: 'ibtn sm', title: 'Открыть', onClick: (e) => { e.stopPropagation(); launch(a.packageName, fr); } }, '▶');
      if (fr && hailOk()) BUTTON({ class: 'ibtn sm', title: 'Разморозить', onClick: (e) => { e.stopPropagation(); toggleFrozen(a); } }, '☀');
      BUTTON({ class: 'ibtn sm', title: 'Сведения', onClick: (e) => { e.stopPropagation(); nativeAppInfo(a.packageName); } }, 'ⓘ');
    }
  }
});

// ---- карточка приложения (оверлей) ----
const DETAILVIEW = memo(() => {
  DIV({ class: 'detail' + (ST.detail || ST.detailLoading || ST.detailErr ? ' open' : '') }) {
    DIV({ class: 'dhead' }) {
      BUTTON({ class: 'ibtn', onClick: closeDetail }, '✕');
      DIV({ class: 'grow' });
      if (ST.detail) BUTTON({ class: 'ibtn', onClick: () => shareApp(ST.detail) }, '↗');
    }
    if (ST.detailLoading) DIV({ class: 'hint' }, 'Загрузка…');
    else if (ST.detailErr) {
      DIV({ class: 'hint' }, ST.detailErr);
      if (ST.detailPkg) {
        DIV({ class: 'mid' }) { BUTTON({ class: 'ghost', onClick: () => nativeAppInfo(ST.detailPkg) }, 'Сведения о приложении') }
        DIV({ class: 'mid' }) { BUTTON({ class: 'ghost', onClick: () => openExt('https://www.rustore.ru/catalog/app/' + ST.detailPkg) }, 'Открыть на сайте') }
      }
    }
    else if (ST.detail) DETAILBODY(ST.detail);
  }
});

const DETAILBODY = memo((i) => {
  const sh = shotlist(i);
  DIV({ class: 'dbody', onScroll: (e) => ptrSync(e.target.scrollTop > 0) }) {
    DIV({ class: 'dtop' }) {
      if (i.iconUrl) IMG({ class: 'dic', src: safeUrl(i.iconUrl), referrerpolicy: 'no-referrer', alt: '' })
      DIV({ class: 'dinfo' }) {
        DIV({ class: 'dname' }, i.appName || i.packageName);
        if (i.companyName) DIV({ class: 'dco' }, i.companyName);
        DIV({ class: 'chips' }) {
          if (i.versionName) CHIP('v' + i.versionName);
          if (i.fileSize) CHIP(mb(i.fileSize));
          if (i.minSdkVersion) CHIP('Android ' + i.minSdkVersion + '+');
          if (i.downloads) CHIP(fnum(i.downloads) + ' загрузок');
        }
      }
    }
    if (i.aggregatorInfo) DIV({ class: 'warn' }, '⚠ Внешний источник: прямой APK может быть недоступен.');
    if (sh.length) {
      DIV({ class: 'shots' }) {
        for (let k = 0; k < sh.length; k++) {
          window.ID = 'shot' + k;
          IMG({ class: 'shot', src: safeUrl(sh[k]), loading: 'lazy', referrerpolicy: 'no-referrer', alt: '' });
        }
      }
    }
    if (i.shortDescription) DIV({ class: 'desc' }, i.shortDescription);
    if (i.whatsNew) {
      DIV({ class: 'sechead' }, 'Что нового');
      DIV({ class: 'desc' }, i.whatsNew);
    }
    DIV({ class: 'rows' }) {
      ROW('Пакет', i.packageName);
      ROW('Версия', (i.versionName || '') + ' (' + i.versionCode + ')');
      ROW('Обновлено', fdate(i.appVerUpdatedAt));
      if (i.fileSize) ROW('Размер', mb(i.fileSize));
    }
    COMMENTS(i.packageName);
    DIV({ class: 'dacts' }) {
      BUTTON({ class: 'ghost', onClick: () => openExt('https://www.rustore.ru/catalog/app/' + i.packageName) }, 'На сайте');
      const st = installState(i);
      BUTTON({ class: 'primary', disabled: installBusy(),
        onClick: () => st === 'open' ? (window.Native.launchApp && window.Native.launchApp(i.packageName)) : doDownload(i) },
        ST.rowBusy[i.packageName] || (installBusy() ? 'Занято…'
          : (st === 'update' ? 'Обновить' : st === 'open' ? 'Открыть' : st === 'install' ? 'Установить' : 'Скачать APK')));
    }
  }
});

const CHIP = memo((t) => {
  SPAN({ class: 'chip' }, t);
});

const ROW = memo((k, v) => {
  DIV({ class: 'row' }) {
    SPAN({ class: 'rk' }, k);
    SPAN({ class: 'rv' }, v);
  }
});

const COMMENTS = memo((pkg) => {
  DIV({ class: 'cmts' }) {
    if (ST.comments === null) {
      BUTTON({ class: 'ghost wide', onClick: () => loadComments(pkg, 0) }, 'Показать отзывы');
    } else {
      DIV({ class: 'cmt-title' }, 'Отзывы' + (ST.commentsTotal ? ' · ' + fnum(ST.commentsTotal) : ''));
      if (ST.commentsLoading && !(ST.comments || []).length) DIV({ class: 'hint' }, 'Загрузка…');
      if (ST.commentsErr) DIV({ class: 'hint' }, ST.commentsErr);
      if (!ST.commentsLoading && ST.comments && !ST.comments.length) DIV({ class: 'hint' }, 'Отзывов пока нет');
      const list = ST.comments || [];
      for (let k = 0; k < list.length; k++) {
        window.ID = 'cmt' + (list[k].commentId || k);
        CMTROW(list[k]);
      }
      if (list.length && list.length < ST.commentsTotal) {
        BUTTON({ class: 'ghost wide', disabled: ST.commentsLoading, onClick: () => loadComments(pkg, ST.commentsPage + 1) }, ST.commentsLoading ? 'Загрузка…' : 'Показать ещё');
      }
    }
  }
});

const CMTROW = memo((c) => {
  DIV({ class: 'cmt' }) {
    DIV({ class: 'cmt-head' }) {
      SPAN({ class: 'cmt-name' }, c.firstName || 'Аноним');
      SPAN({ class: 'cmt-stars' }, stars(c.appRating));
      SPAN({ class: 'grow' });
      SPAN({ class: 'cmt-date' }, fdate(c.commentDate));
    }
    DIV({ class: 'cmt-text' }, c.commentText || '');
    if (c.devResponse) {
      DIV({ class: 'cmt-dev' }) {
        DIV({ class: 'cmt-dev-t' }, 'Ответ разработчика');
        DIV({ class: 'cmt-text' }, c.devResponse);
      }
    }
  }
});

const TOASTBAR = memo(() => {
  DIV({ class: 'toast' + (ST.toast ? ' show' : ''), onClick: () => toast('') }, ST.toast);
});

// ------------------------------------------------------------------ старт
applyTheme();
loadHome('APPS');
ensureUpdData();
checkSelfUpdate();
mount(document.getElementById('root'), APP);

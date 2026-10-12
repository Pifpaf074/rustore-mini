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
// version.json APK лежит на нашем сервере: из bundled-сайта он кросс-доменный,
// поэтому читаем его нативным httpGet (без CORS).
const VER_URL = 'https://example.com/rustore/version.json';

const safeUrl = u => u ? String(u).replace('//static-m.rustore.ru/', '//static.rustore.ru/') : '';
const mb    = n => n ? (n / 1048576).toFixed(1) + ' МБ' : '—';
const fnum  = n => Number(n || 0).toLocaleString('ru-RU');
const fdate = s => s ? new Date(s).toLocaleDateString('ru-RU') : '—';

// fetch с таймаутом: без него офлайн запросы висят бесконечно («читаем установленные…»).
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

// Простые GET без кастомных заголовков (не требуют CORS-preflight).
// Один разбор ответа для всех API. strict: у backapi ошибка — любой code кроме 'OK',
// у нового API — только 'ERROR'.
async function jfetch(url, opts, strict) {
  const r = await fetchT(url, opts);
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
// Запросы, где обязателен RuStoreVerCode (download-link) — добавляем заголовок (с preflight).
async function apiH(path, opts) {
  const o = Object.assign({ headers: Object.assign({}, HDR) }, opts || {});
  if (o.body != null && !o.headers['Content-Type']) o.headers['Content-Type'] = 'application/json';
  return (await jfetch(API + path, o, true)).body;
}
async function getNew(path) { return jfetch(API_NEW + path, null, false); }
const search = (q, page, size) =>
  api('/applicationData/apps?pageNumber=' + (page || 0) + '&pageSize=' + (size || 20) + '&query=' + encodeURIComponent(q));
// overallInfo требует заголовок RuStoreVerCode, но его добавляет нативный слой
// (перехват в shouldInterceptRequest) — из JS шлём БЕЗ заголовка, без preflight.
const info = pkg => api('/applicationData/overallInfo/' + encodeURIComponent(pkg));
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
    const r = await fetchT(API_NEW + '/v3/showcase/apps/download-link',
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
  const worker = async () => { while (i < items.length) { const k = i++; await fn(items[k]); } };
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
  dlBusy: false, dlLabel: '',
  selfUpd: null,
  updTab: 'upd', updates: null, updChecking: false, updProgress: '', updErr: '',
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
  toastT = setTimeout(function () { ST.toast = ''; }, 2800);
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
  else { ST.detail = null; ST.detailErr = ''; }
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
  else { ST.detail = null; ST.detailErr = ''; }
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
function onQuery(e) {
  const v = e.target.value;
  const had = searchActive();
  ST.query = v;
  if (!v.trim()) {
    clearSearch();
    if (had && !navStack.length && navArmed) history.back(); // снять сторожевой энти без «пустого» back
  }
  clearTimeout(qT);
  qT = setTimeout(function () { loadSuggests(v); }, 300);
}
function onQueryKey(e) {
  if (e.key === 'Enter') { e.target.blur(); ST.suggests = []; runSearch(ST.query); }
}
async function loadSuggests(q) {
  q = String(q || '').trim();
  if (q.length < 2) { ST.suggests = []; return; }
  try {
    const r = await fetchT(API_WEB + '/v1/showcase/web/search/suggests?query=' + encodeURIComponent(q));
    const j = await r.json();
    if (String(ST.query).trim() !== q) return; // устарело
    ST.suggests = (j.suggests || []).slice(0, 8);
  } catch (e) { ST.suggests = []; }
}
async function runSearch(q) {
  q = String(q || '').trim();
  if (!q) return;
  ST.searching = true; ST.results = null;
  try {
    const b = await search(q);
    ST.results = (b && b.content) || [];
  } catch (e) { ST.results = []; toast('Ошибка: ' + e.message); }
  ST.searching = false;
  armSentinel(); // чтобы back вернул из поиска к каталогу, а не вышел
}
function pickSuggest(s) {
  ST.suggests = [];
  if (s.packageName) navPush({ tab: ST.tab, detail: s.packageName });
  else { ST.query = s.text; runSearch(s.text); }
}

// ------------------------------------------------------------------ карточка приложения
async function openDetail(pkg) {
  ST.detail = null; ST.detailPkg = pkg; ST.detailErr = ''; ST.detailLoading = true; ST.dlBusy = false; ST.dlLabel = '';
  ST.comments = null; ST.commentsLoading = false; ST.commentsErr = ''; ST.commentsPage = 0; ST.commentsTotal = 0;
  try { ST.detail = await info(pkg); }
  catch (e) { ST.detailErr = 'Ошибка: ' + e.message; }
  ST.detailLoading = false;
}
// Отзывы грузятся лениво — по кнопке (только просмотр).
const CMT_PAGE = 10;
async function loadComments(pkg, page) {
  if (ST.commentsLoading) return;
  ST.commentsLoading = true;
  if (page === 0) { ST.comments = []; ST.commentsErr = ''; }
  try {
    const b = await comments(pkg, page, CMT_PAGE);
    const list = (b && b.content) || [];
    ST.comments = (page === 0 ? [] : (ST.comments || [])).concat(list);
    ST.commentsPage = page;
    ST.commentsTotal = (b && b.totalElements) || 0;
  } catch (e) { ST.commentsErr = 'Ошибка: ' + e.message; toast('Отзывы: ' + e.message); }
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
async function doDownload(i) {
  ST.dlBusy = true; ST.dlLabel = 'Получаем ссылку…';
  try {
    const apk = await resolveApk(i.appId, true, 'RuStore не отдал ссылку (внешний источник?)', i.signature);
    if (canNative()) {
      await installApk(apk, i.packageName + '-' + i.versionCode + '.apk', {
        onProgress: function (got, total) { ST.dlLabel = total ? Math.round(got / total * 100) + '%' : mb(got); },
        onPending: function () { ST.dlLabel = 'Разверните приложение'; toast('Скачано — вернитесь в приложение для установки'); },
      });
      toast('Установщик открыт');
    } else {
      const a = document.createElement('a');
      a.href = apk.url; a.rel = 'noopener'; a.download = '';
      document.body.appendChild(a); a.click(); a.remove();
      toast('Загрузка началась');
    }
  } catch (e) { toast('Ошибка: ' + e.message); }
  ST.dlBusy = false; ST.dlLabel = '';
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
    let done = 0, netFail = 0;
    const found = [];
    await pool(apps, 3, async function (a) {
      let v = null;
      try { v = await infoCached(a.packageName); }
      catch (e) { if (!is404(e)) netFail++; }
      if (v && Number(v.versionCode) > Number(a.versionCode)) {
        let compatible = true;
        if (v.signature && N.installedSigner) {
          const sigs = String(N.installedSigner(a.packageName) || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
          compatible = sigs.length === 0 || sigs.indexOf(String(v.signature).toLowerCase()) >= 0;
        }
        found.push({ a: a, v: v, compatible: compatible });
      }
      done++;
      ST.updProgress = 'Проверено ' + done + '/' + apps.length;
    });
    ST.updates = found.sort((x, y) => String(x.a.label || '').localeCompare(String(y.a.label || '')));
    ST.updErr = netFail === 0 ? '' : (netFail >= apps.length ? 'Нет соединения с RuStore' : ('Не удалось проверить (сеть): ' + netFail));
  } catch (e) { toast('Ошибка: ' + e.message); ST.updates = []; ST.updErr = 'Ошибка: ' + e.message; }
  ST.updChecking = false;
}
const updAllReady = () => !!(ST.updates && ST.updates.some(x => x.compatible));
async function updateOne(it, btn) {
  if (!it || !it.compatible) return;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  const wasFrozen = isFrozen(it.a) && hailOk();
  const label = it.a.label || it.a.packageName;
  try {
    if (wasFrozen) { hail('UNFREEZE', it.a.packageName); await sleep(900); }
    const apk = await resolveApk(it.v.appId, false, it.v.aggregatorInfo ? 'внешний источник — нет прямого APK' : 'RuStore не отдал ссылку', it.v.signature);
    await installApk(apk, it.a.packageName + '.apk', {
      onPermission: function () { if (btn) btn.textContent = 'Разрешите…'; },
      onProgress: function (got, total) { if (btn) btn.textContent = total ? Math.round(got / total * 100) + '%' : '…'; },
      onPending: function () { if (btn) btn.textContent = 'Разверните'; toast('Скачано — вернитесь в приложение для установки'); },
    });
    await sleep(700);
    const now = window.Native.installedVersion ? Number(window.Native.installedVersion(it.a.packageName)) : -1;
    if (now < 0 || now >= Number(it.v.versionCode)) {
      // now < 0 — версию не прочитать (нет доступа к списку приложений); считаем, что установка прошла.
      delete updCache[it.a.packageName]; // сбросить кэш info, иначе приложение всплывёт снова
      ST.updates = (ST.updates || []).filter(x => x.a.packageName !== it.a.packageName);
      toast(now < 0 ? (label + ' — установлено (проверить не удалось)') : (label + ' обновлён'));
    } else {
      toast('Установка не применилась: ' + label);
      if (btn) { btn.disabled = false; btn.textContent = 'Обновить'; }
    }
  } catch (e) {
    toast('Ошибка: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Обновить'; }
  } finally {
    // Вернуть заморозку (даже при ошибке) — если она была.
    if (wasFrozen) { await sleep(1200); hail('FREEZE', it.a.packageName); }
  }
}
async function updateAll() {
  const list = (ST.updates || []).filter(x => x.compatible);
  for (let i = 0; i < list.length; i++) {
    toast('Обновляем ' + (list[i].a.label || list[i].a.packageName) + '…');
    try { await updateOne(list[i], null); } catch (e) {}
  }
  toast('Готово');
}

// ------------------------------------------------------------------ самообновление
async function installSelf() {
  const j = ST.selfUpd;
  if (!j || !canNative()) return;
  toast('Устанавливаем обновление приложения…');
  try {
    await installApk({ url: j.url, size: j.size, signer: j.signer }, 'webtoapk-' + j.versionCode + '.apk');
  } catch (e) { toast('Ошибка: ' + e.message); }
}
async function checkSelfUpdate() {
  const N = window.Native;
  if (!N || !N.appInfo) return;
  try {
    const body = N.httpGet ? N.httpGet(VER_URL) : '';
    if (!body) return;
    const j = JSON.parse(body);
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
  DIV({ class: 'banner', hidden: !ST.selfUpd }) {
    EMIT('Доступно обновление приложения')
    BUTTON({ class: 'primary small', onClick: installSelf }, 'Обновить');
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
      BUTTON({ class: 'primary', disabled: !updAllReady(), onClick: updateAll }, 'Обновить все');
    }
    if (ST.updChecking) DIV({ class: 'hint' }, ST.updProgress || 'Проверяем…');
    else if (ST.updErr && (!ST.updates || !ST.updates.length)) {
      DIV({ class: 'hint' }, ST.updErr);
      DIV({ class: 'mid' }) { BUTTON({ class: 'ghost', onClick: () => checkUpdates(true) }, 'Повторить') }
    }
    else if (!ST.updates) DIV({ class: 'hint' }, 'Нажмите «Проверить обновления».');
    else if (!ST.updates.length) DIV({ class: 'hint' }, 'Обновлений нет 🎉');
    else {
      if (ST.updErr) DIV({ class: 'hint' }, ST.updErr);
      for (let i = 0; i < ST.updates.length; i++) {
        const it = ST.updates[i];
        window.ID = it.a.packageName;
        UPDROW(it);
      }
    }
  }
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
    if (it.compatible) BUTTON({ class: 'primary small', onClick: (e) => { e.stopPropagation(); updateOne(it, e.currentTarget); } }, 'Обновить');
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
  DIV({ class: 'dbody' }) {
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
      BUTTON({ class: 'primary', disabled: ST.dlBusy,
        onClick: () => st === 'open' ? (window.Native.launchApp && window.Native.launchApp(i.packageName)) : doDownload(i) },
        ST.dlBusy ? (ST.dlLabel || 'Установка…')
          : (st === 'update' ? 'Обновить' : st === 'open' ? 'Открыть' : st === 'install' ? 'Установить' : 'Скачать APK'));
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
  DIV({ class: 'toast' + (ST.toast ? ' show' : '') }, ST.toast);
});

// ------------------------------------------------------------------ старт
applyTheme();
loadHome('APPS');
ensureUpdData();
checkSelfUpdate();
// Разрешение на уведомления — чтобы видеть прогресс фоновой загрузки (спрашиваем один раз).
try {
  const N0 = window.Native;
  if (N0 && N0.hasNotifications && N0.requestNotifications && !N0.hasNotifications() && !localStorage.getItem('rs_notif_asked')) {
    localStorage.setItem('rs_notif_asked', '1');
    N0.requestNotifications();
  }
} catch (e) {}
mount(document.getElementById('root'), APP);

// Ревью: кэш карточек (ST.meta + localStorage) никогда не чистился от протухших записей —
// при 7-дневном TTL он рос вечно и однажды упёрся бы в квоту localStorage (setItem молча
// падает в catch, и кэш перестаёт сохраняться). Проверяем: записи старше TTL выбрасываются
// при загрузке и не попадают в сохранённую копию, свежие остаются.
// BASE=8099 — новый код; негативный контроль — ревизия до фикса (38d1faf на 8098).
const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const j = await (await fetch('http://127.0.0.1:9223/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(j.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const send = (m, p) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); const d = r.result;
  if (d && d.exceptionDetails) return 'ERR ' + d.exceptionDetails.exception.description.split('\n')[0];
  return d && d.result ? d.result.value : undefined; };
await send('Runtime.enable'); await send('Page.enable');
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });

const stub = `
(function(){
  // Сид кэша ДО запуска app.js: одна свежая запись и одна старше META_TTL (7 дней).
  try {
    localStorage.setItem('rs_meta_v1', JSON.stringify({
      old:   { packageName:'old',   appName:'Old',   versionCode:1, ts: Date.now() - 8*24*3600*1000 },
      fresh: { packageName:'fresh', appName:'Fresh', versionCode:1, ts: Date.now() }
    }));
  } catch (e) {}
  window.WebToApk = {
    getInstalledApps: function(){ return '[]'; }, getInstalledVersion: function(){ return 0; },
    getInstalledSigner: function(){ return ''; }, isPackageInstalled: function(){ return false; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.mine.webtoapk',versionCode:26,versionName:'2.9.7'}); },
    getDeviceInfo: function(){ return '{}'; }, hailAvailable: function(){ return false; },
    hailAction: function(){ return false; }, getAppIcon: function(){ return ''; }, installApk: function(){},
    openAppInfo: function(){}, launchApp: function(){ return true; }, openExternal: function(){},
    clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''), body = {};
    if (/showcase\\/sections/.test(url)) body = { code:'OK', body:{ elements:[] } };
    else if (/popular\\/apps/.test(url)) body = { apps: [{ packageName:'com.pop', appId:1, verCode:1 }] };
    else if (/applicationData\\/apps/.test(url)) body = { code:'OK', body:{ content:[{ packageName:'com.pop', appName:'Pop', versionCode:1, appId:1, iconUrl:'' }] } };
    else if (/overallInfo/.test(url)) body = { code:'OK', body:{ packageName:'com.pop', appName:'Pop', versionCode:1 } };
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:200, responseText: JSON.stringify(body) }); }, 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 5000));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stats = async () => JSON.parse((await ev(`JSON.stringify(window.__cacheStats ? window.__cacheStats() : null)`)) || '{}') || {};

console.log('1) сид кэша: old (8 дней) + fresh (сейчас)');
const s1 = await stats();
console.log('   записей в ST.meta:', s1.meta, s1.meta === 1 ? 'OK (протухшая выброшена при загрузке)' : 'ПРОВАЛ (осталась ' + s1.meta + ')');
console.log('   свежая запись на месте:', await ev(`(function(){ var m=JSON.parse(localStorage.getItem('rs_meta_v1')||'{}'); return !!(m.fresh); })()`) ? 'OK' : '—');

console.log('2) открываю «Приложения» (загрузит мету com.pop и сохранит кэш):');
console.log('   ', await ev(`(function(){ var b=Array.prototype.filter.call(document.querySelectorAll('.tab'),function(e){return e.textContent==='Приложения';}); if(!b.length) return 'НЕТ'; b[0].click(); return 'ok'; })()`));
await sleep(2500);
const s2 = await stats();
const saved = JSON.parse((await ev(`localStorage.getItem('rs_meta_v1') || '{}'`)) || '{}');
const keys = Object.keys(saved).sort();
console.log('   в ST.meta:', s2.meta, '| в localStorage:', JSON.stringify(keys));
console.log('   протухшей записи нет:', keys.indexOf('old') < 0 ? 'OK (в сохранённую копию не попала)' : 'ПРОВАЛ (old сохранён)');
console.log('   свежая и новая на месте:', (keys.indexOf('fresh') >= 0 && keys.indexOf('com.pop') >= 0) ? 'OK' : 'ПРОВАЛ (' + keys.join(',') + ')');
console.log('   в localStorage осталось записей:', keys.length);
ws.close();

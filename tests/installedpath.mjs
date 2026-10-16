// Ревью: checkUpdates писал ST.installed напрямую, в обход refreshInstalled — не сбрасывал
// hailAvail и не чистил ST.icons. Проверяем, что после проверки обновлений кэш Hail
// перечитывается (снежинки появляются) и иконки исчезнувших пакетов выкидываются.
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
  var B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  window.__hailOk = false; window.__hailCalls = 0;
  window.__apps = [
    { packageName:'com.a', label:'App A', versionName:'1.0', versionCode:1, enabled:true, suspended:false },
    { packageName:'com.b', label:'App B', versionName:'1.0', versionCode:1, enabled:true, suspended:false },
    { packageName:'com.c', label:'App C', versionName:'1.0', versionCode:1, enabled:true, suspended:false }
  ];
  window.__drop = function(pkg){ window.__apps = window.__apps.filter(function(a){ return a.packageName !== pkg; }); };
  // Hail в режиме DISABLE = pm disable-user: enabled=2 (false).
  window.__freezeAll = function(){ window.__apps.forEach(function(a){ a.enabled = false; }); };
  window.WebToApk = {
    getInstalledApps: function(){ return JSON.stringify(window.__apps); },
    getInstalledVersion: function(){ return 1; }, getInstalledSigner: function(){ return ''; },
    isPackageInstalled: function(){ return true; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.mine.webtoapk',versionCode:26,versionName:'2.9.7'}); },
    getDeviceInfo: function(){ return '{}'; },
    hailAvailable: function(){ window.__hailCalls++; return window.__hailOk; },
    hailAction: function(){ return true; },
    getAppIcon: function(){ return B64; },
    installApk: function(){}, openAppInfo: function(){}, launchApp: function(){ return true; },
    openExternal: function(){}, clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''), body = null;
    if (/overallInfo\\/([^/?]+)/.test(url)) body = { code:'OK', body:{ packageName:RegExp.$1, appName:'App', versionName:'1.0', versionCode:1, appId:1 } };
    else if (/showcase\\/sections/.test(url)) body = { code:'OK', body:{ elements:[] } };
    else if (/popular\\/apps/.test(url)) body = { apps: [] };
    else if (/applicationData\\/apps/.test(url)) body = { code:'OK', body:{ content:[] } };
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    else body = {};
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:200, responseText: JSON.stringify(body) }); }, 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 6000));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clickSeg = (label) => ev(`(function(){ var b=Array.prototype.filter.call(document.querySelectorAll('.segbtn'),function(e){return e.textContent===${JSON.stringify(label)};}); if(!b.length) return 'НЕТ'; b[0].click(); return 'ok'; })()`);
const snow = () => ev(`document.querySelectorAll('.sub .snow').length`);
const rows = () => ev(`document.querySelectorAll('.sub .rcard').length`);
const stats = async () => JSON.parse((await ev(`JSON.stringify(window.__cacheStats ? window.__cacheStats() : null)`)) || '{}') || {};

console.log('1) открываю «Установленные» (Hail выключен):', await clickSeg('Установленные'));
await sleep(2500);
console.log('   строк:', await rows(), '| снежинок:', await snow(), '| вызовов hailAvailable:', await ev('window.__hailCalls'));
console.log('   кэши:', JSON.stringify(await stats()));

// Hail «появился», одно приложение удалено. Проверка обновлений читает список — и должна
// обновить и кэш Hail, и кэш иконок (иначе снежинок не будет, а иконка com.c останется).
console.log('2) Hail включился, com.c удалён → checkUpdates(true):');
console.log('   подготовка:', await ev(`(function(){ window.__hailOk = true; window.__freezeAll(); window.__drop('com.c'); return 'ok'; })()`));
console.log('   проверка:', await ev(`(function(){ if (typeof checkUpdates!=='function') return 'НЕТ'; checkUpdates(true); return 'ok'; })()`));
await sleep(3000);
const sn = await snow(), cs = await stats(), hc = await ev('window.__hailCalls'), rw = await rows();
console.log('   строк:', rw, '| снежинок:', sn, '| вызовов hailAvailable:', hc);
console.log('   кэши:', JSON.stringify(cs));
console.log('   кэш Hail перечитан:', hc > 1 ? 'OK' : 'ПРОВАЛ (hailAvailable спросили только раз — кэш устарел)');
console.log('   снежинки появились:', sn === 2 ? 'OK (оба оставшихся приложения заморожены)' : 'ПРОВАЛ (снежинок ' + sn + ', ждали 2)');
console.log('   иконка удалённого выброшена:', cs.icons === 2 ? 'OK (иконок 2)' : 'ПРОВАЛ (иконок ' + cs.icons + ', кэш копит удалённые)');
ws.close();

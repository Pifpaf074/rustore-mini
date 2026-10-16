// mount() вызывался последним, а ensureUpdData → checkUpdates синхронно (до первого await)
// зовёт listInstalled() — это синхронный вызов моста: JSON всего списка пакетов + разбор.
// Страница оставалась пустой, пока он не отработает.
// Теперь: mount() первым, а стартовая работа — после первого кадра (rAF + setTimeout,
// одного setTimeout мало — таймер может сработать раньше кадра).
// Проверяем временем первого кадра при заведомо медленном мосте (getInstalledApps ждёт 300 мс).
// BASE=8099 — новый код; BASE=8098 — негативный контроль (app.js из git, mount последним).
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

// Замер первого кадра + медленный мост (как на телефоне с большим списком пакетов).
const probe = `
window.__t0 = performance.now();
window.__raf1 = 0; window.__raf2 = 0;
requestAnimationFrame(function(){ window.__raf1 = performance.now(); requestAnimationFrame(function(){ window.__raf2 = performance.now(); }); });
window.__bridgeMs = 0;
`;
const stub = `
(function(){
  window.WebToApk = {
    getInstalledApps: function(){
      var t = performance.now(); while (performance.now() - t < 300) {}   // медленный мост
      window.__bridgeMs = performance.now() - t;
      return JSON.stringify([{packageName:'pkga',label:'AppA',versionName:'1.0',versionCode:1,enabled:true,suspended:false}]);
    },
    getInstalledVersion: function(){ return 1; }, getInstalledSigner: function(){ return 'sig'; },
    isPackageInstalled: function(){ return true; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.mine.webtoapk'}); },
    getDeviceInfo: function(){ return '{}'; }, hailAvailable: function(){ return false; }, hailAction: function(){ return false; },
    getAppIcon: function(){ return ''; }, installApk: function(){}, openAppInfo: function(){}, launchApp: function(){ return true; },
    openExternal: function(){}, clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''), body = {};
    if (/showcase\\/sections/.test(url)) body = { code:'OK', body:{ elements:[] } };
    else if (/popular\\/apps/.test(url)) body = { apps: [] };
    else if (/overallInfo/.test(url)) body = { code:'OK', body:{ packageName:'pkga', appName:'AppA', versionName:'2.0', versionCode:2, iconUrl:'', signature:'sig' } };
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:200, responseText: JSON.stringify(body) }); }, 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: probe + stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 4000));

const t0 = await ev(`window.__t0`), raf1 = await ev(`window.__raf1`), raf2 = await ev(`window.__raf2`);
const bridge = await ev(`window.__bridgeMs`);
const content = await ev(`document.querySelectorAll('#root .app').length`);
console.log('мост getInstalledApps отработал за', Math.round(bridge), 'мс');
console.log('первый кадр после старта скрипта:', Math.round(raf1 - t0), 'мс');
console.log('второй кадр:', Math.round(raf2 - t0), 'мс');
console.log('UI в DOM:', content ? 'есть' : 'НЕТ');
console.log('\nпервый кадр не ждёт мост:', (raf1 - t0) < 200 ? 'OK (рисуем до тяжёлой работы)' : 'ПРОВАЛ (кадр ждёт мост: ' + Math.round(raf1 - t0) + ' мс)');
console.log('обновления всё равно проверяются:', await ev(`(function(){ var h=document.querySelector('.updbar'); return !!h; })()`) ? 'OK' : 'ПРОВАЛ');
ws.close();

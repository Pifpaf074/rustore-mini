// Ключ иконки — по versionCode, а не versionName: versionName многие сборки не меняют
// («1.0» годами), и тогда ключ оставался прежним — иконка не перезапрашивалась, а старая
// запись не вычищалась как устаревшая. BASE=8099 — новый код; BASE=8098 — негативный контроль.
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
  window.__icons = 0; window.__ver = 1;
  window.WebToApk = {
    getInstalledApps: function(){ return JSON.stringify([{packageName:'pkga',label:'AppA',versionName:'1.0',versionCode:window.__ver,enabled:true,suspended:false}]); },
    getInstalledVersion: function(){ return window.__ver; }, getInstalledSigner: function(){ return 'sig'; },
    isPackageInstalled: function(){ return true; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.mine.webtoapk'}); },
    getDeviceInfo: function(){ return '{}'; }, hailAvailable: function(){ return false; }, hailAction: function(){ return false; },
    getAppIcon: function(p){ window.__icons++; return btoa('icon-' + p + '-' + window.__ver); },
    installApk: function(){}, openAppInfo: function(){}, launchApp: function(){ return true; }, openExternal: function(){},
    clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''), body = {};
    if (/overallInfo\\/([^/?]+)/.test(url)) { var p = RegExp.$1;
      body = { code:'OK', body:{ packageName:p, appName:'AppA', versionName:'9.9', versionCode:9, iconUrl:'', signature:'sig',
        shortDescription:'Описание', whatsNew:'', fileUrls:[], screenshots:[] } }; }
    else if (/comment/.test(url)) body = { code:'OK', body:{ content:[], totalElements:0 } };
    else if (/showcase\\/sections/.test(url)) body = { code:'OK', body:{ elements:[] } };
    else if (/popular\\/apps/.test(url)) body = { apps: [] };
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:200, responseText: JSON.stringify(body) }); }, 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 6000));
if ((await ev(`typeof window.__icons`)) !== 'number') { console.log('СТАБ НЕ УСТАНОВИЛСЯ — тест недействителен'); process.exit(1); }

const clickText = (t) => ev(`(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ return x.textContent.trim()===${JSON.stringify(t)}; })[0];
  if(!b) return 'НЕТ КНОПКИ ' + ${JSON.stringify(t)}; b.click(); return 'ok'; })()`);
const icons = () => ev('window.__icons');
const stats = () => ev('JSON.stringify(window.__cacheStats())');

console.log('1) «Установленные»:', await clickText('Установленные'));
await new Promise(r => setTimeout(r, 1200));
const n1 = await icons();
console.log('   вызовов getAppIcon:', n1, n1 === 1 ? 'OK' : 'ПРОВАЛ (ожидался 1)', '| кэш:', await stats());
console.log('2) приложение обновилось: versionName ТОТ ЖЕ («1.0»), versionCode 1 → 2:', await ev('window.__ver = 2, "ok"'));
console.log('   перечитываю список (pull-to-refresh):', await ev('window.__refreshCurrent(), "ok"'));
await new Promise(r => setTimeout(r, 1200));
const n2 = await icons();
console.log('   вызовов getAppIcon:', n2, n2 === 2 ? 'OK (иконка перезапрошена)' : 'ПРОВАЛ (иконка осталась старая)', '| кэш:', await stats());
ws.close();

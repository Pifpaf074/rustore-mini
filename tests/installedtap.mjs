// Ревью: тап по «Установленному» делал info() для проверки 404, а openDetail делал тот же
// info() ещё раз — два одинаковых запроса на каждое открытие карточки. Проверяем, что
// запрос ровно один (данные передаются в карточку) и карточка при этом открывается.
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
  window.__reqs = [];
  window.WebToApk = {
    getInstalledApps: function(){ return JSON.stringify([{ packageName:'com.x', label:'App X', versionName:'1.0', versionCode:1, enabled:true, suspended:false }]); },
    getInstalledVersion: function(){ return 1; }, getInstalledSigner: function(){ return ''; },
    isPackageInstalled: function(){ return true; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.mine.webtoapk',versionCode:26,versionName:'2.9.7'}); },
    getDeviceInfo: function(){ return '{}'; }, hailAvailable: function(){ return false; },
    hailAction: function(){ return false; }, getAppIcon: function(){ return ''; }, installApk: function(){},
    openAppInfo: function(){}, launchApp: function(){ return true; }, openExternal: function(){},
    clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||'');
    window.__reqs.push(url);
    var body = {};
    if (/overallInfo\\/([^/?]+)/.test(url)) body = { code:'OK', body:{ packageName:RegExp.$1, appName:'App X', versionName:'1.0', versionCode:1, appId:1, shortDescription:'тест' } };
    else if (/showcase\\/sections/.test(url)) body = { code:'OK', body:{ elements:[] } };
    else if (/popular\\/apps/.test(url)) body = { apps: [] };
    else if (/applicationData\\/apps/.test(url)) body = { code:'OK', body:{ content:[] } };
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:200, responseText: JSON.stringify(body) }); }, 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 6000));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const count = () => ev(`(window.__reqs||[]).filter(function(u){ return /overallInfo\\/com\\.x/.test(u); }).length`);

console.log('1) открываю «Установленные»:', await ev(`(function(){ var b=Array.prototype.filter.call(document.querySelectorAll('.segbtn'),function(e){return e.textContent==='Установленные';}); if(!b.length) return 'НЕТ'; b[0].click(); return 'ok'; })()`));
await sleep(1200);
await ev('window.__reqs = []');   // обнуляем счётчик ПОСЛЕ стартовой проверки обновлений
console.log('2) тап по строке com.x:', await ev(`(function(){ var r=document.querySelector('.sub .rcard'); if(!r) return 'НЕТ СТРОКИ'; r.click(); return 'ok'; })()`));
await sleep(1500);
const n = await count();
const open = await ev(`!!document.querySelector('.detail.open')`);
const name = await ev(`(function(){ var e=document.querySelector('.detail .dname'); return e?e.textContent:''; })()`);
console.log('3) запросов overallInfo/com.x:', n, n === 1 ? 'OK (один — данные отданы карточке)' : 'ПРОВАЛ (лишний повторный запрос)');
console.log('   карточка открыта:', open ? 'OK' : 'ПРОВАЛ', '| имя:', JSON.stringify(name));
console.log('   все запросы:', JSON.stringify(await ev(`(window.__reqs||[]).map(function(u){ return u.replace(/^https?:\\/\\/[^/]+/, ''); })`)));
ws.close();

// Ревью: apiH делал Object.assign({ headers: HDR }, opts) — при opts.headers объект
// заголовков ЗАМЕНЯЛСЯ целиком, и RuStoreVerCode терялся (запрос получал 400), а
// Content-Type дописывался в объект вызывающего. Проверяем слияние и отсутствие мутации.
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
    window.__reqs.push({ url: String(d.url||''), method: d.method||'GET', headers: d.headers||{}, data: d.data||'' });
    var body = { code:'OK', body:{ packageName:'com.x' } };
    if (/version\\.json/.test(String(d.url||''))) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:200, responseText: JSON.stringify(body) }); }, 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 5000));
await ev('window.__reqs = []');

console.log('1) apiH с собственными заголовками (overallInfo + тело):');
const out = await ev(`(async function(){
  var h = { 'X-Test': '1' };
  var res = { before: JSON.stringify(h) };
  try { await apiH('/applicationData/overallInfo/com.x', { headers: h, body: '{}' }); }
  catch (e) { res.err = String(e.message); }
  res.after = JSON.stringify(h);
  return JSON.stringify(res);
})()`);
const o = JSON.parse(out || '{}');
console.log('   ошибка:', o.err || 'нет');
console.log('   заголовки вызывающего до :', o.before);
console.log('   заголовки вызывающего после:', o.after);
const req = JSON.parse((await ev(`(function(){ var r=(window.__reqs||[]).filter(function(x){ return /overallInfo/.test(x.url); }); return JSON.stringify(r[0]||null); })()`)) || 'null');
console.log('2) что реально ушло:', JSON.stringify(req && req.headers));
const h = (req && req.headers) || {};
console.log('   RuStoreVerCode на месте:', h['RuStoreVerCode'] === '1000' ? 'OK' : 'ПРОВАЛ (потерян — RuStore ответит 400)');
console.log('   свой заголовок сохранён:', h['X-Test'] === '1' ? 'OK' : 'ПРОВАЛ');
console.log('   Accept на месте:', h['Accept'] === 'application/json' ? 'OK' : 'ПРОВАЛ');
console.log('   Content-Type для тела:', h['Content-Type'] === 'application/json' ? 'OK' : 'ПРОВАЛ');
console.log('   объект вызывающего не мутирован:', o.after === '{"X-Test":"1"}' ? 'OK' : 'ПРОВАЛ (дописали Content-Type в чужой объект)');
ws.close();

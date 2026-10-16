// Фолбэк download-link: v3 (api.rustore.ru) может ответить 200 БЕЗ downloadUrls
// (например {"code":"ERROR"}). Тогда надо идти в старый backapi-путь, а не падать
// «RuStore не отдал ссылку». Тест стабит мост: v3 отдаёт 200 без ссылки, старый API — ссылку.
// BASE=8099 — новый код; BASE=8098 — негативный контроль (app.js без фикса).
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
  window.__installs = [];
  var versions = { 'pkg-a': 1 };
  window.WebToApk = {
    getInstalledApps: function(){ return JSON.stringify([{packageName:'pkg-a',label:'APP-pkg-a',versionCode:1,versionName:'1.0',enabled:true}]); },
    getInstalledVersion: function(p){ return versions[p]||0; },
    getInstalledSigner: function(){ return ''; },
    isPackageInstalled: function(p){ return p in versions; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.test',versionCode:1}); },
    getDeviceInfo: function(){ return '{}'; },
    hailAvailable: function(){ return false; }, hailAction: function(){ return false; },
    getAppIcon: function(){ return ''; },
    installApk: function(j){ window.__installs.push(String(j)); },
    openAppInfo: function(){}, launchApp: function(){ return true; },
    openExternal: function(){}, clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){},
    httpRequest: function(){}, httpAbort: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||'');
    window.__reqs.push({ url: url, method: String(d.method||'GET') });
    var status = 200, body = null;
    if (/v3\\/showcase\\/apps\\/download-link/.test(url)) {
      body = { code: 'ERROR', message: 'ссылки нет' };   // HTTP 200, но без downloadUrls
    } else if (/v2\\/download-link/.test(url)) {
      body = { code: 'OK', body: { downloadUrls: [ { url: 'http://127.0.0.1:8099/x.apk', size: 10 } ] } };
    } else if (/overallInfo/.test(url)) {
      var p = decodeURIComponent((url.match(/overallInfo\\/([^?]+)/)||[])[1]||'');
      body = { code:'OK', body:{ packageName:p, appName:'APP-'+p, versionCode:2, versionName:'2.0', signature:'', shortDescription:'x', fileUrls:[] } };
    } else if (/version\\.json/.test(url)) { body = { versionCode: 0 }; }
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status: status, responseText: JSON.stringify(body||{}) }); }, 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 6000));

const clickRow = async () => await ev(`(function(){ var b=document.querySelector('.updbar'); if(!b) return 'НЕТ .updbar';
  var r=b.parentNode.querySelectorAll('.rcard'); if(!r.length) return 'НЕТ СТРОК'; r[0].click(); return 'ok'; })()`);
const clickCardInstall = async () => await ev(`(function(){ var b=document.querySelector('.dacts button.primary');
  if(!b) return 'НЕТ КНОПКИ'; if(b.disabled) return 'КНОПКА ЗАБЛОКИРОВАНА'; b.click(); return 'ok'; })()`);
const toast = async () => await ev(`(function(){ var t=document.querySelector('.toast'); return t?t.textContent:''; })()`);
const reqs = async () => await ev('JSON.stringify((window.__reqs||[]).map(function(r){return r.url;}))');
const installs = async () => await ev('JSON.stringify(window.__installs||[])');

console.log('1) открываю карточку:', await clickRow());
await new Promise(r => setTimeout(r, 2500));
console.log('2) жму «Обновить» в карточке:', await clickCardInstall());
await new Promise(r => setTimeout(r, 3000));
const r = JSON.parse(await reqs() || '[]');
const v3 = r.filter(u => /v3\/showcase\/apps\/download-link/.test(u)).length;
const v2 = r.filter(u => /v2\/download-link/.test(u)).length;
console.log('3) запросов к v3:', v3, '| к старому v2:', v2, v2 ? 'OK (фолбэк сработал)' : 'ПРОВАЛ (фолбэка не было)');
const ins = JSON.parse(await installs() || '[]');
console.log('4) installApk вызван:', ins.length, ins.length && /x\.apk/.test(ins[0]) ? 'OK (ссылка со старого API)' : 'ПРОВАЛ');
console.log('   тост:', await toast());
ws.close();

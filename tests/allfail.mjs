// «Обновить все» должно считать результат: runInstall глотал ошибки и ничего не возвращал,
// поэтому даже при полном провале в конце писалось «Готово».
// BASE=8099 — новый код; BASE=8098 — негативный контроль (app.js из git).
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
  window.__fail = {pkga:1, pkgb:1}; window.__ver = {pkga:1, pkgb:1}; window.__installs = [];
  window.WebToApk = {
    getInstalledApps: function(){ return JSON.stringify(['pkga','pkgb'].map(function(p){
      return {packageName:p,label:p.toUpperCase(),versionName:'1.0',versionCode:window.__ver[p],enabled:true,suspended:false}; })); },
    getInstalledVersion: function(p){ return window.__ver[p]||0; }, getInstalledSigner: function(){ return 'sig'; },
    isPackageInstalled: function(p){ return !!window.__ver[p]; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.mine.webtoapk'}); },
    getDeviceInfo: function(){ return '{}'; }, hailAvailable: function(){ return false; }, hailAction: function(){ return false; },
    getAppIcon: function(){ return ''; },
    installApk: function(s){
      var o = JSON.parse(s), pkg = o.name.split('-')[0]; window.__installs.push(o.name);
      setTimeout(function(){
        if (window.__fail[pkg]) window.__webtoapkEvent('apk', {phase:'error', message:'INSTALL_FAILED_ALREADY_EXISTS'});
        else { window.__ver[pkg] = 2; window.__webtoapkEvent('apk', {phase:'installed'}); }
      }, 200);
    },
    openAppInfo: function(){}, launchApp: function(){ return true; }, openExternal: function(){},
    clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''), body = {};
    if (/overallInfo\\/([^/?]+)/.test(url)) { var p = RegExp.$1;
      body = { code:'OK', body:{ packageName:p, appName:p.toUpperCase(), versionName:'2.0', versionCode:2, iconUrl:'', signature:'sig',
        shortDescription:'', whatsNew:'', fileUrls:[], screenshots:[] } }; }
    else if (/download-link/.test(url)) body = { appId:1, versionCode:2, signature:'sig', downloadUrls:[{ url:'https://x/a.apk', size:1000, hash:'h' }] };
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
await new Promise(r => setTimeout(r, 7000));
if ((await ev(`typeof window.__fail`)) !== 'object') { console.log('СТАБ НЕ УСТАНОВИЛСЯ — тест недействителен'); process.exit(1); }

const bulk = () => ev(`(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ return x.textContent.trim()==='Обновить все'; })[0];
  if(!b) return 'НЕТ КНОПКИ'; b.click(); return 'ok'; })()`);
const bulkReady = () => ev(`(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ return x.textContent.trim()==='Обновить все'; })[0];
  return b ? !b.disabled : null; })()`);
const toastText = () => ev(`(function(){ var t=document.querySelector('.toast'); return t ? t.textContent : ''; })()`);
const rows = () => ev(`[].slice.call(document.querySelectorAll('.rcard')).filter(function(x){ return x.offsetParent !== null; }).length`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('строк обновлений:', await rows());
console.log('1) все установки падают (INSTALL_FAILED_ALREADY_EXISTS):', await bulk());
for (let k = 0; k < 100; k++) { await sleep(100); if ((await bulkReady()) === true) break; }
await sleep(200);
console.log('   установок попыток:', await ev('JSON.stringify(window.__installs)'), '| строк осталось:', await rows());
const t1 = await toastText();
console.log('   тост:', JSON.stringify(t1), /Не удалось обновить ни одного из 2/.test(t1) ? 'OK (провал назван)' : 'ПРОВАЛ (врёт «Готово»?)');

await ev('window.__fail = {pkga:1}, "ok"');
console.log('2) падает только первый:', await bulk());
for (let k = 0; k < 100; k++) { await sleep(100); if ((await bulkReady()) === true) break; }
await sleep(200);
console.log('   строк осталось:', await rows());
const t2 = await toastText();
console.log('   тост:', JSON.stringify(t2), /Обновлено 1 из 2/.test(t2) ? 'OK (частичный успех посчитан)' : 'ПРОВАЛ');
ws.close();

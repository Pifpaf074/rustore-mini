// Ревью: VIEW рисовал ОБА каталога (APPS и GAMES), каждый со своим SEARCHBAR/RESULTS и
// рельсами — скрытая вкладка строила плитки впустую (а при поиске ещё и дублировала выдачу).
// Проверяем: после посещения обеих вкладок в DOM только плитки АКТИВНОЙ.
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
    var url = String(d.url||'');
    window.__reqs.push(url);
    var body = {}, kind = /GAMES/.test(url) ? 'g' : 'a';
    if (/showcase\\/sections/.test(url)) {
      var pkgs = [1,2,3].map(function(i){ return { packageName: kind+i, type:'APP' }; });
      body = { code:'OK', body:{ elements:[ { selection:{ id:'r1', title:{ value: kind==='g'?'Игры-рейл':'Приложения-рейл' }, content:{ appInfo: pkgs } } } ] } };
    }
    else if (/popular\\/apps/.test(url)) body = { apps: [] };
    else if (/applicationData\\/apps/.test(url)) {
      var m = /query=([^&]+)/.exec(url);
      var pkg = m ? decodeURIComponent(m[1]) : 'x';
      body = { code:'OK', body:{ content:[{ packageName: pkg, appName: pkg.toUpperCase(), versionCode:1, appId:1, iconUrl:'' }] } };
    }
    else if (/overallInfo/.test(url)) body = { code:'OK', body:{ packageName:'x', appName:'X', versionCode:1 } };
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:200, responseText: JSON.stringify(body) }); }, 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 5000));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clickTab = (label) => ev(`(function(){ var b=Array.prototype.filter.call(document.querySelectorAll('.tab'),function(e){return e.textContent===${JSON.stringify(label)};}); if(!b.length) return 'НЕТ'; b[0].click(); return 'ok'; })()`);
const tiles = () => ev(`document.querySelectorAll('.tile').length`);
const shown = () => ev(`Array.prototype.map.call(document.querySelectorAll('.tile .tname'), function(e){ return e.textContent; }).join(',')`);

console.log('1) «Приложения»:', await clickTab('Приложения'));
await sleep(2000);
console.log('   плиток:', await tiles(), '|', JSON.stringify(await shown()));
console.log('2) «Игры»:', await clickTab('Игры'));
await sleep(2000);
console.log('   плиток:', await tiles(), '|', JSON.stringify(await shown()));
console.log('3) назад в «Приложения»:', await clickTab('Приложения'));
await sleep(2000);
const n = await tiles(), list = await shown();
console.log('   плиток:', n, '|', JSON.stringify(list));
console.log('   в DOM только активная вкладка:', n === 3 && /A1/.test(list) ? 'OK (3 плитки приложений)' : 'ПРОВАЛ (плиток ' + n + ' — скрытая вкладка тоже рисует)');
ws.close();

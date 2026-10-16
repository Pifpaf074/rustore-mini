// Pull-to-refresh на «Обновлениях» повторял поиск: setTab('upd') поиск не чистит (чистит
// только переход на apps/games), а в __refreshCurrent проверка searchActive() стояла выше
// проверки вкладки. То есть после поиска в каталоге и перехода на «Обновления» жест уходил
// в runSearch (без видимой реакции) вместо checkUpdates.
// Проверяем: (1) PTR на «Обновлениях» при живом поиске — проверка обновлений, поиск не тронут;
// (2) PTR в каталоге при живом поиске — поиск повторяется (это поведение сохраняем);
// (3) PTR в каталоге без поиска — перезагрузка подборок.
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
  window.__c = { search: 0, info: 0, sections: 0 };
  window.WebToApk = {
    getInstalledApps: function(){ return JSON.stringify([
      {packageName:'pkga',label:'AppA',versionName:'1.0',versionCode:1,enabled:true,suspended:false},
      {packageName:'pkgb',label:'AppB',versionName:'1.0',versionCode:1,enabled:true,suspended:false}]); },
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
    var url = String(d.url||''), body = {}, delay = 10;
    if (/applicationData\\/apps/.test(url)) { window.__c.search++; delay = 600;
      body = { code:'OK', body:{ content:[ {packageName:'pkgz',appId:9,appName:'Найденное',versionCode:1,iconUrl:''} ] } }; }
    else if (/overallInfo/.test(url)) { window.__c.info++;
      body = { code:'OK', body:{ packageName:'pkga', appName:'AppA', versionName:'2.0', versionCode:2, iconUrl:'', signature:'sig' } }; }
    else if (/showcase\\/sections/.test(url)) { window.__c.sections++;
      body = { code:'OK', body:{ elements:[ { selection:{ id:'s1', title:{ value:'Подборка' }, content:{ appInfo:[ {packageName:'pkga',type:'APP'} ] } } } ] } }; }
    else if (/popular\\/apps/.test(url)) body = { apps: [] };
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:200, responseText: JSON.stringify(body) }); }, delay);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 6000));
if ((await ev(`typeof window.__c`)) !== 'object') { console.log('СТАБ НЕ УСТАНОВИЛСЯ — тест недействителен'); process.exit(1); }

const c = async () => JSON.parse(await ev(`JSON.stringify(window.__c)`));
const clickTab = (l) => ev(`(function(){ var t=Array.prototype.filter.call(document.querySelectorAll('.tab'),function(e){return e.textContent===${JSON.stringify(l)};}); if(!t.length) return 'НЕТ'; t[0].click(); return 'ok'; })()`);
const setQuery = (v) => ev(`(function(){ var i=document.querySelector('.q'); if(!i) return 'НЕТ ИНПУТА'; i.value=${JSON.stringify(v)}; i.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`);
const enter = () => ev(`(function(){ var i=document.querySelector('.q'); if(!i) return 'НЕТ ИНПУТА'; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 'ok'; })()`);
// Ровно то, что делает натив при pull-to-refresh.
const pull = () => ev(`(function(){ if (!window.WebToApk.onPullToRefresh) return 'НЕТ ХУКА'; return String(window.WebToApk.onPullToRefresh()); })()`);
const results = () => ev(`Array.prototype.filter.call(document.querySelectorAll('.rlist .rcard'), function(e){ return e.offsetParent !== null; }).length`);

// готовим сценарий: поиск в каталоге (результаты остаются живыми)
console.log('открываю «Приложения»:', await clickTab('Приложения'));
await new Promise(r => setTimeout(r, 2000));
console.log('печатаю запрос:', await setQuery('tel'));
console.log('Enter:', await enter());
await new Promise(r => setTimeout(r, 1200));
console.log('  результатов видно:', await results(), '(поиск прошёл)');
console.log('  счётчики:', JSON.stringify(await c()));

// --- 1. PTR в каталоге с живым поиском: поиск должен повторяться (поведение сохраняем) ---
console.log('\n=== 1. PTR в каталоге, поиск жив (не уходим с вкладки) ===');
const b1 = await c();
console.log('  pull:', await pull());
await new Promise(r => setTimeout(r, 1500));
const a1 = await c();
console.log('  поиск повторился:', a1.search - b1.search, a1.search > b1.search ? 'OK (в каталоге так и надо)' : 'ПРОВАЛ');

// --- 2. PTR на «Обновлениях» при живом поиске: проверка обновлений, а не поиск ---
console.log('\n=== 2. Перехожу в «Обновления» и дёргаю pull-to-refresh ===');
console.log('  вкладка:', await clickTab('Обновления'));
await new Promise(r => setTimeout(r, 400));
const before = await c();
console.log('  pull:', await pull(), '| (хук вернул true — страница сама обновила контент)');
await new Promise(r => setTimeout(r, 2500));
const after = await c();
console.log('  поиск повторился:', after.search - before.search, after.search === before.search ? 'OK (поиск не тронули)' : 'ПРОВАЛ (улетел лишний поиск)');
console.log('  проверка обновлений:', after.info - before.info, after.info > before.info ? 'OK (проверили обновления)' : 'ПРОВАЛ (проверки не было)');

// --- 3. PTR в каталоге без поиска (возврат в каталог поиск и так чистит) ---
console.log('\n=== 3. Возвращаюсь в «Приложения» (поиск уже очищен setTab) и дёргаю PTR ===');
console.log('  вкладка:', await clickTab('Приложения'));
await new Promise(r => setTimeout(r, 400));
const b3 = await c();
console.log('  pull:', await pull());
await new Promise(r => setTimeout(r, 1500));
const a3 = await c();
console.log('  подборки перезагрузились:', a3.sections - b3.sections, a3.sections > b3.sections ? 'OK' : 'ПРОВАЛ');
ws.close();

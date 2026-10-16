// «Поиск…» не показывался: runSearch ставит ST.results = null, а CATALOG по null рисовал
// подборки — то есть подсказка внутри RESULTS была недостижима, и во время поиска (а с
// ленивой витриной — вообще на пустом месте) пользователь не видел никакой реакции.
// Теперь CATALOG смотрит на searchActive() (как навигация/back), а RESULTS показывает
// «Поиск…» пока results === null (это и путь поиска, и окно debounce ввода).
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

// поиск отвечает через 900 мс — успеваем посмотреть состояние «в пути»
const stub = `
(function(){
  window.__req = [];
  window.WebToApk = {
    getInstalledApps: function(){ return JSON.stringify([{packageName:'pkga',label:'AppA',versionName:'1.0',versionCode:1,enabled:true,suspended:false}]); },
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
    var url = String(d.url||''); window.__req.push(url);
    var body = {}, delay = 10;
    if (/showcase\\/sections/.test(url)) body = { code:'OK', body:{ elements:[ { selection:{ id:'s1', title:{ value:'Подборка' },
      content:{ appInfo:[ {packageName:'pkga',type:'APP'} ] } } } ] } };
    else if (/popular\\/apps/.test(url)) body = { apps: [] };
    else if (/applicationData\\/apps/.test(url)) { delay = 900; body = { code:'OK', body:{ content:[ {packageName:'pkgz',appId:9,appName:'Найденное',versionCode:1,iconUrl:''} ] } }; }
    else if (/overallInfo/.test(url)) body = { code:'OK', body:{ packageName:'pkga', appName:'AppA', versionName:'2.0', versionCode:2, iconUrl:'', signature:'sig' } };
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:200, responseText: JSON.stringify(body) }); }, delay);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 6000));

const clickTab = (l) => ev(`(function(){ var t=Array.prototype.filter.call(document.querySelectorAll('.tab'),function(e){return e.textContent===${JSON.stringify(l)};}); if(!t.length) return 'НЕТ'; t[0].click(); return 'ok'; })()`);
const setQuery = (v) => ev(`(function(){ var i=document.querySelector('.q'); if(!i) return 'НЕТ ИНПУТА'; i.value=${JSON.stringify(v)}; i.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`);
// только видимое: обе вкладки-каталога отрисованы всегда
const visible = (sel) => ev(`(function(){ return Array.prototype.filter.call(document.querySelectorAll(${JSON.stringify(sel)}), function(e){ return e.offsetParent !== null; }).length; })()`);
const hintText = () => ev(`(function(){ var h=document.querySelector('.rlist .hint'); return h? h.textContent : ''; })()`);

console.log('открываю «Приложения» (чтобы подборки были загружены):', await clickTab('Приложения'));
await new Promise(r => setTimeout(r, 2500));
console.log('  рейлов видно:', await visible('.rails'), '| плиток:', await visible('.tile'));

// Ввод без Enter: поиск ещё не запущен — подборки должны остаться на месте.
console.log('\nпечатаю запрос (без Enter):', await setQuery('tel'));
await new Promise(r => setTimeout(r, 500));
console.log('  подсказка =', JSON.stringify(await hintText()), '| рейлов видно =', await visible('.rails'),
  (await visible('.rails')) === 1 ? 'OK (при вводе подборки не пропадают)' : 'ПРОВАЛ');

// Enter — поиск реально стартует, ответ придёт через 900 мс.
const enter = () => ev(`(function(){ var i=document.querySelector('.q'); if(!i) return 'НЕТ ИНПУТА';
  i.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true })); return 'ok'; })()`);
console.log('\nEnter (поиск в пути):', await enter());
await new Promise(r => setTimeout(r, 200));
console.log('  в пути (200 мс): подсказка =', JSON.stringify(await hintText()), '| рейлов видно =', await visible('.rails'));
const h = await hintText(), rails = await visible('.rails');
console.log('  «Поиск…» показан:', /Поиск/.test(h) ? 'OK' : 'ПРОВАЛ (подсказки нет)');
console.log('  подборки вместо поиска:', rails === 0 ? 'OK (не мешают)' : 'ПРОВАЛ (показаны подборки)');

await new Promise(r => setTimeout(r, 1400));
console.log('\nпосле ответа (1.6 с): подсказка =', JSON.stringify(await hintText()), '| результатов видно =', await visible('.rlist .rcard'));
console.log('  результаты на месте:', (await visible('.rlist .rcard')) >= 1 ? 'OK' : 'ПРОВАЛ');
console.log('  «Поиск…» убрался:', /Поиск/.test(await hintText()) ? 'ПРОВАЛ' : 'OK');
console.log('  запросов поиска:', (await ev(`window.__req`)).filter(u => /applicationData\/apps/.test(u)).length);
ws.close();

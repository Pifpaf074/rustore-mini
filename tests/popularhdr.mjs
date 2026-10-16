// Рейл «Популярное сейчас»: ручка api.rustore.ru/v2/showcase/popular/apps без заголовка
// RuStoreVerCode отвечает 400 — рейл молча пропадал (loadHome глушит ошибку в catch).
// Тест стабит мост и проверяет, что запрос ушёл С заголовком и рейл отрисовался.
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

// Мост-заглушка: popular/apps отдаёт данные ТОЛЬКО при наличии RuStoreVerCode —
// как настоящий сервер. Заголовки каждого запроса пишем в window.__reqs.
const stub = `
(function(){
  window.__reqs = [];
  window.WebToApk = {
    getInstalledApps: function(){ return '[]'; },
    getInstalledVersion: function(){ return 0; },
    getInstalledSigner: function(){ return ''; },
    isPackageInstalled: function(){ return false; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.test',versionCode:1}); },
    getDeviceInfo: function(){ return '{}'; },
    hailAvailable: function(){ return false; }, hailAction: function(){ return false; },
    getAppIcon: function(){ return ''; }, installApk: function(){},
    openAppInfo: function(){}, launchApp: function(){ return true; },
    openExternal: function(){}, clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){},
    httpRequest: function(){}, httpAbort: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''), headers = d.headers || {};
    window.__reqs.push({ url: url, hdr: String(headers.RuStoreVerCode || '') });
    var status = 200, body = null;
    if (/popular\\/apps/.test(url)) {
      if (headers.RuStoreVerCode) body = { apps: [{ packageName: 'pkg-pop', appId: 11, verCode: 1 }] };
      else { status = 400; body = {}; }
    } else if (/showcase\\/sections/.test(url)) {
      body = { code:'OK', body:{ elements:[ { selection:{ id:'s1', title:{ value:'Тестовая подборка' },
        content:{ appInfo:[ { packageName:'pkg-sec', type:'APP' } ] } } } ] } };
    } else if (/applicationData\\/apps/.test(url)) {
      var q = decodeURIComponent((url.match(/query=([^&]*)/) || [])[1] || '');
      body = { code:'OK', body:{ content:[ { packageName:q, appId:9, appName:'APP-'+q, iconUrl:'',
        averageUserRating:4.5, versionCode:1 } ] } };
    } else if (/overallInfo/.test(url)) {
      var p = decodeURIComponent((url.match(/overallInfo\\/([^?]+)/) || [])[1] || '');
      body = { code:'OK', body:{ packageName:p, appName:'APP-'+p, versionCode:1, shortDescription:'x', fileUrls:[] } };
    } else if (/version\\.json/.test(url)) { body = { versionCode: 0 }; }
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status: status, responseText: JSON.stringify(body||{}) }); }, 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 6000));
// Витрина грузится лениво (boot её больше не трогает) — открываем вкладку, как пользователь.
const clickTab = (label) => ev(`(function(){ var t=Array.prototype.filter.call(document.querySelectorAll('.tab'),function(e){return e.textContent===${JSON.stringify(label)};}); if(!t.length) return 'НЕТ'; t[0].click(); return 'ok'; })()`);
console.log('открываю «Приложения»:', await clickTab('Приложения'));
await new Promise(r => setTimeout(r, 3000));

const titles = async () => await ev(`JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.railtitle'), function(e){ return e.textContent; }))`);
const tiles = async () => await ev(`document.querySelectorAll('.railbody .tile').length`);
const popReq = async () => await ev(`JSON.stringify((window.__reqs||[]).filter(function(r){ return /popular\\/apps/.test(r.url); }))`);

const t = JSON.parse(await titles() || '[]');
const reqs = JSON.parse(await popReq() || '[]');
const withHdr = reqs.filter(r => r.hdr).length;
console.log('1) запросов к popular/apps:', reqs.length, '| из них с RuStoreVerCode:', withHdr,
  reqs.length && withHdr === reqs.length ? 'OK (заголовок есть)' : 'ПРОВАЛ (заголовка нет)');
console.log('2) рейлы на экране:', JSON.stringify(t));
const has = t.indexOf('Популярное сейчас') >= 0;
console.log('3) рейл «Популярное сейчас»:', has ? 'OK (отрисован)' : 'ПРОВАЛ (пропал)');
console.log('   плиток в рейлах:', await tiles());
ws.close();

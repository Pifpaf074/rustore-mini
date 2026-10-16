// Проверка рельсов после перехода на ST.meta (вместо словаря ссылок refs):
// (1) пакет, мета которого уже в кэше, рисуется сразу (и повторно не запрашивается);
// (2) свежий пакет сначала рисуется буквой-заглушкой, потом точечно обновляется;
// (3) один и тот же пакет в двух рельсах получает мету в обеих плитках (это и делал refs);
// (4) пакета нет в RuStore (404 и в поиске, и в overallInfo) — плитка остаётся заглушкой.
//
// Важно: boot() сам зовёт loadHome('APPS'), поэтому подборки игр на старте не загружены —
// «Игры» и открываем. Стаб отвечает на поиск меты через 2 с, чтобы успеть увидеть заглушку.
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
  window.__metaReq = [];
  var RAILS = {
    APPS:  [ { selection:{ id:'a1', title:{ value:'Подборка приложений' }, content:{ appInfo:[ {packageName:'pkga',type:'APP'}, {packageName:'pkgc',type:'APP'} ] } } } ],
    GAMES: [ { selection:{ id:'g1', title:{ value:'Подборка игр' }, content:{ appInfo:[ {packageName:'pkga',type:'APP'}, {packageName:'pkgd',type:'APP'} ] } } },
             { selection:{ id:'g2', title:{ value:'Ещё игры' }, content:{ appInfo:[ {packageName:'pkgd',type:'APP'}, {packageName:'pkge',type:'APP'} ] } } } ]
  };
  var META = { pkga:{packageName:'pkga',appId:1,appName:'Приложение А',iconUrl:'',averageUserRating:4.5,roundedDownloadsText:'1 млн',versionCode:3},
               pkgd:{packageName:'pkgd',appId:4,appName:'Игра Д',iconUrl:'',averageUserRating:4.1,roundedDownloadsText:'100 тыс',versionCode:2},
               pkge:{packageName:'pkge',appId:5,appName:'Игра Е',iconUrl:'',averageUserRating:3.5,roundedDownloadsText:'5 тыс',versionCode:1} };
  window.WebToApk = {
    getInstalledApps: function(){ return '[]'; }, getInstalledVersion: function(){ return 0; },
    getInstalledSigner: function(){ return ''; }, isPackageInstalled: function(){ return false; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.mine.webtoapk'}); },
    getDeviceInfo: function(){ return '{}'; },
    hailAvailable: function(){ return false; }, hailAction: function(){ return false; },
    getAppIcon: function(){ return ''; }, installApk: function(){}, openAppInfo: function(){},
    launchApp: function(){ return true; }, openExternal: function(){}, clearAppCache: function(){},
    hasNotificationPermission: function(){ return false; }, requestNotificationPermission: function(){},
    share: function(){}, setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''), status = 200, body = {};
    if (/showcase\\/sections\\/(APPS|GAMES)/.test(url)) {
      body = { code:'OK', body:{ elements: RAILS[RegExp.$1] || [] } };
    } else if (/popular\\/apps/.test(url)) body = { apps: [] };
    else if (/applicationData\\/apps/.test(url)) {
      var q = decodeURIComponent((/query=([^&]*)/.exec(url)||[])[1] || '');
      window.__metaReq.push(q);
      body = { code:'OK', body:{ content: META[q] ? [ META[q] ] : [] } };
    } else if (/overallInfo/.test(url)) {
      var p = (/overallInfo\\/([^/?]+)/.exec(url)||[])[1];
      if (META[p]) body = { code:'OK', body:{ packageName:p, appName:META[p].appName, versionName:'1.0', versionCode:META[p].versionCode, shortDescription:'Описание' } };
      else { status = 404; body = { code:'ERROR', message:"Couldn't find required data" }; }
    } else if (/version\\.json/.test(url)) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:status, responseText: JSON.stringify(body) }); }, /applicationData\\/apps/.test(url) ? 2000 : 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 6000));
// Страховка: если стаб молча не установился, тест ушёл бы в реальный API и «прошёл»
// на настоящих данных. Проверяем, что наш стаб точно жив.
if ((await ev(`typeof window.__metaReq`)) !== 'object') {
  console.log('СТАБ НЕ УСТАНОВИЛСЯ — тест недействителен (страница ушла бы в реальный API)');
  process.exit(1);
}

const clickTab = (label) => ev(`(function(){ var t=Array.prototype.filter.call(document.querySelectorAll('.tab'),function(e){return e.textContent===${JSON.stringify(label)};}); if(!t.length) return 'НЕТ'; t[0].click(); return 'ok'; })()`);
// Только видимая вкладка: скрытые views тоже отрисованы.
const tiles = () => ev(`JSON.stringify(Array.prototype.filter.call(document.querySelectorAll('.view .rail'), function(v){ return v.offsetParent !== null; }).map(function(v){
  return { rail: (v.querySelector('.railtitle')||{}).textContent, tiles: Array.prototype.map.call(v.querySelectorAll('.tile'), function(t){
    return { name: (t.querySelector('.tname')||{}).textContent, rate: (t.querySelector('.trate')||{}).textContent || '', ph: !!t.querySelector('.tic.ph') }; }) }; }))`);
const flat = async () => JSON.parse(await tiles()).flatMap(r => r.tiles);

// Витрина на старте больше не грузится (boot её не трогает), поэтому праймим кэш меты
// так, как это делает пользователь: сначала «Приложения», потом «Игры».
console.log('открываю «Приложения»:', await clickTab('Приложения'));
await new Promise(r => setTimeout(r, 3000));
console.log('открываю «Игры»:', await clickTab('Игры'));
await new Promise(r => setTimeout(r, 250));
console.log('\nчерез 250 мс (мета игр ещё грузится, стаб отвечает через 2 с):');
for (const r of JSON.parse(await tiles())) console.log('  ', r.rail, '→', JSON.stringify(r.tiles));
const early = await flat();
console.log('  pkga (уже в кэше с загрузки «Приложений») нарисован сразу:',
  early.some(x => x.name === 'Приложение А') ? 'OK' : 'ПРОВАЛ');
console.log('  pkgd/pkge пока заглушки:', early.filter(x => x.ph && /^pkg/.test(x.name)).length, '(ожидаем 3: pkgd дважды + pkge)');

await new Promise(r => setTimeout(r, 3500));
console.log('\nпосле загрузки меты:');
for (const r of JSON.parse(await tiles())) console.log('  ', r.rail, '→', JSON.stringify(r.tiles));
const t = await flat();
const names = t.map(x => x.name);
console.log('\nпроверки:');
console.log('  pkgd в двух рельсах получил имя:', names.filter(n => n === 'Игра Д').length, '(ожидаем 2)',
  names.filter(n => n === 'Игра Д').length === 2 ? 'OK' : 'ПРОВАЛ');
console.log('  рейтинги проставлены:', t.filter(x => x.rate).length, '(ожидаем 4: pkga + pkgd×2 + pkge)',
  t.filter(x => x.rate).length === 4 ? 'OK' : 'ПРОВАЛ');
// ph у плитки — заглушка ИКОНКИ (в стабе iconUrl пустой), поэтому «не заглушка»
// проверяется по имени: у незагруженной плитки в .tname стоит сам packageName.
console.log('  плиток с именем-пакетом не осталось:', t.filter(x => /^pkg/.test(x.name)).length, '(ожидаем 0)',
  t.filter(x => /^pkg/.test(x.name)).length === 0 ? 'OK' : 'ПРОВАЛ');
const req = await ev(`window.__metaReq`);
console.log('  запросы меты:', JSON.stringify(req));
console.log('  pkga запрошен ровно раз:', req.filter(x => x === 'pkga').length, '(ожидаем 1 — второй раз из кэша)',
  req.filter(x => x === 'pkga').length === 1 ? 'OK' : 'ПРОВАЛ');
console.log('  кэши:', await ev(`JSON.stringify(window.__cacheStats())`), '(meta: 3 — pkga/pkgd/pkge)');
console.log('\nтап по плитке pkgd:', await ev(`(function(){ var v=Array.prototype.filter.call(document.querySelectorAll('.view'),function(e){return e.offsetParent!==null;})[0]; var t=v.querySelector('.tile'); if(!t) return 'НЕТ'; t.click(); return 'ok'; })()`));
await new Promise(r => setTimeout(r, 1500));
console.log('  карточка:', await ev(`!!document.querySelector('.detail.open')`), '| имя:', await ev(`(function(){ var h=document.querySelector('.detail .dname'); return h? h.textContent : '?'; })()`));
ws.close();

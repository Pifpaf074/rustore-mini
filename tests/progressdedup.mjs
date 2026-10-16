// Два утверждения из ревью проверяются вместе:
// (5) частые onProgress с ОДИНАКОВЫМ текстом не должны вызывать перерисовку — движок
//     сам пропускает запись того же значения (incr.js: if (old !== v) trigger);
// (6) на старте каталог (витрина) не грузится: стартовая вкладка «Обновления», а
//     подборки подтягиваются лениво при переходе на «Приложения».
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
  window.__req = []; window.__bootDone = false;
  var apps = [ { packageName:'pkga', label:'AppA', versionName:'1.0', versionCode:1, enabled:true, suspended:false } ];
  window.WebToApk = {
    getInstalledApps: function(){ return JSON.stringify(apps); },
    getInstalledVersion: function(){ return apps[0].versionCode; },
    getInstalledSigner: function(){ return 'sig'; }, isPackageInstalled: function(){ return true; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.mine.webtoapk'}); },
    getDeviceInfo: function(){ return '{}'; },
    hailAvailable: function(){ return false; }, hailAction: function(){ return false; },
    getAppIcon: function(){ return ''; },
    installApk: function(json){
      var o = JSON.parse(json);
      // 20 одинаковых тиков прогресса (как при медленной закачке с шагом в 1%),
      // потом 10 разных — на них перерисовка ОБЯЗАНА быть.
      var i;
      for (i = 0; i < 20; i++) setTimeout(function(){ window.__webtoapkEvent('apk', {phase:'progress', got:50, total:100}); }, 10 + i * 5);
      for (i = 1; i <= 10; i++) setTimeout(function(){ window.__webtoapkEvent('apk', {phase:'progress', got:i*10, total:100}); }, 300 + i * 5);
      setTimeout(function(){ apps[0].versionName='2.0'; apps[0].versionCode=2; window.__webtoapkEvent('apk', {phase:'installed'}); }, 600);
    },
    openAppInfo: function(){}, launchApp: function(){ return true; }, openExternal: function(){},
    clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''); window.__req.push(url);
    var body = {}, status = 200;
    if (/showcase\\/sections/.test(url)) body = { code:'OK', body:{ elements:[ { selection:{ id:'s1', title:{ value:'Подборка' },
      content:{ appInfo:[ {packageName:'pkga',type:'APP'} ] } } } ] } };
    else if (/popular\\/apps/.test(url)) body = { apps: [] };
    else if (/applicationData\\/apps/.test(url)) body = { code:'OK', body:{ content:[ {packageName:'pkga',appId:1,appName:'AppA',versionCode:2,iconUrl:''} ] } };
    else if (/overallInfo/.test(url)) body = { code:'OK', body:{ packageName:'pkga', appName:'AppA', versionName:'2.0', versionCode:2, iconUrl:'' } };
    else if (/download-link/.test(url)) body = { appId:1, versionCode:2, signature:'sig', downloadUrls:[{ url:'https://x/a.apk', size:100, hash:'h' }] };
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:status, responseText: JSON.stringify(body) }); }, 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 7000));
if ((await ev(`typeof window.__req`)) !== 'object') { console.log('СТАБ НЕ УСТАНОВИЛСЯ — тест недействителен'); process.exit(1); }

const urls = await ev(`window.__req`);
const has = (re) => urls.filter(u => re.test(u)).length;
console.log('=== 6. Что запрашивается на старте (вкладка «Обновления») ===');
console.log('  всего запросов:', urls.length);
console.log('  витрина (sections):', has(/showcase\/sections/), has(/showcase\/sections/) === 0 ? 'OK (лениво)' : 'ПРОВАЛ (грузим каталог на старте)');
console.log('  популярное:', has(/popular\/apps/), has(/popular\/apps/) === 0 ? 'OK' : 'ПРОВАЛ');
console.log('  мета плиток (search-by-package):', has(/applicationData\/apps/), has(/applicationData\/apps/) === 0 ? 'OK' : 'ПРОВАЛ');
console.log('  проверка обновлений (overallInfo):', has(/overallInfo/), has(/overallInfo/) > 0 ? 'OK (она и нужна)' : 'ПРОВАЛ');
console.log('  список обновлений на экране:', await ev(`document.querySelectorAll('.sub .rcard').length`), 'строк');

console.log('\n=== 6. Переходим на «Приложения» — каталог должен подтянуться ===');
console.log('  клик:', await ev(`(function(){ var t=Array.prototype.filter.call(document.querySelectorAll('.tab'),function(e){return e.textContent==='Приложения';}); t[0].click(); return 'ok'; })()`));
await new Promise(r => setTimeout(r, 2000));
const urls2 = await ev(`window.__req`);
console.log('  новых запросов sections:', urls2.filter(u => /showcase\/sections/.test(u)).length, '(ожидаем 1)');
console.log('  плиток в рельсе:', await ev(`document.querySelectorAll('.view .rail .tile').length`), '| имя первой:', await ev(`(function(){ var n=document.querySelector('.view .rail .tile .tname'); return n? n.textContent : '?'; })()`));

console.log('\n=== 5. Прогресс установки: одинаковые тики не должны перерисовывать ===');
console.log('  back на «Обновления»:', await ev(`(function(){ var t=Array.prototype.filter.call(document.querySelectorAll('.tab'),function(e){return e.textContent==='Обновления';}); t[0].click(); return 'ok'; })()`));
await new Promise(r => setTimeout(r, 800));
const btn = () => ev(`(function(){ var rows=document.querySelectorAll('.sub .rcard');
  for (var i=0;i<rows.length;i++){ var p=rows[i].querySelector('.cpkg'); if(p && p.textContent.trim()==='pkga'){ var b=rows[i].querySelector('button'); return b? b.textContent : 'НЕТ КНОПКИ'; } } return 'НЕТ СТРОКИ'; })()`);
console.log('  кнопка строки до установки:', JSON.stringify(await btn()));
const before = await ev(`JSON.parse(JSON.stringify(window.__memoStats))`);
await ev(`(function(){ var rows=document.querySelectorAll('.sub .rcard');
  for (var i=0;i<rows.length;i++){ var p=rows[i].querySelector('.cpkg'); if(p && p.textContent.trim()==='pkga'){ rows[i].querySelector('button').click(); return 'ok'; } } return 'НЕТ'; })()`);
await new Promise(r => setTimeout(r, 260));
const mid = await ev(`JSON.parse(JSON.stringify(window.__memoStats))`);
console.log('  20 одинаковых тиков «50%» → memo-прогонов:', mid.ran - before.ran,
  (mid.ran - before.ran) <= 3 ? 'OK (движок пропускает запись того же значения)' : 'ПРОВАЛ (перерисовали ' + (mid.ran - before.ran) + ' раз)');
await new Promise(r => setTimeout(r, 500));
const after = await ev(`JSON.parse(JSON.stringify(window.__memoStats))`);
console.log('  10 разных тиков «10..100%» → memo-прогонов:', after.ran - mid.ran,
  (after.ran - mid.ran) >= 10 ? 'OK (на смену текста перерисовка есть)' : 'ПРОВАЛ (нет реакции на прогресс)');
await new Promise(r => setTimeout(r, 1500));
console.log('  после установки кнопка/строка:', JSON.stringify(await btn()));
console.log('  кэши:', await ev(`JSON.stringify(window.__cacheStats())`));
ws.close();

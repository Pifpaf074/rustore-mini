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
      // let (не var!) — иначе все колбэки увидят последнее значение счётчика и пришлют
      // один и тот же текст (тест тогда проверял бы дедуп вместо реакции на смену).
      for (let i = 0; i < 20; i++) setTimeout(function(){ window.__webtoapkEvent('apk', {phase:'progress', got:50, total:100}); }, 10 + i * 5);
      for (let i = 1; i <= 10; i++) setTimeout(function(){ window.__webtoapkEvent('apk', {phase:'progress', got:i*10, total:100}); }, 300 + i * 5);
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

console.log('\n=== 5. Прогресс установки: одинаковые тики не должны трогать DOM ===');
console.log('  back на «Обновления»:', await ev(`(function(){ var t=Array.prototype.filter.call(document.querySelectorAll('.tab'),function(e){return e.textContent==='Обновления';}); t[0].click(); return 'ok'; })()`));
await new Promise(r => setTimeout(r, 800));
const btn = () => ev(`(function(){ var rows=document.querySelectorAll('.rcard');
  for (var i=0;i<rows.length;i++){ var p=rows[i].querySelector('.cpkg'); if(p && p.textContent.trim()==='pkga'){ var b=rows[i].querySelector('button'); return b? b.textContent : 'НЕТ КНОПКИ'; } } return 'НЕТ СТРОКИ'; })()`);
const btnEl = `(function(){ var rows=document.querySelectorAll('.rcard');
  for (var i=0;i<rows.length;i++){ var p=rows[i].querySelector('.cpkg'); if(p && p.textContent.trim()==='pkga'){ return rows[i].querySelector('button'); } } return null; })()`;
console.log('  кнопка строки до установки:', JSON.stringify(await btn()));
// Считаем ФАКТИЧЕСКИЕ записи в DOM текста кнопки. Раньше проверяли по __memoStats,
// но движок обновляет текст точечным скоупом элемента, не прогоном memo — счётчик
// memo тут ничего не показывает (проверено: ran не растёт, а текст меняется).
await ev(`window.__mut = 0; window.__obs = new MutationObserver(function(recs){ window.__mut += recs.length; });
  window.__obs.observe(` + btnEl + `, { characterData: true, childList: true, subtree: true });`);
await ev(`(function(){ var rows=document.querySelectorAll('.rcard');
  for (var i=0;i<rows.length;i++){ var p=rows[i].querySelector('.cpkg'); if(p && p.textContent.trim()==='pkga'){ rows[i].querySelector('button').click(); return 'ok'; } } return 'НЕТ'; })()`);
// окно 1: 20 одинаковых тиков (10..110 мс); окно 2: 10 разных (305..350 мс)
await new Promise(r => setTimeout(r, 170));
const m1 = await ev(`window.__mut`);
console.log('  20 одинаковых тиков «50%» → записей в DOM:', m1, '| кнопка:', JSON.stringify(await btn()),
  m1 <= 2 ? 'OK (только реальные смены «…»→«50%», повторы отсечены)' : 'ПРОВАЛ (перерисовка на каждый тик)');
await ev(`window.__mut = 0`);
await new Promise(r => setTimeout(r, 280));
const m2 = await ev(`window.__mut`);
console.log('  10 разных тиков «10..100%» → записей в DOM:', m2, '| кнопка:', JSON.stringify(await btn()),
  m2 >= 8 ? 'OK (на смену текста реакция есть)' : 'ПРОВАЛ (нет реакции на прогресс)');
await new Promise(r => setTimeout(r, 1500));
console.log('  после установки кнопка/строка:', JSON.stringify(await btn()), '(ожидаем «НЕТ СТРОКИ» — строка ушла)');
console.log('  кэши:', await ev(`JSON.stringify(window.__cacheStats())`));
ws.close();

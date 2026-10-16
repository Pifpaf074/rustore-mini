// Очистка поиска должна отменять и запрос в полёте. clearSearch() не трогала ни searchSeq,
// ни searching: нажали Enter, стёрли строку до ответа — поздний ответ проходил проверку
// `my === searchSeq` и записывал результаты для пустого запроса (каталог пропадал, в поле пусто).
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
  window.__srch = 0;
  window.WebToApk = {
    getInstalledApps: function(){ return '[]'; }, getInstalledVersion: function(){ return 0; },
    getInstalledSigner: function(){ return ''; }, isPackageInstalled: function(){ return false; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.mine.webtoapk'}); },
    getDeviceInfo: function(){ return '{}'; }, hailAvailable: function(){ return false; }, hailAction: function(){ return false; },
    getAppIcon: function(){ return ''; }, installApk: function(){}, openAppInfo: function(){}, launchApp: function(){ return true; },
    openExternal: function(){}, clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){}
  };
  var app = function(p){ return { packageName:p, appName:'APP-'+p, type:'APP' }; };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''), body = {}, delay = 10;
    if (/showcase\\/sections/.test(url)) body = { code:'OK', body:{ elements:[{ selection:{ id:'s1', title:{value:'Подборка'}, subtitle:{value:''},
      content:{ appInfo:[app('pkga'), app('pkgb'), app('pkgc')] } } }] } };
    else if (/popular\\/apps/.test(url)) body = { apps: [app('pkgd')] };
    else if (/applicationData\\/apps/.test(url)) { window.__srch++; delay = 1500;
      body = { code:'OK', body:{ content:[{ packageName:'found1', appName:'FOUND-1' }], totalElements:1 } }; }
    else if (/suggests/.test(url)) body = { suggests: [] };
    else if (/overallInfo\\/([^/?]+)/.test(url)) { var p = RegExp.$1;
      body = { code:'OK', body:{ packageName:p, appName:'APP-'+p, versionName:'1.0', versionCode:1, iconUrl:'', signature:'',
        shortDescription:'', whatsNew:'', fileUrls:[], screenshots:[] } }; }
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:200, responseText: JSON.stringify(body) }); }, delay);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 6000));
if ((await ev(`typeof window.__srch`)) !== 'number') { console.log('СТАБ НЕ УСТАНОВИЛСЯ — тест недействителен'); process.exit(1); }

const clickText = (t) => ev(`(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ return x.textContent.trim()===${JSON.stringify(t)}; })[0];
  if(!b) return 'НЕТ КНОПКИ'; b.click(); return 'ok'; })()`);
const type = (v) => ev(`(function(){ var i=document.querySelector('input.q'); if(!i) return 'НЕТ ИНПУТА';
  i.value=${JSON.stringify(v)}; i.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`);
const enter = () => ev(`(function(){ var i=document.querySelector('input.q'); if(!i) return 'НЕТ ИНПУТА';
  i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 'ok'; })()`);
const state = () => ev(`JSON.stringify({
  tiles: [].slice.call(document.querySelectorAll('.tile')).filter(function(x){ return x.offsetParent !== null; }).length,
  results: [].slice.call(document.querySelectorAll('.rlist .rcard')).filter(function(x){ return x.offsetParent !== null; }).length,
  hint: (function(){ var h=document.querySelector('.rlist .hint'); return h && h.offsetParent !== null ? h.textContent : ''; })(),
  q: (document.querySelector('input.q') || {}).value })`);

console.log('открываю «Приложения»:', await clickText('Приложения'));
await new Promise(r => setTimeout(r, 2500));
console.log('1) каталог:', await state());
console.log('2) печатаю «tel»:', await type('tel'), '| Enter:', await enter());
await new Promise(r => setTimeout(r, 600));
console.log('   во время поиска:', await state(), '(запрос №' + (await ev('window.__srch')) + ')');
console.log('3) стираю строку до ответа:', await type(''));
await new Promise(r => setTimeout(r, 500));
console.log('   после очистки:', await state());
await new Promise(r => setTimeout(r, 2200));
const st = JSON.parse(await state());
console.log('4) поздний ответ пришёл (запросов:', await ev('window.__srch') + ')', await state());
console.log('   каталог на месте:', st.tiles > 0 ? 'OK' : 'ПРОВАЛ (каталог пропал)');
console.log('   чужих результатов нет:', st.results === 0 && st.hint === '' ? 'OK' : 'ПРОВАЛ (показана выдача для пустой строки)');
ws.close();

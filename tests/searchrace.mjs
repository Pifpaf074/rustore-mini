// Утверждение из ревью: после очистки поиска `history.back()` асинхронный, а следом идёт
// `armSentinel()`, и «если юзер успел кликнуть по карточке — стек разъедется».
// Проверяем: (1) вызывается ли `history.back()` из этой ветки вообще (инструментируем
// `history.back`); (2) что происходит в самом злом тайминге — клик по плитке в ТОМ ЖЕ
// таске, что и очистка (человек так не сможет, это верхняя граница окна); (3) меняет ли
// что-нибудь предложенный `return` (для этого рядом поднят сервер с пропатченным app.js).
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
  window.__pop = []; window.__backs = []; window.__sugReq = 0;
  var ob = history.back.bind(history);
  history.back = function(){ window.__backs.push(1); return ob(); };
  window.addEventListener('popstate', function(){ window.__pop.push(1); });
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
    var url = String(d.url||''), body = {};
    if (/showcase\\/sections/.test(url)) body = { code:'OK', body:{ elements:[ { selection:{ id:'s1', title:{ value:'Подборка' },
      content:{ appInfo:[ {packageName:'pkga',type:'APP'} ] } } } ] } };
    else if (/popular\\/apps/.test(url)) body = { apps: [] };
    else if (/applicationData\\/apps/.test(url)) body = { code:'OK', body:{ content:[ {packageName:'pkga',appId:1,appName:'APP-pkga',versionCode:1} ] } };
    else if (/overallInfo\\/([^/?]+)/.test(url)) body = { code:'OK', body:{ packageName:RegExp.$1, appName:'APP-pkga', versionName:'1.0', versionCode:1, shortDescription:'Описание' } };
    else if (/suggests/.test(url)) { window.__sugReq++; body = { suggests: [ { text:'аврора' } ] }; }
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:200, responseText: JSON.stringify(body) }); }, 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 6000));

const state = () => ev(`JSON.stringify(history.state)`);
const pops = () => ev(`(window.__pop||[]).length`);
const backs = () => ev(`(window.__backs||[]).length`);
const cardOpen = () => ev(`!!document.querySelector('.detail.open')`);
const setQuery = (v) => ev(`(function(){ var i=document.querySelector('.q'); if(!i) return 'НЕТ ИНПУТА'; i.value=${JSON.stringify(v)}; i.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`);
const clickTile = () => ev(`(function(){ var t=document.querySelector('.tile'); if(!t) return 'НЕТ ПЛИТКИ'; t.click(); return 'ok'; })()`);
const clickTab = (label) => ev(`(function(){ var t=Array.prototype.filter.call(document.querySelectorAll('.tab'),function(e){return e.textContent===${JSON.stringify(label)};}); if(!t.length) return 'НЕТ'; t[0].click(); return 'ok'; })()`);
const activeTab = () => ev(`(function(){ var t=document.querySelector('.tab.on'); return t? t.textContent : '?'; })()`);

console.log('BASE =', BASE);
await clickTab('Приложения');
await new Promise(r => setTimeout(r, 2500));
console.log('вкладка:', await activeTab(), '| history.state:', await state(), '| back() вызван раз:', await backs());

console.log('\n--- 1. Печатаю «a», потом стираю (вкладка «Приложения», есть navStack) ---');
console.log('  печатаю:', await setQuery('a'));
await new Promise(r => setTimeout(r, 700));
console.log('  history.state:', await state(), '| подсказок на экране:', await ev(`document.querySelectorAll('.sugrow').length`));
const b1 = await backs();
console.log('  стираю:', await setQuery(''));
await new Promise(r => setTimeout(r, 600));
console.log('  после очистки: history.state =', await state(), '| back() вызван раз:', await backs(), '(было', b1 + ')');
console.log('  ветка `!navStack.length && navArmed` сработала?', (await backs()) > b1 ? 'да' : 'НЕТ — history.back() не звали');
console.log('  подсказок на экране:', await ev(`document.querySelectorAll('.sugrow').length`), '| результатов:', await ev(`document.querySelectorAll('.results, .rlist').length`));

console.log('\n--- 2. Злой тайминг: стираю и кликаю по плитке в ОДНОМ таске ---');
await setQuery('a');
await new Promise(r => setTimeout(r, 700));
const p1 = await pops(), b2 = await backs();
console.log('  до клика: state =', await state(), '| popstate:', p1, '| back():', b2);
console.log('  ', await ev(`(function(){
  var i=document.querySelector('.q'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true}));
  var t=document.querySelector('.tile'); t.click();
  return 'ok (очистка + клик без единого тика между ними)';
})()`));
await new Promise(r => setTimeout(r, 1500));
const bOpen = await cardOpen();
console.log('  итог: карточка открыта:', bOpen, '| popstate:', await pops(), '| back():', await backs(), '| state:', await state());
console.log('  вердикт:', bOpen ? 'гонки нет — карточка устояла' : 'карточка закрылась отложенным popstate');

console.log('\n--- 3. Один back: закрывает ли он именно карточку и остаёмся ли в приложении ---');
await ev(`(function(){ history.back(); return 'ok'; })()`);
await new Promise(r => setTimeout(r, 900));
console.log('  карточка:', await cardOpen(), '| вкладка:', await activeTab(), '| state:', await state(), '| popstate:', await pops());
console.log('  (ожидаем: карточка закрыта, вкладка «Приложения» на месте — то есть стек не разъехался)');

console.log('\n--- 4. Печатаю «ab» и стираю ЧЕРЕЗ 100 мс (таймер подсказок ещё не сработал) ---');
const s1 = await ev(`window.__sugReq`);
await setQuery('ab');
await new Promise(r => setTimeout(r, 100));
await setQuery('');
await new Promise(r => setTimeout(r, 800));
const s2 = await ev(`window.__sugReq`);
console.log('  запросов подсказок за этот шаг:', s2 - s1, (s2 - s1) === 0 ? 'OK (таймер снят — лишнего запроса нет)' : 'лишний запрос (таймер не сняли)');
ws.close();

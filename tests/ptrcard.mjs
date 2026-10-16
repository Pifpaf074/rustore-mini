// Утверждение из ревью: ptrSync вызывается только из onScroll у .dbody, поэтому если
// при перерисовке карточки scrollTop сбросится в 0 без события scroll, PTR останется
// выключенным навсегда. Проверяем инвариант «PTR выключен ⟺ .dbody прокручен» после
// реальной перерисовки внутри карточки (ленивая загрузка отзывов).
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
  window.__ptr = [];
  var LONG = new Array(60).join('Очень длинное описание приложения для прокрутки. ');
  window.WebToApk = {
    getInstalledApps: function(){ return '[]'; }, getInstalledVersion: function(){ return 0; },
    getInstalledSigner: function(){ return ''; }, isPackageInstalled: function(){ return false; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.test',versionCode:1}); },
    getDeviceInfo: function(){ return '{}'; },
    hailAvailable: function(){ return false; }, hailAction: function(){ return false; },
    getAppIcon: function(){ return ''; }, installApk: function(){},
    openAppInfo: function(){}, launchApp: function(){ return true; },
    openExternal: function(){}, clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){},
    setPullToRefreshEnabled: function(on){ window.__ptr.push(!!on); }
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''), status = 200, body = null;
    if (/showcase\\/sections/.test(url)) {
      body = { code:'OK', body:{ elements:[ { selection:{ id:'s1', title:{ value:'Подборка' },
        content:{ appInfo:[ {packageName:'pkga',type:'APP'} ] } } } ] } };
    } else if (/popular\\/apps/.test(url)) { body = { apps: [] }; }
    else if (/applicationData\\/apps/.test(url)) body = { code:'OK', body:{ content:[ {packageName:'pkga',appId:1,appName:'APP-pkga',versionCode:1} ] } };
    else if (/overallInfo/.test(url)) body = { code:'OK', body:{ packageName:'pkga', appName:'APP-pkga', versionName:'1.0', versionCode:1,
      shortDescription:LONG, fileUrls:[] } };
    else if (/comment\\/comment/.test(url)) body = { code:'OK', body:{ content:[
        { commentId:1, firstName:'Тест', appRating:5, commentDate:'2026-01-02T00:00:00Z', commentText:'Отзыв раз' },
        { commentId:2, firstName:'Тест2', appRating:4, commentDate:'2026-01-03T00:00:00Z', commentText:'Отзыв два' } ],
      totalElements:2 } };
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:status, responseText: JSON.stringify(body||{}) }); }, 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 6000));

const clickTab = (label) => ev(`(function(){ var t=Array.prototype.filter.call(document.querySelectorAll('.tab'),function(e){return e.textContent===${JSON.stringify(label)};}); if(!t.length) return 'НЕТ ТАБА'; t[0].click(); return 'ok'; })()`);
const clickTile = (name) => ev(`(function(){ var t=Array.prototype.filter.call(document.querySelectorAll('.tile'),function(e){ var n=e.querySelector('.tname'); return n && n.textContent===${JSON.stringify(name)}; }); if(!t.length) return 'НЕТ ПЛИТКИ'; t[0].click(); return 'ok'; })()`);
const closeCard = () => ev(`(function(){ var b=document.querySelector('.detail .ibtn'); if(!b) return 'НЕТ'; b.click(); return 'ok'; })()`);
const setScroll = (v) => ev(`(function(){ var d=document.querySelector('.detail .dbody'); if(!d) return 'НЕТ .dbody'; d.scrollTop=${v}; return d.scrollTop; })()`);
const scrollTop = () => ev(`(function(){ var d=document.querySelector('.detail .dbody'); return d? d.scrollTop : -1; })()`);
const showComments = () => ev(`(function(){ var b=Array.prototype.filter.call(document.querySelectorAll('.detail button'),function(e){return e.textContent==='Показать отзывы';}); if(!b.length) return 'НЕТ КНОПКИ'; b[0].click(); return 'ok'; })()`);
const ptr = () => ev(`(function(){ var a=window.__ptr||[]; return a.length? a[a.length-1] : null; })()`);
const ptrAll = () => ev(`JSON.stringify(window.__ptr||[])`);
const domOk = () => ev(`(function(){ var d=document.querySelector('.detail .dbody'); if(!d) return 'НЕТ .dbody';
  return (d.scrollHeight>d.clientHeight) ? 'скроллится ('+d.scrollHeight+'>'+d.clientHeight+')' : 'НЕ скроллится ('+d.scrollHeight+'<='+d.clientHeight+')'; })()`);

await clickTab('Приложения');
await new Promise(r => setTimeout(r, 2000));
console.log('1) открываю карточку:', await clickTile('APP-pkga'));
await new Promise(r => setTimeout(r, 2500));
console.log('   .dbody:', await domOk(), '| PTR:', await ptr(), '(ждали true — карточка сверху)');

console.log('2) прокручиваю тело вниз:', await setScroll(250));
await new Promise(r => setTimeout(r, 400));
console.log('   scrollTop:', await scrollTop(), '| PTR:', await ptr(), (await ptr()) === false ? 'OK (выключен)' : 'ПРОВАЛ');

console.log('3) грузю отзывы (перерисовка ВНУТРИ карточки):', await showComments());
await new Promise(r => setTimeout(r, 2000));
const st = await scrollTop(), p = await ptr();
console.log('   отзывов на экране:', await ev(`document.querySelectorAll('.detail .cmt').length`));
console.log('   scrollTop после перерисовки:', st, st > 0 ? 'OK (не сбросился)' : 'ПРОВАЛ (сброшен в 0)');
console.log('   PTR после перерисовки:', p, p === (st > 0 ? false : true) ? 'OK (инвариант держится)' : 'ПРОВАЛ (рассинхрон)');

console.log('4) возвращаюсь в начало:', await setScroll(0));
await new Promise(r => setTimeout(r, 400));
console.log('   PTR:', await ptr(), (await ptr()) === true ? 'OK (снова доступен)' : 'ПРОВАЛ');

console.log('5) снова вниз → закрываю → открываю заново');
await setScroll(250);
await new Promise(r => setTimeout(r, 300));
await closeCard();
await new Promise(r => setTimeout(r, 700));
await clickTile('APP-pkga');
await new Promise(r => setTimeout(r, 2500));
const st2 = await scrollTop(), p2 = await ptr();
console.log('   scrollTop:', st2, '| PTR:', p2, (st2 === 0 && p2 === true) ? 'OK (состояние сброшено)' : 'ПРОВАЛ');
console.log('   все вызовы setPullToRefreshEnabled:', await ptrAll());
ws.close();

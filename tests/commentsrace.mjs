// Гонка отзывов: ответ СТАРОГО запроса не должен затирать свежий. Проверки «тот же пакет»
// (ST.detailPkg) мало — при закрытии detailPkg не сбрасывается, поэтому переоткрытие ТОЙ ЖЕ
// карточки (pull-to-refresh) пропускало устаревший ответ: он затирал новый список и гасил
// commentsLoading у запроса, который ещё в полёте. Теперь запрос запоминает detailSeq.
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
  window.__cmt = { calls: 0 };
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
    var url = String(d.url||''), body = {}, delay = 10;
    if (/overallInfo\\/([^/?]+)/.test(url)) { var p = RegExp.$1;
      body = { code:'OK', body:{ packageName:p, appName:'AppA', versionName:'1.0', versionCode:2, iconUrl:'', signature:'sig',
        shortDescription:'Описание', whatsNew:'Что нового', fileUrls:[], screenshots:[] } }; }
    else if (/comment\\/comment/.test(url)) {
      window.__cmt.calls++;
      var n = window.__cmt.calls;
      var text = n === 1 ? 'СТАРЫЙ-ОТЗЫВ' : 'НОВЫЙ-ОТЗЫВ';
      delay = n === 1 ? 1500 : 100;   // первый запрос «висит», второй отвечает сразу
      body = { code:'OK', body:{ content:[{ commentId:n, firstName:'U', appRating:5, commentText:text, commentDate:1700000000000 }], totalElements:1 } };
    }
    else if (/download-link/.test(url)) body = { appId:1, versionCode:2, signature:'sig', downloadUrls:[{ url:'https://x/a.apk', size:1000, hash:'h' }] };
    else if (/showcase\\/sections/.test(url)) body = { code:'OK', body:{ elements:[] } };
    else if (/popular\\/apps/.test(url)) body = { apps: [] };
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:200, responseText: JSON.stringify(body) }); }, delay);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 6000));
if ((await ev(`typeof window.__cmt`)) !== 'object') { console.log('СТАБ НЕ УСТАНОВИЛСЯ — тест недействителен'); process.exit(1); }

const openCard = () => ev(`(function(){ var p=document.querySelector('.updbar').parentNode; var rows=[].slice.call(p.querySelectorAll('.rcard'));
  if(!rows.length) return 'НЕТ СТРОК'; rows[0].click(); return 'ok'; })()`);
const clickShow = () => ev(`(function(){ var b=[].slice.call(document.querySelectorAll('.cmts button')).filter(function(x){ return /Показать отзывы/.test(x.textContent); })[0];
  if(!b) return 'НЕТ КНОПКИ'; b.click(); return 'ok'; })()`);
const texts = () => ev(`JSON.stringify([].slice.call(document.querySelectorAll('.cmt-text')).map(function(x){ return x.textContent; }))`);
const calls = () => ev('window.__cmt.calls');

console.log('открываю карточку:', await openCard());
await new Promise(r => setTimeout(r, 2000));
console.log('1) «Показать отзывы» (запрос №1, отвечает через 1.5 с):', await clickShow());
await new Promise(r => setTimeout(r, 300));
console.log('   переоткрываю ту же карточку через pull-to-refresh (detailSeq++):', await ev('window.__refreshCurrent(), "ok"'));
await new Promise(r => setTimeout(r, 400));
console.log('2) «Показать отзывы» снова (запрос №2, отвечает через 0.1 с):', await clickShow());
await new Promise(r => setTimeout(r, 400));
console.log('   после свежего ответа:', await texts(), '(запросов:', await calls(), ')');
await new Promise(r => setTimeout(r, 1600));
const t = JSON.parse(await texts());
console.log('3) после прихода УСТАРЕВШЕГО ответа:', JSON.stringify(t));
const stale = t.filter(x => /СТАРЫЙ/.test(x)).length, fresh = t.filter(x => /НОВЫЙ/.test(x)).length;
console.log('   старых:', stale, '| свежих:', fresh,
  stale === 0 && fresh === 1 ? 'OK (устаревший ответ отброшен)' : 'ПРОВАЛ (старый ответ затёр свежий)');
ws.close();

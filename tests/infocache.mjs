// Поздний ответ infoCached не должен воскрешать сброшенную запись кэша. Пока запрос проверки
// в полёте, runInstall после успешной установки делает delete updCache[pkg] (чтобы приложение
// не всплывало снова), а старый .then писал запись обратно безусловно — сброс пропадал и в
// кэше ещё UPD_TTL жили данные до установки. Теперь запись/удаление сверяют, что в кэше лежит
// именно этот промис.
// BASE=8099 — новый код; негативный контроль — app.js из ревизии ДО этого фикса
// (939908a^ на порту 8097): сам фикс уже в HEAD, поэтому HEAD-копия его содержит.
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

// Первый запрос — быстрый (строка появляется), второй (его запустит «Проверить») — висит 3 с,
// чтобы установка успела сделать delete updCache, пока он в полёте.
const stub = `
(function(){
  window.__oi = 0; window.__ver = 1;
  window.WebToApk = {
    getInstalledApps: function(){ return JSON.stringify([{packageName:'pkga',label:'AppA',versionName:'1.0',versionCode:window.__ver,enabled:true,suspended:false}]); },
    getInstalledVersion: function(){ return window.__ver; }, getInstalledSigner: function(){ return 'sig'; },
    isPackageInstalled: function(){ return true; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.mine.webtoapk'}); },
    getDeviceInfo: function(){ return '{}'; }, hailAvailable: function(){ return false; }, hailAction: function(){ return false; },
    getAppIcon: function(){ return ''; },
    installApk: function(){ setTimeout(function(){ window.__ver = 2; window.__webtoapkEvent('apk', {phase:'installed'}); }, 200); },
    openAppInfo: function(){}, launchApp: function(){ return true; }, openExternal: function(){},
    clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''), body = {}, delay = 10;
    if (/overallInfo\\/([^/?]+)/.test(url)) { var p = RegExp.$1;
      window.__oi++;
      if (window.__oi === 2) delay = 3000;
      body = { code:'OK', body:{ packageName:p, appName:'AppA', versionName:'2.0', versionCode:2, iconUrl:'', signature:'sig',
        shortDescription:'', whatsNew:'', fileUrls:[], screenshots:[] } }; }
    else if (/download-link/.test(url)) body = { appId:1, versionCode:2, signature:'sig', downloadUrls:[{ url:'https://x/a.apk', size:1000, hash:'h' }] };
    else if (/comment/.test(url)) body = { code:'OK', body:{ content:[], totalElements:0 } };
    else if (/showcase\\/sections/.test(url)) body = { code:'OK', body:{ elements:[] } };
    else if (/popular\\/apps/.test(url)) body = { apps: [] };
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:200, responseText: JSON.stringify(body) }); }, delay);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 7000));
if ((await ev(`typeof window.__oi`)) !== 'number') { console.log('СТАБ НЕ УСТАНОВИЛСЯ — тест недействителен'); process.exit(1); }

const clickText = (t) => ev(`(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ return x.textContent.trim()===${JSON.stringify(t)}; })[0];
  if(!b) return 'НЕТ КНОПКИ ' + ${JSON.stringify(t)}; b.click(); return 'ok'; })()`);
const clickRowBtn = () => ev(`(function(){ var rows=document.querySelectorAll('.rcard');
  for (var i=0;i<rows.length;i++){ var p=rows[i].querySelector('.cpkg'); if(p && p.textContent.trim()==='pkga'){ var b=rows[i].querySelector('button'); if(!b) return 'НЕТ КНОПКИ'; b.click(); return 'ok'; } }
  return 'НЕТ СТРОКИ pkga'; })()`);
const oi = () => ev('window.__oi');
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('1) запросов overallInfo после старта:', await oi(), '(строка обновления построена)');
console.log('2) «Проверить» (force):', await clickText('Проверить'));
await sleep(600);
console.log('   запросов:', await oi(), '(второй висит 3 с — он и должен воскресить кэш)');
console.log('3) устанавливаю обновление из строки (внутри runInstall будет delete updCache):', await clickRowBtn());
await sleep(1500);
console.log('   установлено, версия:', await ev('window.__ver'), '| запросов:', await oi());
await sleep(2500);   // ждём, пока зависший второй запрос наконец ответит
console.log('4) поздний ответ пришёл, запросов:', await oi());
const before = await oi();
await ev(`(function(){ return infoCached('pkga').then(function(){ return 1; }); })()`);
await sleep(300);
const after = await oi();
console.log('5) зову infoCached(pkga): запросов было', before, 'стало', after, '(разница', after - before + ')');
console.log('   сброшенный кэш остался сброшенным:', after > before ? 'OK (данные запрошены заново)' : 'ПРОВАЛ (поздний ответ воскресил запись)');
ws.close();

// После установки замороженного приложения список должен снова показать снежинку.
// refreshInstalled() вызывался сразу после установки, когда приложение было ещё разморожено,
// а обратная заморозка происходит в finally через 1.2 с — и список после неё никто не читал.
// Hail при этом работает асинхронно, поэтому перечитываем с задержкой (как в toggleFrozen).
// BASE=8099 — новый код; негативный контроль — app.js из ревизии ДО этого фикса
// (0767ac5^ на порту 8097): сам фикс уже в HEAD, поэтому HEAD-копия его содержит.
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

// Hail асинхронный: состояние пакета меняется не мгновенно (FREEZE — через 0.8 с).
const stub = `
(function(){
  window.__hail = []; window.__enabled = false; window.__ver = 1;
  window.WebToApk = {
    getInstalledApps: function(){ return JSON.stringify([{packageName:'pkga',label:'AppA',versionName:'1.0',versionCode:window.__ver,enabled:window.__enabled,suspended:false}]); },
    getInstalledVersion: function(){ return window.__ver; }, getInstalledSigner: function(){ return 'sig'; },
    isPackageInstalled: function(){ return true; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.mine.webtoapk'}); },
    getDeviceInfo: function(){ return '{}'; },
    hailAvailable: function(){ return true; },
    hailAction: function(action, pkg){
      window.__hail.push(action + ' ' + pkg);
      if (action === 'UNFREEZE') setTimeout(function(){ window.__enabled = true; }, 300);
      if (action === 'FREEZE') setTimeout(function(){ window.__enabled = false; }, 800);
      return true;
    },
    getAppIcon: function(){ return ''; },
    installApk: function(){ setTimeout(function(){ window.__ver = 2; window.__webtoapkEvent('apk', {phase:'installed'}); }, 200); },
    openAppInfo: function(){}, launchApp: function(){ return true; }, openExternal: function(){},
    clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''), body = {};
    if (/overallInfo\\/([^/?]+)/.test(url)) { var p = RegExp.$1;
      body = { code:'OK', body:{ packageName:p, appName:'AppA', versionName:'2.0', versionCode:2, iconUrl:'', signature:'sig',
        shortDescription:'', whatsNew:'', fileUrls:[], screenshots:[] } }; }
    else if (/download-link/.test(url)) body = { appId:1, versionCode:2, signature:'sig', downloadUrls:[{ url:'https://x/a.apk', size:1000, hash:'h' }] };
    else if (/comment/.test(url)) body = { code:'OK', body:{ content:[], totalElements:0 } };
    else if (/showcase\\/sections/.test(url)) body = { code:'OK', body:{ elements:[] } };
    else if (/popular\\/apps/.test(url)) body = { apps: [] };
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:200, responseText: JSON.stringify(body) }); }, 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 7000));
if ((await ev(`typeof window.__hail`)) !== 'object') { console.log('СТАБ НЕ УСТАНОВИЛСЯ — тест недействителен'); process.exit(1); }

const snow = () => ev(`[].slice.call(document.querySelectorAll('.snow')).filter(function(x){ return x.offsetParent !== null; }).length`);
const clickRowBtn = () => ev(`(function(){ var rows=document.querySelectorAll('.rcard');
  for (var i=0;i<rows.length;i++){ var p=rows[i].querySelector('.cpkg'); if(p && p.textContent.trim()==='pkga'){ var b=rows[i].querySelector('button'); if(!b) return 'НЕТ КНОПКИ'; b.click(); return 'ok'; } }
  return 'НЕТ СТРОКИ pkga'; })()`);
const clickText = (t) => ev(`(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ return x.textContent.trim()===${JSON.stringify(t)}; })[0];
  if(!b) return 'НЕТ КНОПКИ'; b.click(); return 'ok'; })()`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('1) строка обновления (пакет заморожен): снежинок', await snow(), (await snow()) === 1 ? 'OK' : 'ПРОВАЛ');
console.log('2) запускаю обновление из строки:', await clickRowBtn());
for (let k = 0; k < 60; k++) { await sleep(250); if ((await ev(`window.__hail.length`)) >= 2) break; }
console.log('   hail:', await ev('JSON.stringify(window.__hail)'));
await sleep(4000);   // установка + 1.2 с паузы + FREEZE + 1.6 с на перечитывание списка
console.log('   состояние пакета (enabled):', await ev('window.__enabled'), '| hail:', await ev('JSON.stringify(window.__hail)'));
console.log('3) «Установленные»:', await clickText('Установленные'));
await sleep(1200);
const s = await snow();
console.log('   снежинок в списке установленных:', s, s === 1 ? 'OK (заморозка видна)' : 'ПРОВАЛ (показан незамороженным)');
ws.close();

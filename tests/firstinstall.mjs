// firstInstall в запросе ссылки: true только для реальной установки, при обновлении — false.
// Раньше (до объединения doDownload/updateOne) карточка всегда слала true, строка списка — false.
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
  window.__dl = []; window.__inst = true; window.__ver = 1;
  window.WebToApk = {
    getInstalledApps: function(){ return JSON.stringify([{packageName:'pkga',label:'AppA',versionName:'1.0',versionCode:1,enabled:true,suspended:false}]); },
    getInstalledVersion: function(){ return window.__ver; }, getInstalledSigner: function(){ return 'sig'; },
    isPackageInstalled: function(){ return window.__inst; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.mine.webtoapk'}); },
    getDeviceInfo: function(){ return '{}'; }, hailAvailable: function(){ return false; }, hailAction: function(){ return false; },
    getAppIcon: function(){ return ''; },
    installApk: function(s){ setTimeout(function(){ window.__ver = 2; window.__webtoapkEvent('apk', {phase:'installed'}); }, 300); },
    openAppInfo: function(){}, launchApp: function(){ return true; }, openExternal: function(){},
    clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''), body = {};
    if (/download-link/.test(url)) {
      try { window.__dl.push(JSON.parse(d.data)); } catch (e) { window.__dl.push({ parse_error: String(e) }); }
      body = { appId:1, versionCode:2, signature:'sig', downloadUrls:[{ url:'https://x/a.apk', size:1000, hash:'h' }] };
    }
    else if (/overallInfo\\/([^/?]+)/.test(url)) { var p = RegExp.$1;
      body = { code:'OK', body:{ packageName:p, appName:'AppA', versionName:'1.0', versionCode:2, iconUrl:'', signature:'sig',
        shortDescription:'Описание', whatsNew:'Что нового', fileUrls:[], screenshots:[] } }; }
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
await new Promise(r => setTimeout(r, 6000));
if ((await ev(`typeof window.__dl`)) !== 'object') { console.log('СТАБ НЕ УСТАНОВИЛСЯ — тест недействителен'); process.exit(1); }

const openCard = () => ev(`(function(){ var p=document.querySelector('.updbar').parentNode; var rows=[].slice.call(p.querySelectorAll('.rcard'));
  if(!rows.length) return 'НЕТ СТРОК'; rows[0].click(); return 'ok'; })()`);
const btnText = () => ev(`(function(){ var b=document.querySelector('.dacts button.primary'); return b ? b.textContent : 'НЕТ КНОПКИ'; })()`);
const clickBtn = () => ev(`(function(){ var b=document.querySelector('.dacts button.primary'); if(!b) return 'НЕТ КНОПКИ'; b.click(); return 'ok'; })()`);
const dl = async () => JSON.parse(await ev('JSON.stringify(window.__dl)'));

console.log('открываю карточку:', await openCard());
await new Promise(r => setTimeout(r, 2000));
console.log('1) ОБНОВЛЕНИЕ, кнопка:', JSON.stringify(await btnText()));
console.log('   клик:', await clickBtn());
await new Promise(r => setTimeout(r, 1500));
let a = await dl();
console.log('   тело download-link:', JSON.stringify(a[0]));
console.log('   firstInstall:', a[0] && a[0].firstInstall, a[0] && a[0].firstInstall === false ? 'OK (обновление, не первая установка)' : 'ПРОВАЛ');

console.log('2) та же карточка, но приложение теперь НЕ установлено (эмулирую):', await ev('window.__inst = false, window.__ver = -1, "ok"'));
console.log('   переоткрываю карточку через pull-to-refresh:', await ev('window.__refreshCurrent(), "ok"'));
await new Promise(r => setTimeout(r, 1200));
console.log('   кнопка:', JSON.stringify(await btnText()));
console.log('   клик:', await clickBtn());
await new Promise(r => setTimeout(r, 1200));
a = await dl();
console.log('   тело download-link:', JSON.stringify(a[1]));
console.log('   firstInstall:', a[1] && a[1].firstInstall, a[1] && a[1].firstInstall === true ? 'OK (первая установка)' : 'ПРОВАЛ');
ws.close();

// Тик прогресса из карточки перерисовывал ВСЁ тело карточки: ST.rowBusy читался прямо
// в DETAILBODY, поэтому на каждый процент заново шли shotlist() и installState() —
// а это синхронные вызовы моста (isPackageInstalled + getInstalledVersion). Кнопка
// вынесена в отдельный компонент DLBTN, и в занятом состоянии она мост вообще не трогает.
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
  window.__c = { isInst: 0, ver: 0, apps: 0, icon: 0, ticks: 0 };
  window.WebToApk = {
    getInstalledApps: function(){ window.__c.apps++; return JSON.stringify([{packageName:'pkga',label:'AppA',versionName:'1.0',versionCode:1,enabled:true,suspended:false}]); },
    getInstalledVersion: function(){ window.__c.ver++; return 1; },
    getInstalledSigner: function(){ return 'sig'; },
    isPackageInstalled: function(){ window.__c.isInst++; return true; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.mine.webtoapk'}); },
    getDeviceInfo: function(){ return '{}'; }, hailAvailable: function(){ return false; }, hailAction: function(){ return false; },
    getAppIcon: function(){ window.__c.icon++; return ''; },
    installApk: function(){   // установка не завершается: измеряем только тики прогресса
      for (let i = 1; i <= 60; i++) setTimeout(function(){
        window.__c.ticks++; window.__webtoapkEvent('apk', {phase:'progress', got:i, total:60}); }, 20 + i * 20);
    },
    openAppInfo: function(){}, launchApp: function(){ return true; }, openExternal: function(){},
    clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''), body = {};
    if (/overallInfo\\/([^/?]+)/.test(url)) { var p = RegExp.$1;
      body = { code:'OK', body:{ packageName:p, appName:'AppA', versionName:'2.0', versionCode:2, iconUrl:'', signature:'sig',
        shortDescription:'Описание', whatsNew:'Что нового', fileUrls:[], screenshots:[] } }; }
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
await new Promise(r => setTimeout(r, 6000));
if ((await ev(`typeof window.__c`)) !== 'object') { console.log('СТАБ НЕ УСТАНОВИЛСЯ — тест недействителен'); process.exit(1); }

const c = async () => JSON.parse(await ev(`JSON.stringify(window.__c)`));
const openCard = () => ev(`(function(){ var p=document.querySelector('.updbar').parentNode; var rows=[].slice.call(p.querySelectorAll('.rcard'));
  if(!rows.length) return 'НЕТ СТРОК'; rows[0].click(); return 'ok'; })()`);
const cardBtn = () => ev(`(function(){ var b=document.querySelector('.dacts button.primary'); if(!b) return 'НЕТ КНОПКИ'; return b.textContent; })()`);
const clickCard = () => ev(`(function(){ var b=document.querySelector('.dacts button.primary'); if(!b) return 'НЕТ КНОПКИ'; b.click(); return 'ok'; })()`);

console.log('открываю карточку:', await openCard());
await new Promise(r => setTimeout(r, 2500));
console.log('  кнопка карточки:', JSON.stringify(await cardBtn()));
console.log('  клик:', await clickCard());
await new Promise(r => setTimeout(r, 350));
const before = await c();
console.log('  установка пошла, кнопка:', JSON.stringify(await cardBtn()));
await new Promise(r => setTimeout(r, 900));
const after = await c();
const calls = (after.isInst - before.isInst) + (after.ver - before.ver);
console.log('  тиков прогресса за окно:', after.ticks - before.ticks);
console.log('  вызовов моста из installState за окно:', calls,
  calls === 0 ? 'OK (тело карточки не перерисовывается, мост не дёргается)' : 'ПРОВАЛ (мост на каждый тик)');
console.log('  кнопка обновляется:', JSON.stringify(await cardBtn()), /%$/.test(await cardBtn()) ? 'OK' : 'ПРОВАЛ');
console.log('  всего вызовов моста:', JSON.stringify(after));
ws.close();

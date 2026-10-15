// Установка из КАРТОЧКИ должна убирать строку из списка обновлений (как в строке списка).
// BASE=8099 — новый код; BASE=8098 — негативный контроль (app.js без фикса: строка висит).
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

// Одно установленное приложение: на телефоне версия 1, в RuStore — 2 => строка обновления.
// installApk сразу «ставит» версию 2 и шлёт нативное событие installed.
const stub = `
(function(){
  var st = { versions:{'pkg-a':1} };
  window.__installs = [];
  window.WebToApk = {
    getInstalledApps: function(){ return JSON.stringify(Object.keys(st.versions).map(function(p){ return {packageName:p,label:'APP-'+p,versionCode:st.versions[p],versionName:'1.0',enabled:true}; })); },
    getInstalledVersion: function(p){ return st.versions[p]||0; },
    getInstalledSigner: function(){ return ''; },
    isPackageInstalled: function(p){ return p in st.versions; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.test',versionCode:1}); },
    getDeviceInfo: function(){ return '{}'; },
    hailAvailable: function(){ return false; }, hailAction: function(){ return false; },
    getAppIcon: function(){ return ''; },
    installApk: function(j){ window.__installs.push(String(j));
      st.versions['pkg-a'] = 2;
      setTimeout(function(){ window.__webtoapkEvent('apk',{phase:'installed'}); }, 50); },
    openAppInfo: function(){}, launchApp: function(){ return true; },
    openExternal: function(){}, clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){}
  };
  var of = window.fetch;
  var json = function(o,s){ return new Response(JSON.stringify(o),{status:s||200,headers:{'Content-Type':'application/json'}}); };
  window.fetch = function(u){
    var url = String(u&&u.url||u);
    var m = url.match(/overallInfo\\/([^?]+)/);
    if (m) { var p=decodeURIComponent(m[1]); return Promise.resolve(json({code:'OK',body:{packageName:p,appName:'APP-'+p,versionCode:2,versionName:'2.0',signature:'',
      shortDescription:'Описание.', whatsNew:'Что нового.', screenshots:[], fileSize:1048576}})); }
    if (/download-link/.test(url)) return Promise.resolve(json({downloadUrls:[{url:'http://127.0.0.1:8099/x.apk',size:10}]}));
    if (/version\\.json/.test(url)) return Promise.resolve(json({versionCode:0}));
    return of.apply(this,arguments);
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 6000));

const rows = async () => await ev(`(function(){ var b=document.querySelector('.updbar'); if(!b) return -1;
  return b.parentNode.querySelectorAll('.rcard').length; })()`);
const clickRow = async () => await ev(`(function(){ var b=document.querySelector('.updbar'); if(!b) return 'НЕТ .updbar';
  var r=b.parentNode.querySelectorAll('.rcard'); if(!r.length) return 'НЕТ СТРОК'; r[0].click(); return 'ok'; })()`);
const clickCardInstall = async () => await ev(`(function(){ var b=document.querySelector('.dacts button.primary');
  if(!b) return 'НЕТ КНОПКИ'; b.click(); return 'ok'; })()`);
const closeCard = async () => await ev(`(function(){ var b=document.querySelector('.detail .ibtn'); if(!b) return 'НЕТ'; b.click(); return 'ok'; })()`);
const toast = async () => await ev(`(function(){ var t=document.querySelector('.toast'); return t?t.textContent:''; })()`);
const installs = async () => await ev('JSON.stringify(window.__installs)');

console.log('1) строк в списке обновлений:', await rows());
console.log('2) открываю карточку:', await clickRow());
await new Promise(r => setTimeout(r, 2000));
console.log('3) жму «Обновить» в карточке:', await clickCardInstall());
await new Promise(r => setTimeout(r, 2500));
console.log('   installApk вызван:', await installs());
console.log('   тост:', await toast());
console.log('4) закрываю карточку:', await closeCard());
await new Promise(r => setTimeout(r, 800));
const n = await rows();
console.log('   строк в списке обновлений:', n, n === 0 ? 'OK (строка убрана)' : 'ПРОВАЛ (строка висит)');
ws.close();

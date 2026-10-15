// Pull-to-refresh не должен дёргаться, когда прокручен оверлей карточки.
// BASE=8099 — новый код; BASE=8098 — негативный контроль (app.js без фикса).
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
  var st = { installed:['pkg-a'], versions:{'pkg-a':1}, remote:{'pkg-a':2} };
  window.WebToApk = {
    getInstalledApps: function(){ return JSON.stringify(st.installed.map(function(p){ return {packageName:p,label:'A',versionCode:st.versions[p],versionName:'1.0',enabled:true}; })); },
    getInstalledVersion: function(p){ return st.versions[p]||0; },
    getInstalledSigner: function(){ return ''; },
    isPackageInstalled: function(p){ return st.installed.indexOf(p)>=0; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.test',versionCode:1}); },
    getDeviceInfo: function(){ return '{}'; },
    hailAvailable: function(){ return false; }, hailAction: function(){ return false; },
    getAppIcon: function(){ return ''; },
    installApk: function(){}, openAppInfo: function(){}, launchApp: function(){ return true; },
    openExternal: function(){}, clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){},
    setPullToRefreshEnabled: function(v){ window.__ptr.push(!!v); }
  };
  var of = window.fetch;
  var json = function(o,s){ return new Response(JSON.stringify(o),{status:s||200,headers:{'Content-Type':'application/json'}}); };
  window.fetch = function(u){
    var url = String(u&&u.url||u);
    var m = url.match(/overallInfo\\/([^?]+)/);
    if (m) { var p=decodeURIComponent(m[1]); return Promise.resolve(json({code:'OK',body:{packageName:p,appName:'APP-'+p,versionCode:2,versionName:'1.0',signature:'',
      shortDescription:new Array(40).join('Описание приложения. '), whatsNew:new Array(20).join('Что нового. '),
      screenshots:[]}})); }
    if (/download-link/.test(url)) return Promise.resolve(json({downloadUrls:[{url:'http://127.0.0.1:8099/x.apk',size:10}]}));
    return of.apply(this,arguments);
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 5000));

const rowClick = async () => await ev(`(function(){ var p=document.querySelector('.updbar').parentNode; var rows=[].slice.call(p.querySelectorAll('.rcard'));
  if(!rows.length) return 'НЕТ СТРОК'; rows[0].click(); return 'ok'; })()`);
const scrollTo = async (y) => await ev(`(function(){ var d=document.querySelector('.dbody'); if(!d) return 'НЕТ .dbody';
  d.scrollTop = ${y}; d.dispatchEvent(new Event('scroll')); return JSON.stringify({st:d.scrollTop, scrollH:d.scrollHeight, clientH:d.clientHeight}); })()`);
const closeCard = async () => await ev(`(function(){ var b=document.querySelector('.detail .ibtn'); if(!b) return 'НЕТ'; b.click(); return 'ok'; })()`);
const ptr = async () => await ev('JSON.stringify(window.__ptr)');

console.log('1) открываю карточку:', await rowClick());
await new Promise(r => setTimeout(r, 1500));
console.log('   .dbody:', await scrollTo(0), '| ptr:', await ptr());
console.log('2) прокрутил описание вниз:', await scrollTo(400));
await new Promise(r => setTimeout(r, 300));
const a = JSON.parse(await ptr());
console.log('   ptr:', JSON.stringify(a), a[a.length - 1] === false ? 'OK (запрещён)' : 'ПРОВАЛ');
console.log('3) вернулся в начало:', await scrollTo(0));
await new Promise(r => setTimeout(r, 300));
const b = JSON.parse(await ptr());
console.log('   ptr:', JSON.stringify(b), b[b.length - 1] === true ? 'OK (разрешён)' : 'ПРОВАЛ');
console.log('4) закрываю карточку:', await closeCard());
await new Promise(r => setTimeout(r, 400));
const c = JSON.parse(await ptr());
console.log('   ptr:', JSON.stringify(c), c[c.length - 1] === true ? 'OK' : 'ПРОВАЛ');
ws.close();

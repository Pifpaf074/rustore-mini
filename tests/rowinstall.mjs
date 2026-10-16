// Проверка объединённого пути установки (runInstall) со стороны строки списка:
// (1) обычное обновление строки — строка уходит из списка, тост «обновлён»,
//     «Установленные» перечитываются, в натив уходит имя файла с версией;
// (2) замороженное приложение — UNFREEZE до установки и FREEZE после;
// (3) откат на системный установщик (installed:false) — «Обновить все» останавливается
//     после первой же такой строки и ничего не убирает из списка.
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
  window.__installs = []; window.__hail = []; window.__manual = false;
  var apps = [
    { packageName:'pkga', label:'AppA', versionName:'1.0', versionCode:1, enabled:true,  suspended:false },
    { packageName:'pkgb', label:'AppB', versionName:'1.0', versionCode:1, enabled:true,  suspended:false },
    { packageName:'pkgc', label:'AppC', versionName:'1.0', versionCode:1, enabled:false, suspended:false }
  ];
  function find(p){ for (var i=0;i<apps.length;i++) if (apps[i].packageName===p) return apps[i]; return null; }
  window.WebToApk = {
    getInstalledApps: function(){ return JSON.stringify(apps); },
    getInstalledVersion: function(p){ var a=find(p); return a? a.versionCode : 0; },
    getInstalledSigner: function(){ return 'sig'; }, isPackageInstalled: function(){ return true; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.mine.webtoapk',versionCode:26,versionName:'2.9.7'}); },
    getDeviceInfo: function(){ return '{}'; },
    hailAvailable: function(){ return true; },
    hailAction: function(action,pkg){ window.__hail.push([action,pkg]); return true; },
    getAppIcon: function(){ return ''; },
    installApk: function(json){
      var o = JSON.parse(json);
      window.__installs.push(o.name);
      var pkg = String(o.name||'').replace(/-\\d+\\.apk$/,'').replace(/\\.apk$/,'');
      setTimeout(function(){ window.__webtoapkEvent('apk', {phase:'progress', got:50, total:100}); }, 40);
      setTimeout(function(){
        if (window.__manual) { window.__webtoapkEvent('apk', {phase:'done', session:false}); return; }
        var a = find(pkg); if (a) { a.versionName='2.0'; a.versionCode=2; a.enabled=true; }
        window.__webtoapkEvent('apk', {phase:'installed'});
      }, 250);
    },
    openAppInfo: function(){}, launchApp: function(){ return true; }, openExternal: function(){},
    clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''), body = {};
    if (/showcase\\/sections/.test(url)) body = { code:'OK', body:{ elements:[] } };
    else if (/popular\\/apps/.test(url)) body = { apps: [] };
    else if (/applicationData\\/apps/.test(url)) body = { code:'OK', body:{ content:[] } };
    else if (/overallInfo\\/([^/?]+)/.test(url)) { var p=RegExp.$1; body = { code:'OK', body:{ packageName:p, appName:'App'+p.slice(-1).toUpperCase(),
      versionName:'2.0', versionCode:2, iconUrl:'', signature:'sig' } }; }
    else if (/download-link/.test(url)) { var m=/packageName=([^&]+)/.exec(url); var q=m? decodeURIComponent(m[1]) : 'x';
      body = { appId:1, versionCode:2, signature:'sig', downloadUrls:[{ url:'https://x/'+q+'.apk', size:100, hash:'h' }] }; }
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:200, responseText: JSON.stringify(body) }); }, 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 7000));

const rows = () => ev(`(function(){ return Array.prototype.filter.call(document.querySelectorAll('.sub .rcard'), function(e){ return e.offsetParent !== null; }).length; })()`);
const pkgs = () => ev(`JSON.stringify(Array.prototype.filter.call(document.querySelectorAll('.sub .rcard'), function(e){ return e.offsetParent !== null; }).map(function(e){ return e.querySelector('.cpkg').textContent.trim(); }))`);
const toastText = () => ev(`(function(){ var t=document.querySelector('.toast'); return t? t.textContent : ''; })()`);
const clickRowBtn = (pkg) => ev(`(function(){ var rows=document.querySelectorAll('.rcard');
  for (var i=0;i<rows.length;i++){ var p=rows[i].querySelector('.cpkg'); if(p && p.textContent.trim()===${JSON.stringify(pkg)}){ var b=rows[i].querySelector('button'); if(!b) return 'НЕТ КНОПКИ'; b.click(); return 'ok'; } }
  return 'НЕТ СТРОКИ'; })()`);
const clickAll = () => ev(`(function(){ var b=Array.prototype.filter.call(document.querySelectorAll('.updbar button'),function(e){return e.textContent==='Обновить все';}); if(!b.length) return 'НЕТ КНОПКИ'; b[0].click(); return 'ok'; })()`);
const installedRow = (pkg) => ev(`(function(){ var rows=document.querySelectorAll('.rcard');
  for (var i=0;i<rows.length;i++){ var p=rows[i].querySelector('.cpkg'); if(p && p.textContent.trim().indexOf(${JSON.stringify(pkg)})===0) return p.textContent.trim(); }
  return 'НЕТ'; })()`);

console.log('стартовый список обновлений:', await rows(), await pkgs());
console.log('  (ожидаем 3 строки: pkga, pkgb, pkgc — у всех версия 1.0 → 2.0)');

console.log('\n--- 1. Обновление строки pkga ---');
console.log('  клик по «Обновить»:', await clickRowBtn('pkga'));
await new Promise(r => setTimeout(r, 3000));
console.log('  вызовы installApk:', await ev(`JSON.stringify(window.__installs)`), '(имя файла с версией)');
console.log('  строк осталось:', await rows(), await pkgs());
console.log('  тост:', JSON.stringify(await toastText()));
// «Установленные» рисуются лениво (только когда под-таб открыт) — открываем его.
await ev(`(function(){ var b=Array.prototype.filter.call(document.querySelectorAll('.segbtn'),function(e){return e.textContent==='Установленные';}); if(b.length) b[0].click(); return 'ok'; })()`);
await new Promise(r => setTimeout(r, 300));
console.log('  строка pkga в «Установленных»:', await installedRow('pkga'), '(должна быть 2.0 — значит refreshInstalled сработал)');

console.log('\n--- 2. Обновление ЗАМОРОЖЕННОГО pkgc (Hail) ---');
console.log('  клик по «Обновить»:', await clickRowBtn('pkgc'));
await new Promise(r => setTimeout(r, 4000));
console.log('  вызовы Hail:', await ev(`JSON.stringify(window.__hail)`), '(ожидаем UNFREEZE → FREEZE)');
console.log('  строк осталось:', await rows(), await pkgs());
console.log('  тост:', JSON.stringify(await toastText()));

console.log('\n--- 3. Откат на системный установщик при «Обновить все» ---');
await ev(`(function(){ window.__manual = true; return 'ok'; })()`);
const before = await ev(`window.__installs.length`);
console.log('  клик «Обновить все»:', await clickAll());
await new Promise(r => setTimeout(r, 3000));
const after = await ev(`window.__installs.length`);
console.log('  попыток установки:', after - before, (after - before) === 1 ? 'OK (остановились после первой)' : 'ПРОВАЛ (пошли дальше)');
console.log('  тост:', JSON.stringify(await toastText()), /вручную/.test(await toastText()) ? 'OK' : 'ПРОВАЛ');
console.log('  строки на месте (ничего не убрали):', await rows(), await pkgs());
ws.close();

// Два утверждения из ревью про состояние после установки:
//   A) кнопка в карточке не обновляется (якобы installState не реактивен);
//   B) установленное приложение не появляется во вкладке «Установленные» (ST.installed устаревает).
// Тест стабит мост: pkgb НЕ установлен, установка помечает его установленным и шлёт фазу installed.
// Запускать ДО фикса и ПОСЛЕ — какой пункт реально ломается, видно по строкам вывода.
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
  var versions = { pkga: 1 };              // pkgb — НЕ установлен
  var names = { pkga: 'APP-pkga', pkgb: 'APP-pkgb' };
  window.__installs = [];
  window.WebToApk = {
    getInstalledApps: function(){
      return JSON.stringify(Object.keys(versions).map(function(p){
        return { packageName:p, label:names[p], versionCode:versions[p], versionName:versions[p]+'.0', enabled:true };
      }));
    },
    getInstalledVersion: function(p){ return versions[p]||0; },
    getInstalledSigner: function(){ return ''; },
    isPackageInstalled: function(p){ return p in versions; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.test',versionCode:1}); },
    getDeviceInfo: function(){ return '{}'; },
    hailAvailable: function(){ return false; }, hailAction: function(){ return false; },
    getAppIcon: function(){ return ''; },
    installApk: function(j){
      window.__installs.push(String(j));
      // Мост зовёт BT.installApk(JSON.stringify({...})) — в натив уходит СТРОКА, а не объект.
      try { j = JSON.parse(String(j)); } catch (e) { j = {}; }
      var p = String(j.name||'').replace(/-\\d+\\.apk$/, '').replace(/\\.apk$/, '');
      setTimeout(function(){ versions[p] = 2; window.__webtoapkEvent('apk', { phase:'installed' }); }, 60);
    },
    openAppInfo: function(){}, launchApp: function(){ return true; },
    openExternal: function(){}, clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){},
    httpRequest: function(){}, httpAbort: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''), status = 200, body = null;
    if (/showcase\\/sections/.test(url)) {
      body = { code:'OK', body:{ elements:[ { selection:{ id:'s1', title:{ value:'Тестовая подборка' },
        content:{ appInfo:[ { packageName:'pkgb', type:'APP' } ] } } } ] } };
    } else if (/popular\\/apps/.test(url)) { body = { apps: [] }; }
    else if (/applicationData\\/apps/.test(url)) {
      var q = decodeURIComponent((url.match(/query=([^&]*)/)||[])[1]||'');
      body = { code:'OK', body:{ content:[ { packageName:q, appId:7, appName:names[q]||q, iconUrl:'', averageUserRating:4.2, versionCode:2 } ] } };
    } else if (/overallInfo/.test(url)) {
      var p = decodeURIComponent((url.match(/overallInfo\\/([^?]+)/)||[])[1]||'');
      body = { code:'OK', body:{ packageName:p, appName:names[p]||p, versionCode:2, versionName:'2.0', signature:'', shortDescription:'x', fileUrls:[] } };
    } else if (/download-link/.test(url)) { body = { downloadUrls:[ { url:'http://127.0.0.1:8099/x.apk', size:10 } ] }; }
    else if (/version\\.json/.test(url)) { body = { versionCode:0 }; }
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:status, responseText: JSON.stringify(body||{}) }); }, 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 6000));

const clickTab = (label) => ev(`(function(){ var t=Array.prototype.filter.call(document.querySelectorAll('.tab'),function(e){return e.textContent===${JSON.stringify(label)};}); if(!t.length) return 'НЕТ ТАБА'; t[0].click(); return 'ok'; })()`);
const clickSeg = (label) => ev(`(function(){ var t=Array.prototype.filter.call(document.querySelectorAll('.segbtn'),function(e){return e.textContent===${JSON.stringify(label)};}); if(!t.length) return 'НЕТ СЕГМЕНТА'; t[0].click(); return 'ok'; })()`);
const clickTile = (name) => ev(`(function(){ var t=Array.prototype.filter.call(document.querySelectorAll('.tile'),function(e){ var n=e.querySelector('.tname'); return n && n.textContent===${JSON.stringify(name)}; }); if(!t.length) return 'НЕТ ПЛИТКИ'; t[0].click(); return 'ok'; })()`);
const cardBtn = () => ev(`(function(){ var b=document.querySelector('.dacts button.primary'); return b? b.textContent : 'НЕТ КНОПКИ'; })()`);
const clickCardBtn = () => ev(`(function(){ var b=document.querySelector('.dacts button.primary'); if(!b) return 'НЕТ КНОПКИ'; b.click(); return 'ok'; })()`);
const closeCard = () => ev(`(function(){ var b=document.querySelector('.detail .ibtn'); if(!b) return 'НЕТ'; b.click(); return 'ok'; })()`);
const installed = () => ev(`(function(){ var h=document.querySelector('.insthead'); if(!h) return '[]';
  return JSON.stringify(Array.prototype.map.call(h.parentNode.querySelectorAll('.rcard .cpkg'),function(e){ return e.textContent.split('  ')[0]; })); })()`);
const toast = () => ev(`(function(){ var t=document.querySelector('.toast'); return t?t.textContent:''; })()`);
const installs = () => ev('JSON.stringify(window.__installs||[])');

// 0) прогреваем «Установленные», чтобы список успел устареть
await clickSeg('Установленные');
await new Promise(r => setTimeout(r, 1500));
console.log('0) «Установленные» до установки:', await installed());

// 1) каталог → карточка pkgb
console.log('1) таб «Приложения»:', await clickTab('Приложения'));
await new Promise(r => setTimeout(r, 2000));
console.log('   клик по плитке pkgb:', await clickTile('APP-pkgb'));
await new Promise(r => setTimeout(r, 2500));
const before = await cardBtn();
console.log('2) кнопка в карточке до установки:', JSON.stringify(before), before === 'Установить' ? 'OK' : 'ПРОВАЛ (ждали «Установить»)');

// 2) устанавливаем
console.log('3) жму кнопку:', await clickCardBtn());
await new Promise(r => setTimeout(r, 3500));
const after = await cardBtn();
console.log('   installApk получил:', await installs());
console.log('   тост:', JSON.stringify(await toast()));
console.log('4) кнопка в карточке ПОСЛЕ установки:', JSON.stringify(after),
  after === 'Открыть' ? 'OK (обновилась)' : 'ПРОВАЛ (осталась старой)');

// 3) смотрим «Установленные» — появился ли pkgb
console.log('5) закрываю карточку:', await closeCard());
await new Promise(r => setTimeout(r, 600));
await clickTab('Обновления');
await new Promise(r => setTimeout(r, 600));
await clickSeg('Установленные');
await new Promise(r => setTimeout(r, 1200));
const list = JSON.parse(await installed() || '[]');
console.log('6) «Установленные» после установки:', JSON.stringify(list),
  list.indexOf('pkgb') >= 0 ? 'OK (появился)' : 'ПРОВАЛ (не появился)');
ws.close();

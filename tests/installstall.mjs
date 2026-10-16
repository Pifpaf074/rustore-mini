// Сторож установки (native.js): если натив замолчал (умер поток загрузки, встал
// DownloadManager), промис installApk раньше не садился НИКОГДА — app.js продолжал
// считать, что установка идёт, и блокировал все следующие (installBusy) до перезапуска.
// Теперь: тишина дольше __installIdleMs во время загрузки = ошибка + снятие блокировки.
// Но фазы permission/pending/confirm ждут пользователя — там тишина нормальна,
// сторож должен молчать (иначе сломаем «разрешите установку»).
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

// pkga — один тик прогресса и тишина (умер поток);
// pkgb — прогресс идёт (норма), в конце установка;
// pkgc — фаза permission и тишина (ждём пользователя).
const stub = `
(function(){
  var apps = [
    { packageName:'pkga', label:'AppA', versionName:'1.0', versionCode:1, enabled:true, suspended:false },
    { packageName:'pkgb', label:'AppB', versionName:'1.0', versionCode:1, enabled:true, suspended:false },
    { packageName:'pkgc', label:'AppC', versionName:'1.0', versionCode:1, enabled:true, suspended:false }
  ];
  function find(p){ for (var i=0;i<apps.length;i++) if (apps[i].packageName===p) return apps[i]; return null; }
  window.WebToApk = {
    getInstalledApps: function(){ return JSON.stringify(apps); },
    getInstalledVersion: function(p){ var a=find(p); return a? a.versionCode : 0; },
    getInstalledSigner: function(){ return 'sig'; }, isPackageInstalled: function(){ return true; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.mine.webtoapk',versionCode:27,versionName:'2.9.8'}); },
    getDeviceInfo: function(){ return '{}'; },
    hailAvailable: function(){ return false; }, hailAction: function(){ return false; },
    getAppIcon: function(){ return ''; },
    installApk: function(json){
      var o = JSON.parse(json);
      var pkg = String(o.name||'').replace(/-\\d+\\.apk$/,'');
      if (pkg === 'pkga') {
        setTimeout(function(){ window.__webtoapkEvent('apk', {phase:'progress', got:50, total:100}); }, 50);
        return;                                   // дальше — тишина навсегда
      }
      if (pkg === 'pkgb') {
        var i = 0;
        var t = setInterval(function(){ window.__webtoapkEvent('apk', {phase:'progress', got:(++i)*10, total:100}); }, 150);
        setTimeout(function(){ clearInterval(t); var a=find('pkgb'); a.versionName='2.0'; a.versionCode=2;
          window.__webtoapkEvent('apk', {phase:'installed'}); }, 2200);
        return;
      }
      setTimeout(function(){ window.__webtoapkEvent('apk', {phase:'permission'}); }, 50);
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
    else if (/overallInfo\\/([^/?]+)/.test(url)) { var p=RegExp.$1; body = { code:'OK', body:{ packageName:p,
      appName:'App'+p.slice(-1).toUpperCase(), versionName:'2.0', versionCode:2, iconUrl:'', signature:'sig' } }; }
    else if (/download-link/.test(url)) body = { appId:1, versionCode:2, signature:'sig',
      downloadUrls:[{ url:'https://x/a.apk', size:1000, hash:'h' }] };
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:200, responseText: JSON.stringify(body) }); }, 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 6000));
if ((await ev(`typeof window.__installs`)) !== 'undefined' && (await ev(`typeof window.__webtoapkEvent`)) !== 'function') { console.log('СТАБ НЕ УСТАНОВИЛСЯ — тест недействителен'); process.exit(1); }

const btnText = (pkg) => ev(`(function(){ var rows=document.querySelectorAll('.rcard');
  for (var i=0;i<rows.length;i++){ var p=rows[i].querySelector('.cpkg'); if(p && p.textContent.trim()===${JSON.stringify(pkg)}){ var b=rows[i].querySelector('button'); return b? b.textContent : 'НЕТ КНОПКИ'; } } return 'НЕТ СТРОКИ'; })()`);
const clickRow = (pkg) => ev(`(function(){ var rows=document.querySelectorAll('.rcard');
  for (var i=0;i<rows.length;i++){ var p=rows[i].querySelector('.cpkg'); if(p && p.textContent.trim()===${JSON.stringify(pkg)}){ var b=rows[i].querySelector('button'); b.click(); return 'ok'; } } return 'НЕТ'; })()`);
const toastText = () => ev(`(function(){ var t=document.querySelector('.toast'); return t? t.textContent : ''; })()`);
// Тост живёт несколько секунд, поэтому перед следующим шагом дожидаемся, пока он уйдёт:
// иначе проверка «нет ошибки» увидит ошибку предыдущего шага.
const waitToastClear = async () => { for (let i = 0; i < 40; i++) { if (!(await toastText())) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
// Оба под-таба («Обновления»/«Установленные») всегда в DOM (скрыты через hidden),
// поэтому считаем только видимые строки.
const rows = () => ev(`(function(){ return Array.prototype.filter.call(document.querySelectorAll('.sub .rcard'), function(e){ return e.offsetParent !== null; }).length; })()`);

console.log('строк в списке обновлений:', await rows());
await ev(`window.__installIdleMs = 1200`);

// --- 1. натив замолчал: сторож обязан выдать ошибку и разблокировать установки ---
console.log('\n=== 1. Один тик прогресса и тишина (pkga) ===');
console.log('  клик:', await clickRow('pkga'));
await new Promise(r => setTimeout(r, 400));
console.log('  кнопка в процессе:', JSON.stringify(await btnText('pkga')));
await new Promise(r => setTimeout(r, 1500));
const t1 = await toastText();
console.log('  тост:', JSON.stringify(t1), /не отвечает/.test(t1) ? 'OK (сторож сработал)' : 'ПРОВАЛ (промис не сядет)');
const b1 = await btnText('pkga');
console.log('  кнопка после:', JSON.stringify(b1), b1 === 'Обновить' ? 'OK (блокировка снята)' : 'ПРОВАЛ (осталась заблокированной)');

// --- 2. нормальный прогресс: сторож не должен мешать ---
console.log('\n=== 2. Прогресс идёт (pkgb) ===');
await waitToastClear();
console.log('  клик:', await clickRow('pkgb'));
await new Promise(r => setTimeout(r, 1500));
const b2 = await btnText('pkgb'), t2 = await toastText();
console.log('  кнопка:', JSON.stringify(b2), /%$/.test(b2) ? 'OK (идёт загрузка)' : 'ПРОВАЛ');
console.log('  тост:', JSON.stringify(t2), /не отвечает/.test(t2) ? 'ПРОВАЛ (сторож сработал на живой загрузке)' : 'OK (сторож молчит)');
await new Promise(r => setTimeout(r, 1500));
console.log('  строк в списке после установки:', await rows(), '(ожидаем 2 — pkgb ушёл)');

// --- 3. permission: тишина нормальна, сторож обязан молчать ---
console.log('\n=== 3. Фаза permission и тишина (pkgc) ===');
await waitToastClear();
console.log('  клик:', await clickRow('pkgc'));
await new Promise(r => setTimeout(r, 2500));
const b3 = await btnText('pkgc'), t3 = await toastText();
console.log('  кнопка:', JSON.stringify(b3), /Разрешите/.test(b3) ? 'OK (ждём пользователя)' : 'ПРОВАЛ');
console.log('  тост:', JSON.stringify(t3), /не отвечает/.test(t3) ? 'ПРОВАЛ (сломали ожидание разрешения)' : 'OK (сторож снят на permission)');
ws.close();

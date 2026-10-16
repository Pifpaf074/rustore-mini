// Скрытые вкладки: список «Установленные» строился всегда, даже когда под-таб не открыт.
// С 200 приложениями это ~2400 узлов в DOM и их перерисовка на каждой проверке
// обновлений. Тяжёлая часть (нативные getAppIcon) была починена раньше (tests/iconslazy.mjs),
// здесь проверяем саму отрисовку: строк нет, пока список не открыт, и появляются при открытии.
// BASE=8099 — новый код; BASE=8098 — негативный контроль (app.js из git).
const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const N = 200;
const j = await (await fetch('http://127.0.0.1:9223/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(j.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const send = (m, p) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); const d = r.result;
  if (d && d.exceptionDetails) return 'ERR ' + d.exceptionDetails.exception.description.split('\n')[0];
  return d && d.result ? d.result.value : undefined; };
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
const apps = [];
for (let i = 0; i < N; i++) apps.push({ packageName: 'pkg' + i, label: 'App ' + i, versionName: '1.0', versionCode: 1, enabled: true, suspended: false });
const stub = `(function(){
  var apps = ${JSON.stringify(apps)};
  window.WebToApk = {
    getInstalledApps: function(){ return JSON.stringify(apps); },
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
    var url = String(d.url||''), body = {};
    if (/overallInfo\\/([^/?]+)/.test(url)) { var p = RegExp.$1;
      body = { code:'OK', body:{ packageName:p, appName:'App '+p, versionName:'2.0', versionCode:2, iconUrl:'', signature:'sig' } }; }
    else if (/showcase\\/sections/.test(url)) body = { code:'OK', body:{ elements:[] } };
    else if (/popular\\/apps/.test(url)) body = { apps: [] };
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:200, responseText: JSON.stringify(body) }); }, 5);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 6000));

const rows = () => ev(`document.querySelectorAll('.iact').length`);          // кнопки строк «Установленных»
const nodes = () => ev(`document.querySelectorAll('#root *').length`);
const clickSeg = (l) => ev(`(function(){ var b=Array.prototype.filter.call(document.querySelectorAll('.segbtn'),function(e){return e.textContent===${JSON.stringify(l)};}); if(!b.length) return 'НЕТ'; b[0].click(); return 'ok'; })()`);

console.log(`в списке ${N} установленных приложений`);
console.log('старт (открыт под-таб «Обновления»):');
const r0 = await rows(), n0 = await nodes();
console.log('  строк «Установленных» в DOM:', r0, r0 === 0 ? 'OK (не строим скрытое)' : 'ПРОВАЛ (построены впустую)');
// сравниваем с состоянием «список открыт» ниже: разница — это и есть сэкономленные узлы
console.log('  узлов в #root:', n0, '(в списке обновлений их всё равно много — важно, что нет ~1800 узлов «Установленных»)');

console.log('\nоткрываю «Установленные»:', await clickSeg('Установленные'));
await new Promise(r => setTimeout(r, 300));
const r1 = await rows(), n1 = await nodes();
console.log('  строк «Установленных» в DOM:', r1, r1 === N ? 'OK (построены по требованию)' : 'ПРОВАЛ');
console.log('  узлов в #root:', n1, '| прирост от списка:', n1 - n0, n1 > n0 + 1000 ? 'OK (лениво — строим только по требованию)' : 'ПРОВАЛ');

console.log('\nвозвращаюсь на «Обновления»:', await clickSeg('Обновления'));
await new Promise(r => setTimeout(r, 300));
const r2 = await rows();
console.log('  строк «Установленных» в DOM:', r2, r2 === 0 ? 'OK (снова убраны)' : 'ПРОВАЛ');
console.log('  узлов в #root:', await nodes());
ws.close();

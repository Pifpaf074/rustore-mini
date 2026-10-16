// Утверждение из ревью: рендер «Установленных» синхронно дёргает нативный мост иконки на
// каждую строку (в нативе это декод drawable + отрисовка в 96×96 + PNG + base64), а кэш
// иконок растёт бесконечно. Проверяем: (1) список рисуется сразу с буквами-заглушками,
// иконки приезжают порциями и не блокируют первый рендер; (2) иконка не перезапрашивается,
// пока версия пакета не сменилась, и старые версии не копятся.
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
  window.__iconCalls = [];
  var B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  var apps = [];
  for (var i = 0; i < 60; i++) apps.push({ packageName:'com.t'+i, label:'App '+i, versionName:'1.0', versionCode:1, enabled:true, suspended:false });
  window.__bump = function(pkg){ for (var i=0;i<apps.length;i++) if (apps[i].packageName===pkg) { apps[i].versionName='2.0'; apps[i].versionCode=2; } };
  window.WebToApk = {
    getInstalledApps: function(){ return JSON.stringify(apps); },
    getInstalledVersion: function(){ return 1; }, getInstalledSigner: function(){ return ''; },
    isPackageInstalled: function(){ return true; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.mine.webtoapk',versionCode:26,versionName:'2.9.7'}); },
    getDeviceInfo: function(){ return '{}'; },
    hailAvailable: function(){ return false; }, hailAction: function(){ return false; },
    getAppIcon: function(pkg){ window.__iconCalls.push(pkg); return B64; },
    installApk: function(){}, openAppInfo: function(){}, launchApp: function(){ return true; },
    openExternal: function(){}, clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''), body = null;
    if (/showcase\\/sections/.test(url)) body = { code:'OK', body:{ elements:[] } };
    else if (/popular\\/apps/.test(url)) body = { apps: [] };
    else if (/applicationData\\/apps/.test(url)) body = { code:'OK', body:{ content:[] } };
    else if (/overallInfo\\/([^/?]+)/.test(url)) body = { code:'OK', body:{ packageName:RegExp.$1, appName:'App', versionName:'1.0', versionCode:1 } };
    else if (/version\\.json/.test(url)) body = { versionCode:0 };
    else body = {};
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:200, responseText: JSON.stringify(body) }); }, 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 6000));

const clickSeg = (label) => ev(`(function(){ var b=Array.prototype.filter.call(document.querySelectorAll('.segbtn'),function(e){return e.textContent===${JSON.stringify(label)};}); if(!b.length) return 'НЕТ'; b[0].click(); return 'ok'; })()`);
const calls = () => ev(`(window.__iconCalls||[]).length`);
const ph = () => ev(`document.querySelectorAll('.sub .ric.ph').length`);
const withIcon = () => ev(`document.querySelectorAll('.sub img.ric').length`);

console.log('1) старт (открыт список обновлений, «Установленные» не показаны):');
console.log('   вызовов getAppIcon:', await calls(), (await calls()) === 0 ? 'OK (лениво, ничего не грузим)' : 'ПРОВАЛ');
console.log('2) открываю «Установленные»:', await clickSeg('Установленные'));
const c0 = await calls();
console.log('   сразу после рендера — вызовов:', c0, c0 <= 8 ? 'OK (рендер не блокируется: порция за тик)' : 'ПРОВАЛ (синхронный залп)');
await new Promise(r => setTimeout(r, 40));
const c1 = await calls(), ph1 = await ph();
console.log('   через 40 мс — вызовов:', c1, '| заглушек:', ph1, (c1 < 60 && ph1 > 0) ? 'OK (список уже нарисован, иконки догоняют порциями)' : 'ПРОВАЛ (залп или пустой список)');
console.log('   строк-заглушек:', await ph(), '| строк с иконкой:', await withIcon(), '(всего 60)');
await new Promise(r => setTimeout(r, 3000));
const c2 = await calls(), wi = await withIcon(), ph2 = await ph();
console.log('3) через 3 с — вызовов:', c2, '| с иконкой:', wi, '| заглушек:', ph2,
  (c2 === 60 && wi === 60 && ph2 === 0) ? 'OK (все иконки приехали)' : 'ПРОВАЛ');

console.log('4) обновился один пакет (com.t7 → 2.0), pull-to-refresh списка:');
console.log('   bump:', await ev(`(function(){ window.__bump('com.t7'); return 'ok'; })()`));
console.log('   __refreshCurrent:', await ev(`(function(){ if (typeof window.__refreshCurrent!=='function') return 'НЕТ'; window.__refreshCurrent(); return 'ok'; })()`));
await new Promise(r => setTimeout(r, 2000));
const c3 = await calls();
console.log('   вызовов всего:', c3, c3 === 61 ? 'OK (61 = 60 + только изменившийся пакет; кэш переиспользован)' : 'ПРОВАЛ (ожидали 61)');
const cs = JSON.parse((await ev(`JSON.stringify(window.__cacheStats ? window.__cacheStats() : null)`)) || '{}');
console.log('   кэши:', JSON.stringify(cs), cs.icons === 60 ? 'OK (иконок ровно 60 — иконка старой версии выброшена, кэш не копится)' : 'ПРОВАЛ (иконок ' + cs.icons + ')');
console.log('   последний вызов:', await ev(`(window.__iconCalls||[]).slice(-1)[0]`), '(ожидали com.t7)');
console.log('   с иконкой:', await withIcon(), '| заглушек:', await ph());
console.log('   все вызовы:', await ev(`JSON.stringify((window.__iconCalls||[]).slice(0,3))`), '…');
ws.close();

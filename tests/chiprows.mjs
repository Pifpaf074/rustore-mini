// Утверждение из ревью: CHIP/ROW в DETAILBODY вызываются без window.ID, поэтому при
// смене числа чипов/строк движок перепутает инстансы или пересоздаст DOM.
// Проверяем напрямую: карточка A (4 чипа, 4 строки, скриншоты, «что нового») →
// карточка B (1 чип, 3 строки, без скриншотов) → снова A. Значения должны быть
// ровно своими (никаких остатков от предыдущей карточки).
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
  var NAMES = { pkga:'APP-pkga', pkgb:'APP-pkgb' };
  var INFO = {
    pkga: { packageName:'pkga', appName:'APP-pkga', versionName:'1.2.3', versionCode:12, fileSize:13107200,
            minSdkVersion:26, downloads:1234, appVerUpdatedAt:'2026-01-02T00:00:00Z',
            shortDescription:'Описание A', whatsNew:'Что нового A',
            fileUrls:[ {type:'SCREENSHOT',ordinal:0,fileUrl:'http://127.0.0.1:8099/a0.png'},
                       {type:'SCREENSHOT',ordinal:1,fileUrl:'http://127.0.0.1:8099/a1.png'} ] },
    pkgb: { packageName:'pkgb', appName:'APP-pkgb', versionName:'9.9', versionCode:99,
            shortDescription:'Описание B', fileUrls:[] }
  };
  window.WebToApk = {
    getInstalledApps: function(){ return '[]'; }, getInstalledVersion: function(){ return 0; },
    getInstalledSigner: function(){ return ''; }, isPackageInstalled: function(){ return false; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.test',versionCode:1}); },
    getDeviceInfo: function(){ return '{}'; },
    hailAvailable: function(){ return false; }, hailAction: function(){ return false; },
    getAppIcon: function(){ return ''; }, installApk: function(){},
    openAppInfo: function(){}, launchApp: function(){ return true; },
    openExternal: function(){}, clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){},
    httpRequest: function(){}, httpAbort: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''), status = 200, body = null;
    if (/showcase\\/sections/.test(url)) {
      body = { code:'OK', body:{ elements:[ { selection:{ id:'s1', title:{ value:'Подборка' },
        content:{ appInfo:[ {packageName:'pkga',type:'APP'}, {packageName:'pkgb',type:'APP'} ] } } } ] } };
    } else if (/popular\\/apps/.test(url)) { body = { apps: [] }; }
    else if (/applicationData\\/apps/.test(url)) {
      var q = decodeURIComponent((url.match(/query=([^&]*)/)||[])[1]||'');
      body = { code:'OK', body:{ content:[ { packageName:q, appId:1, appName:NAMES[q]||q, iconUrl:'', averageUserRating:4.1, versionCode:1 } ] } };
    } else if (/overallInfo/.test(url)) {
      var p = decodeURIComponent((url.match(/overallInfo\\/([^?]+)/)||[])[1]||'');
      body = { code:'OK', body: INFO[p] || { packageName:p, appName:NAMES[p]||p, versionCode:1 } };
    } else if (/download-link/.test(url)) { body = { downloadUrls:[ { url:'http://127.0.0.1:8099/x.apk', size:10 } ] }; }
    else if (/version\\.json/.test(url)) { body = { versionCode:0 }; }
    setTimeout(function(){ if (typeof d.onload === 'function') d.onload({ status:status, responseText: JSON.stringify(body||{}) }); }, 10);
    return { abort: function(){} };
  };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: BASE + '/index.html' });
await new Promise(r => setTimeout(r, 6000));

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const clickTab = (label) => ev(`(function(){ var t=Array.prototype.filter.call(document.querySelectorAll('.tab'),function(e){return e.textContent===${JSON.stringify(label)};}); if(!t.length) return 'НЕТ ТАБА'; t[0].click(); return 'ok'; })()`);
const clickTile = (name) => ev(`(function(){ var t=Array.prototype.filter.call(document.querySelectorAll('.tile'),function(e){ var n=e.querySelector('.tname'); return n && n.textContent===${JSON.stringify(name)}; }); if(!t.length) return 'НЕТ ПЛИТКИ'; t[0].click(); return 'ok'; })()`);
const closeCard = () => ev(`(function(){ var b=document.querySelector('.detail .ibtn'); if(!b) return 'НЕТ'; b.click(); return 'ok'; })()`);
const snap = async () => {
  const raw = await ev(`JSON.stringify({
    chips: Array.prototype.map.call(document.querySelectorAll('.detail .chip'), function(e){ return e.textContent; }),
    rows: Array.prototype.map.call(document.querySelectorAll('.detail .row'), function(e){ return [e.querySelector('.rk').textContent, e.querySelector('.rv').textContent]; }),
    shots: document.querySelectorAll('.detail .shots img').length,
    sections: Array.prototype.map.call(document.querySelectorAll('.detail .sechead'), function(e){ return e.textContent; })
  })`);
  const o = JSON.parse(raw || '{}');
  return { chips: (o.chips||[]).map(norm), rows: (o.rows||[]).map(r => [norm(r[0]), norm(r[1])]), shots: o.shots, sections: (o.sections||[]).map(norm) };
};

await clickTab('Приложения');
await new Promise(r => setTimeout(r, 2000));
const results = {};
for (const pass of ['A1', 'B', 'A2']) {
  const who = pass === 'B' ? 'APP-pkgb' : 'APP-pkga';
  await clickTile(who);
  await new Promise(r => setTimeout(r, 2500));
  results[pass] = await snap();
  await closeCard();
  await new Promise(r => setTimeout(r, 800));
}

const expect = {
  A1: { chips: ['v1.2.3', '12.5 МБ', 'Android 26+', '1 234 загрузок'],
        rows: [['Пакет','pkga'],['Версия','1.2.3 (12)'],['Обновлено','02.01.2026'],['Размер','12.5 МБ']],
        shots: 2, sections: ['Что нового'] },
  B:  { chips: ['v9.9'],
        rows: [['Пакет','pkgb'],['Версия','9.9 (99)'],['Обновлено','—']],
        shots: 0, sections: [] },
  A2: null  // должен совпасть с A1
};
expect.A2 = expect.A1;

let bad = 0;
for (const pass of ['A1', 'B', 'A2']) {
  const got = results[pass], exp = expect[pass];
  const okChips = JSON.stringify(got.chips) === JSON.stringify(exp.chips);
  const okRows = JSON.stringify(got.rows) === JSON.stringify(exp.rows);
  const okShots = got.shots === exp.shots;
  const okSec = JSON.stringify(got.sections) === JSON.stringify(exp.sections);
  const ok = okChips && okRows && okShots && okSec;
  if (!ok) bad++;
  console.log(`${pass}: ${ok ? 'OK' : 'ПРОВАЛ'}`);
  console.log('   чипы :', JSON.stringify(got.chips), okChips ? '' : '← ждали ' + JSON.stringify(exp.chips));
  console.log('   строки:', JSON.stringify(got.rows), okRows ? '' : '← ждали ' + JSON.stringify(exp.rows));
  console.log('   скриншотов:', got.shots, '(ждали ' + exp.shots + ') | заголовки:', JSON.stringify(got.sections));
}
console.log(bad === 0 ? 'ИТОГ: OK (инстансы не смешиваются)' : 'ИТОГ: ПРОВАЛ (' + bad + ' из 3)');
ws.close();

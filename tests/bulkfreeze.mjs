// «Обновить все» держит свой ключ '#all' в rowBusy: иначе «слот установки» на мгновение
// освобождался (runInstall в finally сначала снимает busy, и только потом ждёт 1.2 с до
// повторной заморозки) — и запущенная в это окно установка из карточки молча съедала
// следующий пункт списка, а в конце всё равно показывалось «Готово».
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
  window.__hail = []; window.__installs = []; window.__done = []; window.__ver = {pkga:1, pkgb:1};
  function list(){ return ['pkga','pkgb'].map(function(p){ return {packageName:p,label:p.toUpperCase(),versionName:'1.0',versionCode:window.__ver[p],enabled:false,suspended:false}; }); }
  window.WebToApk = {
    getInstalledApps: function(){ return JSON.stringify(list()); },
    getInstalledVersion: function(p){ return window.__ver[p]||0; }, getInstalledSigner: function(){ return 'sig'; },
    isPackageInstalled: function(p){ return !!window.__ver[p]; },
    getAppInfo: function(){ return JSON.stringify({packageName:'com.mine.webtoapk'}); },
    getDeviceInfo: function(){ return '{}'; },
    hailAvailable: function(){ return true; },
    hailAction: function(action, pkg){ window.__hail.push(action + ' ' + pkg); return true; },
    getAppIcon: function(){ return ''; },
    installApk: function(s){
      var o = JSON.parse(s); window.__installs.push(o.name);
      var pkg = o.name.split('-')[0];
      setTimeout(function(){ window.__ver[pkg] = 2; window.__done.push(pkg); window.__webtoapkEvent('apk', {phase:'installed'}); }, 200);
    },
    openAppInfo: function(){}, launchApp: function(){ return true; }, openExternal: function(){},
    clearAppCache: function(){}, hasNotificationPermission: function(){ return false; },
    requestNotificationPermission: function(){}, share: function(){},
    setPullToRefreshRefreshing: function(){}, setPullToRefreshEnabled: function(){}
  };
  window.GM_xmlhttpRequest = function(d){
    var url = String(d.url||''), body = {};
    if (/overallInfo\\/([^/?]+)/.test(url)) { var p = RegExp.$1;
      body = { code:'OK', body:{ packageName:p, appName:p.toUpperCase(), versionName:'2.0', versionCode:2, iconUrl:'', signature:'sig',
        shortDescription:'Описание', whatsNew:'', fileUrls:[], screenshots:[] } }; }
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
await new Promise(r => setTimeout(r, 7000));
if ((await ev(`typeof window.__hail`)) !== 'object') { console.log('СТАБ НЕ УСТАНОВИЛСЯ — тест недействителен'); process.exit(1); }

const ev2 = async (x) => JSON.parse(await ev('JSON.stringify(' + x + ')'));
const rows = () => ev(`[].slice.call(document.querySelectorAll('.rcard')).length`);
const openCard = (i) => ev(`(function(){ var p=document.querySelector('.updbar').parentNode; var rows=[].slice.call(p.querySelectorAll('.rcard'));
  if(!rows[${i}]) return 'НЕТ СТРОКИ'; rows[${i}].click(); return 'ok'; })()`);
const cardState = () => ev2(`(function(){ var b=document.querySelector('.dacts button.primary'); return b ? { text: b.textContent, disabled: b.disabled } : null; })()`);
const clickBulk = () => ev(`(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ return x.textContent.trim()==='Обновить все'; })[0];
  if(!b) return 'НЕТ КНОПКИ'; b.click(); return 'ok'; })()`);
const clickCard = () => ev(`(function(){ var b=document.querySelector('.dacts button.primary'); if(!b) return 'НЕТ'; b.click(); return 'ok'; })()`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('строк обновлений:', await rows());
console.log('открываю карточку pkgb (её ещё не обновляли):', await openCard(1));
await sleep(2000);
console.log('  кнопка в карточке:', JSON.stringify(await cardState()));
console.log('запускаю «Обновить все»:', await clickBulk());

// Ждём события installed первого пакета, а дальше следим за всем пост-инсталляционным
// периодом: он включает и последние 0.7 с, пока ключ пакета ещё стоит, и окно 1.2 с перед
// повторной заморозкой — именно там слот на старом коде освобождался.
for (let k = 0; k < 300; k++) { await sleep(50); if ((await ev2('window.__done')).length >= 1) break; }
const done = await ev2('window.__done');
if (!done.length) { console.log('УСТАНОВКА НЕ ПОШЛА'); ws.close(); process.exit(1); }
console.log('первый пакет установлен (' + done[0] + '), hail:', JSON.stringify(await ev2('window.__hail')));

let samples = 0, freeSamples = 0, clicked = false, addAfterClick = null, atClick = null;
const t0 = Date.now();
while (Date.now() - t0 < 2600) {
  await sleep(50);
  const st = await ev2('({ busy: installBusy(), all: installBusy("#all"), card: (function(){ var b=document.querySelector(".dacts button.primary"); return b ? {text:b.textContent, disabled:b.disabled} : null; })() })');
  samples++;
  if (st.busy === false) freeSamples++;
  if (!clicked && Date.now() - t0 > 900) {
    clicked = true; atClick = st;
    console.log('  на +0.9 с: installBusy()=' + st.busy + ", installBusy('#all')=" + st.all + ', карточка ' + JSON.stringify(st.card));
    console.log('  жму кнопку в карточке:', await clickCard());
    // Считаем не установки (второй пункт массового и сам начнёт ставиться), а порядок:
    // влезшая установка размораживает свой пакет ДО того, как цикл заморозил предыдущий.
    await sleep(1200);
    const h2 = await ev2('window.__hail');
    const iB = h2.indexOf('UNFREEZE pkgb'), iF = h2.indexOf('FREEZE pkga');
    addAfterClick = (iB >= 0 && iF >= 0 && iB < iF) ? 1 : 0;
    console.log('  hail после клика:', JSON.stringify(h2));
  }
}
console.log('замеров за пост-инсталляционный период:', samples, '| из них слот свободен:', freeSamples,
  freeSamples === 0 ? 'OK (слот не освобождался)' : 'ПРОВАЛ (слот был свободен ' + freeSamples + ' раз)');
console.log('в момент клика: installBusy()=' + atClick.busy + ", installBusy('#all')=" + atClick.all,
  (atClick.busy === true && atClick.all === false) ? 'OK (занято, но массовое продолжает)' : 'ПРОВАЛ');
console.log('клик из карточки влез в цикл (UNFREEZE pkgb раньше FREEZE pkga):', addAfterClick ? 'ПРОВАЛ (да)' : 'OK (нет)');

for (let k = 0; k < 300; k++) { await sleep(100); if ((await ev2('window.__installs')).length >= 2 && (await ev2('window.__hail')).filter(x => /^FREEZE/.test(x)).length >= 2) break; }
const fin = await ev2('({ inst: window.__installs, hail: window.__hail, busy: installBusy() })');
console.log('итог: установок', JSON.stringify(fin.inst));
console.log('      hail', JSON.stringify(fin.hail));
console.log('      installBusy() в конце:', fin.busy, fin.busy === false ? 'OK' : 'ПРОВАЛ (ключ остался)');
console.log('      оба обновлены и заморожены обратно:',
  fin.inst.length === 2 && fin.hail.filter(x => /^UNFREEZE/.test(x)).length === 2 && fin.hail.filter(x => /^FREEZE/.test(x)).length === 2 ? 'OK' : 'ПРОВАЛ');
// Массовое обновление идёт строго по одному пакету: UNFREEZE A, FREEZE A, UNFREEZE B, FREEZE B.
// Влезшая в окно установка перемешивает пары (и следующий пункт цикла тихо выпадает).
const seq = fin.hail.map(x => x.split(' ')[0] + ' ' + x.split(' ')[1]);
const paired = seq.length === 4 && seq[0] === 'UNFREEZE pkga' && seq[1] === 'FREEZE pkga' && seq[2] === 'UNFREEZE pkgb' && seq[3] === 'FREEZE pkgb';
console.log('      порядок разморозка/заморозка строго по одному пакету:', paired ? 'OK' : 'ПРОВАЛ (' + JSON.stringify(seq) + ')');
ws.close();

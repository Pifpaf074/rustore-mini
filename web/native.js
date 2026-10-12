// native.js — тонкий шим: window.Native -> window.WebToApk (мосты обёртки).
//
// Специфичные для RuStore мосты (установка APK, список пакетов, signer, Hail)
// живут только в нативном слое нашего форка и вызываются исключительно отсюда,
// поэтому app.js не зависит от имён нативных методов.
//
// Контракт установки: installApk({url,size,signer,name,onProgress,onPending})
//   -> Promise, который резолвится фазой 'installed' и реджектится фазой 'error'.
(function () {
  var BT = window.WebToApk;
  if (!BT) { window.Native = window.Native || {}; return; }

  function parse(s, fallback) { try { return JSON.parse(s); } catch (e) { return fallback; } }

  // Колбэки активной установки. Фазы приходят из натива событием 'apk'.
  var pending = null;

  window.__webtoapkEvent = function (name, data) {
    if (name !== 'apk' || !pending) return;
    var cb = pending, phase = data && data.phase;
    if (phase === 'progress') { if (cb.onProgress) cb.onProgress(Number(data.got) || 0, Number(data.total) || 0); return; }
    if (phase === 'permission' || phase === 'pending') { if (cb.onPending) cb.onPending(phase); return; }
    if (phase === 'installed') { pending = null; cb.resolve({ installed: true }); return; }
    if (phase === 'error') { pending = null; cb.reject(new Error((data && data.message) || 'ошибка установки')); return; }
    // 'confirm' / 'done' — ждём installed либо error (done с session:false = провал сессии).
    if (phase === 'done' && data.session === false) { pending = null; cb.resolve({ installed: false }); }
  };

  window.Native = {
    // --- установка APK ---
    installApk: function (opts) {
      return new Promise(function (resolve, reject) {
        pending = { resolve: resolve, reject: reject, onProgress: opts.onProgress, onPending: opts.onPending };
        try {
          BT.installApk(JSON.stringify({ url: opts.url, size: opts.size, signer: opts.signer, name: opts.name }));
        } catch (e) { pending = null; reject(e); }
      });
    },
    // --- установленные пакеты ---
    installedApps: function () { return parse(BT.getInstalledApps(), []); },
    isInstalled: function (pkg) { return BT.isPackageInstalled(pkg); },
    installedVersion: function (pkg) { return Number(BT.getInstalledVersion(pkg)); },
    installedSigner: function (pkg) { return BT.getInstalledSigner(pkg); },
    appIcon: function (pkg) {
      try { var b = BT.getAppIcon(pkg); return b ? ('data:image/png;base64,' + b) : ''; } catch (e) { return ''; }
    },
    openAppInfo: function (pkg) { BT.openAppInfo(pkg); },
    launchApp: function (pkg) { return BT.launchApp(pkg); },
    appInfo: function () { return parse(BT.getAppInfo(), {}); },
    deviceInfo: function () { return parse(BT.getDeviceInfo(), {}); },
    // --- Hail (freeze-менеджер) ---
    hailAvailable: function () { return BT.hailAvailable(); },
    hail: function (action, pkg) { return BT.hailAction(action, pkg); },
    // --- системное ---
    systemTheme: function () { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; },
    openExternal: function (url) { BT.openExternal(url); },
    clearCache: function () { if (BT.clearAppCache) BT.clearAppCache(); },
    hasNotifications: function () { return BT.hasNotificationPermission(); },
    requestNotifications: function () { if (BT.requestNotificationPermission) BT.requestNotificationPermission(); },
    // --- HTTP в обход CORS (для version.json на своём сервере) ---
    httpGet: function (url) { try { return BT.httpGet(url) || ''; } catch (e) { return ''; } }
  };
})();

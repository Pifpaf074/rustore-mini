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

  // Системные коды установки -> человеческий текст. Иначе в тосте видно
  // "INSTALL_FAILED_DEPRECATED_SDK_VERSION: App package must target at least SDK...".
  var INSTALL_ERRORS = {
    INSTALL_FAILED_DEPRECATED_SDK_VERSION: 'приложение слишком старое для этой версии Android',
    INSTALL_FAILED_OLDER_SDK: 'приложение слишком старое для этой версии Android',
    INSTALL_FAILED_UPDATE_INCOMPATIBLE: 'подпись не совпадает с установленным приложением',
    INSTALL_FAILED_ALREADY_EXISTS: 'приложение уже установлено',
    INSTALL_FAILED_VERSION_DOWNGRADE: 'на телефоне уже более новая версия',
    INSTALL_FAILED_INSUFFICIENT_STORAGE: 'не хватает свободного места',
    INSTALL_FAILED_NO_MATCHING_ABIS: 'APK не подходит процессору телефона',
    INSTALL_FAILED_USER_RESTRICTED: 'система запретила установку (разрешить неизвестные источники?)',
    INSTALL_FAILED_INVALID_APK: 'файл APK повреждён',
    INSTALL_FAILED_INVALID_URI: 'файл APK не найден',
    INSTALL_FAILED_ABORTED: 'установка отменена',
    INSTALL_PARSE_FAILED_NOT_APK: 'RuStore отдал не APK',
    INSTALL_PARSE_FAILED_NO_CERTIFICATES: 'в APK нет подписи',
    INSTALL_PARSE_FAILED_UNEXPECTED_EXCEPTION: 'не удалось разобрать APK',
    STATUS_FAILURE_ABORTED: 'установка отменена',
    STATUS_FAILURE_BLOCKED: 'установку заблокировала система',
    STATUS_FAILURE_CONFLICT: 'конфликт с установленным приложением',
    STATUS_FAILURE_STORAGE: 'не хватает свободного места',
    STATUS_FAILURE_INCOMPATIBLE: 'несовместимо с этой версией Android',
    STATUS_FAILURE_INVALID: 'некорректный APK'
  };
  function installError(msg) {
    var s = String(msg || '');
    for (var k in INSTALL_ERRORS) { if (s.indexOf(k) >= 0) return INSTALL_ERRORS[k]; }
    return s || 'не удалось установить';
  }

  // Колбэки активной установки. Фазы приходят из натива событием 'apk'.
  var pending = null;

  window.__webtoapkEvent = function (name, data) {
    if (name !== 'apk' || !pending) return;
    var cb = pending, phase = data && data.phase;
    if (phase === 'progress') { if (cb.onProgress) cb.onProgress(Number(data.got) || 0, Number(data.total) || 0); return; }
    if (phase === 'permission' || phase === 'pending') { if (cb.onPending) cb.onPending(phase); return; }
    if (phase === 'installed') { pending = null; cb.resolve({ installed: true }); return; }
    if (phase === 'error') { pending = null; cb.reject(new Error(installError(data && data.message))); return; }
    // 'confirm' / 'done' — ждём installed либо error (done с session:false = провал сессии).
    if (phase === 'done' && data.session === false) { pending = null; cb.resolve({ installed: false }); }
  };

  // --- pull-to-refresh ---
  // Натив (SwipeRefreshLayout) спрашивает страницу через WebToApk.onPullToRefresh.
  // Вернуть true = страница сама обновляет контент (иначе натив перезагрузит страницу).
  // Наш обработчик — window.__refreshCurrent (см. app.js).
  BT.onPullToRefresh = function () {
    try { if (window.__refreshCurrent) window.__refreshCurrent(); } catch (e) {}
    setTimeout(function () { try { BT.setPullToRefreshRefreshing(false); } catch (e) {} }, 700);
    return true;
  };
  // Свои скроллеры (оверлей карточки) натив не видит: SwipeRefreshLayout смотрит только
  // скролл самого WebView. Поэтому страница сама говорит, можно ли тянуть вниз.
  function setPtrEnabled(on) { try { if (BT.setPullToRefreshEnabled) BT.setPullToRefreshEnabled(!!on); } catch (e) {} }
  window.__ptrSync = function (scrolled) { setPtrEnabled(!scrolled); };

  window.Native = {
    // --- pull-to-refresh (управление из app.js) ---
    setPtrEnabled: setPtrEnabled,
    // --- установка APK ---
    installApk: function (opts) {
      return new Promise(function (resolve, reject) {
        // Натив держит один слот ожидания: вторая установка перебила бы первую
        // и её промис завис бы навсегда.
        if (pending) { reject(new Error('другая установка ещё идёт')); return; }
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
    requestNotifications: function () { if (BT.requestNotificationPermission) BT.requestNotificationPermission(); }
    // HTTP-мост не нужен: GM_xmlhttpRequest из helpers.js (cookie-less, без CORS)
    // заменяет и наш бывший httpGet, и нативный прокси overallInfo.
  };
})();

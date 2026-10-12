package com.myexample.webtoapk;

import android.app.Activity;
import android.app.DownloadManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.util.Log;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * RuStore-расширение (наш форк, не апстрим).
 *
 * Загрузка APK через системный DownloadManager (переживает сворачивание/убийство
 * процесса) + установка через PackageInstaller-сессию с реальным колбэком статуса,
 * плюс запросы о пакетах (вкладка «Обновления») и мост Hail.
 *
 * Прогресс/результат установки приходят в JS событием 'apk'
 * (window.__webtoapkEvent('apk', {...})):
 *   {"phase":"progress","got":N,"total":M}
 *   {"phase":"permission"} | {"phase":"pending"} | {"phase":"done","session":true|false}
 *   {"phase":"confirm"} | {"phase":"installed"} | {"phase":"error","message":"..."}
 */
public final class ApkInstaller {
    private static final String TAG = "WebToApk";
    private static final int BUF = 1 << 16;

    // WebView текущей операции — чтобы доставить результат установки из
    // InstallResultReceiver (у него нет своей ссылки на страницу).
    private static WeakReference<WebView> sWebview;

    // Отложенная установка: разрешение «неизвестные источники» выдаётся в настройках.
    // APK уже скачан — докачивать не надо, коммитим при возврате в foreground.
    private static File sPendingApk;
    private static WeakReference<Activity> sPendingActivity;
    private static WeakReference<WebView> sPendingWebview;

    private ApkInstaller() {}

    // ---------------------------------------------------------------- install

    /** Скачать APK (DownloadManager) и установить.
     *  opts (JSON): {url, size?, signer?, name?}. Прогресс/фазы — событием 'apk'. */
    public static void install(final Activity activity, final WebView webview, final String optsJson) {
        new Thread(() -> {
            File apk = null;
            long dlId = -1;
            DownloadManager dm = null;
            try {
                JSONObject o = new JSONObject(optsJson == null || optsJson.isEmpty() ? "{}" : optsJson);
                String url = o.getString("url");
                String signer = opt(o, "signer");
                String name = o.optString("name", "app.apk");
                if (!name.endsWith(".apk")) name += ".apk";
                // Уникальное имя, чтобы не пересекаться с прошлыми загрузками
                name = "rs" + System.currentTimeMillis() + "-" + name;

                dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm == null) throw new Exception("no DownloadManager");

                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setMimeType("application/vnd.android.package-archive");
                req.setTitle(name);
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
                req.setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, name);
                dlId = dm.enqueue(req);

                long total = o.optLong("size", -1);
                while (true) {
                    Thread.sleep(400);
                    DownloadManager.Query q = new DownloadManager.Query().setFilterById(dlId);
                    int status = -1;
                    long got = 0, tot = 0;
                    try (Cursor c = dm.query(q)) {
                        if (c != null && c.moveToFirst()) {
                            status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                            got = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                            tot = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                        }
                    }
                    if (tot > 0) total = tot;
                    JSONObject p = phase("progress");
                    p.put("got", got);
                    p.put("total", total);
                    emit(webview, p);
                    if (status == DownloadManager.STATUS_SUCCESSFUL) break;
                    if (status == DownloadManager.STATUS_FAILED) throw new Exception("download failed");
                }

                File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                File downloaded = new File(dir, name);
                if (!downloaded.exists()) throw new Exception("download missing: " + name);

                if (signer != null) {
                    List<String> actual = signersSha256(activity, downloaded.getAbsolutePath());
                    boolean ok = false;
                    for (String s : actual) if (s.equalsIgnoreCase(signer)) { ok = true; break; }
                    if (!ok) throw new Exception("signer mismatch: " + actual);
                }

                // Копируем в кэш и убираем загрузку из DownloadManager (чтобы отложенная
                // установка не зависела от его файла и пропала нотификация).
                apk = new File(activity.getCacheDir(), "install-" + System.currentTimeMillis() + ".apk");
                try (InputStream in = new FileInputStream(downloaded);
                     OutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[BUF];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                try { dm.remove(dlId); } catch (Exception ignored) {}
                downloaded.delete();

                sWebview = new WeakReference<>(webview);
                boolean session = commitSession(activity, webview, apk);
                JSONObject d = phase("done");
                d.put("session", session);
                emit(webview, d);
                if (!session) launchInstaller(activity, apk);
            } catch (Exception e) {
                Log.e(TAG, "install failed", e);
                if (apk != null && !apk.equals(sPendingApk)) apk.delete();
                if (dm != null && dlId >= 0) { try { dm.remove(dlId); } catch (Exception ignored) {} }
                JSONObject err = phase("error");
                try { err.put("message", String.valueOf(e.getMessage())); } catch (Exception ignored) {}
                emit(webview, err);
            }
        }, "apk-installer").start();
    }

    private static void launchInstaller(Activity a, File apk) {
        try {
            Uri uri = Uri.fromFile(apk);
            Intent install = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            a.startActivity(install);
        } catch (Exception e) {
            Log.e(TAG, "launchInstaller failed", e);
        }
    }

    /**
     * Установка через PackageInstaller-сессию: копируем APK в сессию и получаем
     * колбэк статуса (успех/отмена/ошибка).
     * true - обработано (или ждём разрешения/возврата в foreground);
     * false - вызывающий откатится на ACTION_VIEW.
     */
    private static boolean commitSession(Activity a, WebView webview, File apk) {
        boolean needPerm = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !a.getPackageManager().canRequestPackageInstalls();
        if (needPerm) {
            // Даже экран настроек нельзя открыть из фона — при свёрнутом приложении откладываем.
            sPendingApk = apk;
            sPendingActivity = new WeakReference<>(a);
            sPendingWebview = new WeakReference<>(webview);
            emit(webview, phase("permission"));
            if (MainActivity.sVisible) {
                Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + a.getPackageName()));
                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                a.startActivity(settings);
            }
            return true;
        }
        // Свёрнуто → Android блокирует запуск CONFIRM_INSTALL из фона
        // (Background activity launch blocked): диалог не появится, установка «зависнет».
        // Откладываем коммит до возврата в foreground (retryPending из onResume).
        if (!MainActivity.sVisible) {
            sPendingApk = apk;
            sPendingActivity = new WeakReference<>(a);
            sPendingWebview = new WeakReference<>(webview);
            emit(webview, phase("pending"));
            return true;
        }
        sPendingApk = null;
        try {
            PackageInstaller pi = a.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params =
                    new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setSize(apk.length());
            int id = pi.createSession(params);
            try (PackageInstaller.Session session = pi.openSession(id)) {
                try (OutputStream out = session.openWrite("base.apk", 0, apk.length());
                     FileInputStream in = new FileInputStream(apk)) {
                    byte[] buf = new byte[BUF];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    session.fsync(out);
                }
                Intent result = new Intent(a, InstallResultReceiver.class);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    flags |= PendingIntent.FLAG_MUTABLE; // системе нужно доложить extras
                }
                PendingIntent pending = PendingIntent.getBroadcast(a, id, result, flags);
                session.commit(pending.getIntentSender());
            }
            apk.delete();
            return true;
        } catch (Exception e) {
            Log.e(TAG, "PackageInstaller session failed, fallback to ACTION_VIEW", e);
            return false;
        }
    }

    /** Продолжить отложенную установку после выдачи разрешения / возврата в foreground. */
    public static void retryPending(Activity a, WebView webview) {
        final File apk = sPendingApk;
        if (apk == null || !apk.exists()) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !a.getPackageManager().canRequestPackageInstalls()) return;
        sPendingApk = null;
        final Activity act = (sPendingActivity != null && sPendingActivity.get() != null)
                ? sPendingActivity.get() : a;
        final WebView wv = webview != null ? webview
                : (sPendingWebview != null ? sPendingWebview.get() : null);
        if (act == null || wv == null) return;
        new Thread(() -> {
            sWebview = new WeakReference<>(wv);
            boolean session = commitSession(act, wv, apk);
            JSONObject d = phase("done");
            try { d.put("session", session); } catch (Exception ignored) {}
            emit(wv, d);
            if (!session) launchInstaller(act, apk);
        }, "apk-installer-retry").start();
    }

    /** Вызывается из InstallResultReceiver — статус завершения установки. */
    static void onResult(Context ctx, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        JSONObject o = new JSONObject();
        try {
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent ua = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                if (ua != null) {
                    ua.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    ctx.startActivity(ua);
                }
                o.put("phase", "confirm");
            } else if (status == PackageInstaller.STATUS_SUCCESS) {
                o.put("phase", "installed");
            } else {
                o.put("phase", "error");
                o.put("message", msg != null ? msg : ("install status " + status));
            }
        } catch (Exception ignored) {}
        emit(sWebview != null ? sWebview.get() : null, o);
    }

    /** Открыть системный экран «Информация о приложении» (там же удаление). */
    public static void openAppInfo(Context ctx, String pkg) {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + pkg));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Exception e) {
            Log.e(TAG, "openAppInfo failed: " + pkg, e);
        }
    }

    // ------------------------------------------------------------- app queries

    public static boolean isInstalled(Context ctx, String pkg) {
        try {
            ctx.getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    public static long installedVersion(Context ctx, String pkg) {
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(pkg, 0);
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? pi.getLongVersionCode() : pi.versionCode;
        } catch (PackageManager.NameNotFoundException e) {
            return -1;
        }
    }

    /** SHA-256 сертификата(ов) подписи установленного пакета (hex через запятую) или "". */
    public static String installedSigner(Context ctx, String pkg) {
        try {
            PackageManager pm = ctx.getPackageManager();
            Signature[] sigs = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                PackageInfo pi = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES);
                if (pi != null && pi.signingInfo != null) {
                    SigningInfo si = pi.signingInfo;
                    sigs = si.hasMultipleSigners() ? si.getApkContentsSigners() : si.getSigningCertificateHistory();
                }
            } else {
                PackageInfo pi = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES);
                if (pi != null) sigs = pi.signatures;
            }
            if (sigs != null) {
                StringBuilder sb = new StringBuilder();
                for (Signature s : sigs) {
                    if (sb.length() > 0) sb.append(',');
                    sb.append(sha256Hex(s.toByteArray()));
                }
                return sb.toString();
            }
        } catch (Exception e) {
            Log.e(TAG, "installedSigner failed for " + pkg, e);
        }
        return "";
    }

    /** Список установленных (не системных) приложений:
     *  [{packageName, versionCode, versionName, label, enabled, suspended}].
     *  MATCH_UNINSTALLED_PACKAGES — чтобы были видны замороженные (disabled/hidden)
     *  приложения (Hail), но только если Hail реально установлен (иначе фантомы). */
    public static String installedApps(Context ctx) {
        JSONArray arr = new JSONArray();
        try {
            PackageManager pm = ctx.getPackageManager();
            int flags = hailAvailable(ctx) ? PackageManager.MATCH_UNINSTALLED_PACKAGES : 0;
            for (PackageInfo pi : pm.getInstalledPackages(flags)) {
                if (pi.applicationInfo == null) continue;
                ApplicationInfo ai = pi.applicationInfo;
                if (Build.VERSION.SDK_INT >= 25 && (ai.flags & ApplicationInfo.FLAG_INSTALLED) == 0) continue;
                boolean system = (ai.flags
                        & (ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0;
                if (system) continue;
                JSONObject o = new JSONObject();
                o.put("packageName", pi.packageName);
                o.put("versionCode", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? pi.getLongVersionCode() : pi.versionCode);
                o.put("versionName", pi.versionName);
                o.put("enabled", ai.enabled);
                o.put("suspended", (ai.flags & ApplicationInfo.FLAG_SUSPENDED) != 0);
                try { o.put("label", pm.getApplicationLabel(ai).toString()); } catch (Exception ignored) {}
                arr.put(o);
            }
        } catch (Exception e) {
            Log.e(TAG, "installedApps failed", e);
        }
        return arr.toString();
    }

    // ------------------------------------------------------------- Hail (freeze/launch)

    public static boolean hailAvailable(Context ctx) {
        try {
            ctx.getPackageManager().getPackageInfo("com.aistra.hail", 0);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** Экшен Hail: FREEZE/UNFREEZE/LAUNCH/... (pkg может быть ""). */
    public static boolean hail(Context ctx, String action, String pkg) {
        try {
            Intent i = new Intent("com.aistra.hail.action." + action);
            if (pkg != null && pkg.length() > 0) i.putExtra("package", pkg);
            i.setClassName("com.aistra.hail", "com.aistra.hail.ui.api.ApiActivity");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "hail action failed: " + action, e);
            return false;
        }
    }

    /** Информация о самом приложении (обёртке). */
    public static String appInfo(Context ctx) {
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            JSONObject o = new JSONObject();
            o.put("packageName", ctx.getPackageName());
            o.put("versionName", pi.versionName);
            o.put("versionCode", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? pi.getLongVersionCode() : pi.versionCode);
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    /** Базовые данные об устройстве (для выбора ABI/density). */
    public static String deviceInfo(Context ctx) {
        try {
            JSONObject o = new JSONObject();
            o.put("sdk", Build.VERSION.SDK_INT);
            o.put("model", Build.MODEL);
            o.put("manufacturer", Build.MANUFACTURER);
            o.put("locale", Locale.getDefault().toString());
            o.put("density", ctx.getResources().getDisplayMetrics().densityDpi);
            JSONArray abis = new JSONArray();
            for (String abi : Build.SUPPORTED_ABIS) abis.put(abi);
            o.put("abis", abis);
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    /** Иконка установленного пакета как PNG в base64 (для списка «Установленные»). */
    public static String appIcon(Context ctx, String pkg) {
        try {
            PackageManager pm = ctx.getPackageManager();
            int flags = hailAvailable(ctx) ? PackageManager.MATCH_UNINSTALLED_PACKAGES : 0;
            ApplicationInfo ai = pm.getApplicationInfo(pkg, flags);
            android.graphics.drawable.Drawable d = pm.getApplicationIcon(ai);
            int size = 96;
            android.graphics.Bitmap bmp = android.graphics.Bitmap.createBitmap(
                    size, size, android.graphics.Bitmap.Config.ARGB_8888);
            android.graphics.Canvas c = new android.graphics.Canvas(bmp);
            d.setBounds(0, 0, size, size);
            d.draw(c);
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, bos);
            bmp.recycle();
            return android.util.Base64.encodeToString(bos.toByteArray(), android.util.Base64.NO_WRAP);
        } catch (Exception e) {
            return "";
        }
    }

    public static void openUrl(Context ctx, String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Exception e) {
            Log.e(TAG, "openUrl failed: " + url, e);
        }
    }

    // ---------------------------------------------------------------- overallInfo

    /** Прокси для overallInfo: RuStore требует заголовок RuStoreVerCode, но с ним
     *  браузер шлёт CORS-preflight, который сервер часто режет (ERR_FAILED). Делаем
     *  запрос сами и возвращаем ответ с ACAO * — JS зовёт overallInfo БЕЗ заголовка
     *  (никакого preflight). */
    public static android.webkit.WebResourceResponse overallInfoProxy(String url) {
        try {
            java.net.HttpURLConnection c =
                    (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            c.setConnectTimeout(12000);
            c.setReadTimeout(12000);
            c.setRequestProperty("RuStoreVerCode", "1000");
            c.setRequestProperty("Accept", "application/json");
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            java.util.Map<String, String> h = new java.util.HashMap<>();
            h.put("Access-Control-Allow-Origin", "*");
            h.put("Cache-Control", "no-store");
            String ct = c.getContentType();
            return new android.webkit.WebResourceResponse(
                    ct != null ? ct : "application/json", "UTF-8", code, "OK", h, in);
        } catch (Exception e) {
            Log.e(TAG, "overallInfo proxy failed: " + url, e);
            return null; // пусть идёт обычным сетевым путём
        }
    }

    // ---------------------------------------------------------------- helpers

    /** SHA-256 сертификатов подписи APK (нижний регистр hex). */
    public static List<String> signersSha256(Context ctx, String apkPath) {
        List<String> out = new ArrayList<>();
        try {
            PackageManager pm = ctx.getPackageManager();
            Signature[] sigs = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                PackageInfo pi = pm.getPackageArchiveInfo(apkPath, PackageManager.GET_SIGNING_CERTIFICATES);
                if (pi != null && pi.signingInfo != null) {
                    SigningInfo si = pi.signingInfo;
                    sigs = si.hasMultipleSigners() ? si.getApkContentsSigners() : si.getSigningCertificateHistory();
                }
            } else {
                PackageInfo pi = pm.getPackageArchiveInfo(apkPath, PackageManager.GET_SIGNATURES);
                if (pi != null) sigs = pi.signatures;
            }
            if (sigs != null) for (Signature s : sigs) out.add(sha256Hex(s.toByteArray()));
        } catch (Exception e) {
            Log.e(TAG, "signersSha256 failed", e);
        }
        return out;
    }

    private static String sha256Hex(byte[] data) throws Exception {
        return hex(MessageDigest.getInstance("SHA-256").digest(data));
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    private static String opt(JSONObject o, String key) {
        String v = o.optString(key, null);
        return (v == null || v.isEmpty() || "null".equals(v)) ? null : v;
    }

    private static JSONObject phase(String p) {
        JSONObject o = new JSONObject();
        try { o.put("phase", p); } catch (Exception ignored) {}
        return o;
    }

    private static void emit(WebView webview, final JSONObject data) {
        if (webview == null) return;
        final String js = "window.__webtoapkEvent&&window.__webtoapkEvent('apk'," + data + ");";
        webview.post(() -> webview.evaluateJavascript(js, null));
    }
}

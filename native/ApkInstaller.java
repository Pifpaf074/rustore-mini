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
import android.os.Handler;
import android.os.Looper;
import android.os.storage.StorageManager;
import android.provider.Settings;
import android.util.Log;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

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
    // Интент подтверждения установки (STATUS_PENDING_USER_ACTION). Если запуск был
    // заблокирован (фон / другой диалог), система его теряет — сессия висит вечно,
    // а страница ждёт installed/error. Поэтому повторяем запуск при возврате в foreground.
    private static Intent sUserAction;
    /** Диалог подтверждения уже показан из foreground (повторять нельзя — см. retryPending). */
    private static boolean sUserActionShown;
    /** Экран «неизвестные источники» уже открывали для этого APK (см. retryPending). */
    private static boolean sPermScreenShown;
    // Номер попытки перезапуска диалога: отложенный повтор должен сработать один раз
    // и только если установка ещё не завершилась (иначе интент уже устарел).
    private static int sUserActionTry;
    // Пауза перед повтором: STATUS_SUCCESS/FAILURE приходит с задержкой ~1-2 с после
    // применения пакета, а сразу после установки запуск устаревшего интента показывал
    // ложное «Не удалось установить приложение».
    private static final long USER_ACTION_RETRY_MS = 1200;

    // Итог commitSession.
    private static final int COMMIT_OK = 0;       // сессия создана, файл APK больше не нужен
    private static final int COMMIT_PENDING = 1;  // ждём разрешение/foreground — файл нужен
    private static final int COMMIT_FALLBACK = 2; // сессия не удалась — ставим через ACTION_VIEW

    // Сколько держать скачанный APK, который никто не установил (мусор после убийства
    // процесса между загрузкой и установкой). Файл на 300 МБ на забитом диске — это много.
    private static final long KEEP_DOWNLOAD_MS = 24 * 60 * 60 * 1000L;
    private static volatile boolean sCleanedUp;

    private ApkInstaller() {}

    // ---------------------------------------------------------------- install

    /** Скачать APK (DownloadManager) и установить.
     *  opts (JSON): {url, size?, signer?, name?}. Прогресс/фазы — событием 'apk'.
     *  Имя файла берём детерминированное (pkg-versionCode.apk), поэтому уже скачанный
     *  APK переиспользуем, а начатую ранее загрузку — подхватываем вместо новой. */
    public static void install(final Activity activity, final WebView webview, final String optsJson) {
        new Thread(() -> {
            File apk = null;
            long dlId = -1;
            DownloadManager dm = null;
            try {
                JSONObject o = new JSONObject(optsJson == null || optsJson.isEmpty() ? "{}" : optsJson);
                String url = o.getString("url");
                String signer = opt(o, "signer");
                String name = safeName(o.optString("name", "app.apk"));
                long size = o.optLong("size", -1);

                cleanupOnce(activity);

                dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm == null) throw new Exception("no DownloadManager");
                File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) throw new Exception("no downloads dir");
                apk = new File(dir, name);

                // Что DownloadManager уже знает про этот файл (свои загрузки он отдаёт по имени).
                long[] row = ourDownloads(dm).get(name);
                long rowId = row == null ? -1 : row[0];
                int rowStatus = row == null ? -1 : (int) row[1];
                // Целый APK с прошлой попытки? Тогда качать заново незачем. Размер знаем из
                // download-link; если его нет — верим статусу DownloadManager.
                boolean have = apk.exists() && apk.length() > 0
                        && (size > 0 ? apk.length() == size : rowStatus == DownloadManager.STATUS_SUCCESSFUL);

                if (have && (rowId < 0 || rowStatus == DownloadManager.STATUS_SUCCESSFUL)) {
                    Log.d(TAG, "reuse " + name + " = " + apk.length() + " bytes");
                    checkSpace(activity, apk, size, false);
                    JSONObject p = phase("progress");
                    p.put("got", apk.length());
                    p.put("total", apk.length());
                    emit(webview, p);
                } else if (rowId >= 0 && (rowStatus == DownloadManager.STATUS_RUNNING
                        || rowStatus == DownloadManager.STATUS_PENDING
                        || rowStatus == DownloadManager.STATUS_PAUSED)) {
                    // Загрузка уже идёт (её переживает даже убийство процесса) — подключаемся.
                    Log.d(TAG, "adopt download " + rowId + " for " + name);
                    dlId = rowId;
                } else {
                    if (rowId >= 0) { try { dm.remove(rowId); } catch (Exception ignored) {} }
                    apk.delete();
                    checkSpace(activity, apk, size, true);
                    DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                    req.setMimeType("application/vnd.android.package-archive");
                    req.setTitle(name);
                    req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
                    req.setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, name);
                    dlId = dm.enqueue(req);
                }

                if (dlId >= 0) {
                    long total = size;
                    while (true) {
                        Thread.sleep(400);
                        DownloadManager.Query q = new DownloadManager.Query().setFilterById(dlId);
                        int status = -1, reason = -1;
                        long got = 0, tot = 0;
                        try (Cursor c = dm.query(q)) {
                            if (c != null && c.moveToFirst()) {
                                status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                                reason = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
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
                        if (status == DownloadManager.STATUS_FAILED) throw new Exception(downloadError(reason));
                    }
                }

                if (!apk.exists()) throw new Exception("download missing: " + name);
                Log.d(TAG, "downloaded " + name + " = " + apk.length() + " bytes");

                if (signer != null) {
                    List<String> actual = signersSha256(activity, apk.getAbsolutePath());
                    boolean ok = false;
                    for (String s : actual) if (s.equalsIgnoreCase(signer)) { ok = true; break; }
                    // Пустой список = не смогли прочитать сертификаты (бывает на старых API).
                    // Не блокируем установку: для обновления совпадение подписи всё равно
                    // проверяет сам PackageInstaller.
                    if (!ok && !actual.isEmpty()) throw new Exception("signer mismatch: " + actual);
                    if (!ok) Log.w(TAG, "signer check skipped (no certs read): " + apk.getName());
                }

                // Ставим прямо из файла DownloadManager. Копия в кэш была лишним размером APK,
                // и на телефоне с полным диском не хватало именно её (плюс сама сессия
                // установщика пишет ещё одну копию — в пике и так два размера).
                sWebview = new WeakReference<>(webview);
                int res = commitSession(activity, webview, apk);
                JSONObject d = phase("done");
                d.put("session", res != COMMIT_FALLBACK);
                emit(webview, d);
                if (res == COMMIT_FALLBACK) launchInstaller(activity, apk);
            } catch (Exception e) {
                Log.e(TAG, "install failed", e);
                // Недокачанный или битый APK не оставляем: место на телефоне дорогое.
                // А вот уже готовый файл при нехватке места бережём — на следующей попытке
                // он переиспользуется без повторной загрузки.
                if (!(e instanceof NoSpaceException)) {
                    if (dm != null && dlId >= 0) { try { dm.remove(dlId); } catch (Exception ignored) {} }
                    else if (apk != null && !apk.equals(sPendingApk)) { try { apk.delete(); } catch (Exception ignored) {} }
                }
                JSONObject err = phase("error");
                try { err.put("message", String.valueOf(e.getMessage())); } catch (Exception ignored) {}
                emit(webview, err);
            }
        }, "apk-installer").start();
    }

    // ------------------------------------------------------ загрузки: место и мусор

    /** Имя файла из JS: только безопасные символы, чтобы не выйти из каталога загрузок. */
    private static String safeName(String raw) {
        String name = raw == null ? "" : raw.replaceAll("[^A-Za-z0-9._-]", "_");
        while (name.startsWith(".")) name = name.substring(1);
        if (name.isEmpty()) name = "app";
        if (!name.endsWith(".apk")) name += ".apk";
        return name;
    }

    /**
     * Хватит ли места. Считаем по «доступному» (см. checkSpace), а не по свободному месту:
     * Android держит резерв, из-за которого «свободно 799 МБ» превращается в «доступно 318 МБ»
     * (ровно это и убивало установку 2ГИС на 323 МБ). А установка пишет в сессию
     * PackageInstaller ещё одну копию APK, поэтому в пике нужно два размера.
     */
    private static void checkSpace(Context ctx, File apk, long size, boolean willDownload) throws Exception {
        if (size <= 0) return;
        // Считаем по «доступному» (getAllocatableBytes), а не по свободному месту: Android держит
        // резерв, из-за которого «свободно 960 МБ» — это «доступно 456 МБ». По этому же числу
        // отказывается качать DownloadManager и падает запись в сессию PackageInstaller
        // («Requested internal only, but not enough space») — проверено на Realme с 2ГИС.
        // Копий в пике две (сам APK + его запись в сессию), поэтому при загрузке нужно два размера.
        long need = willDownload ? size * 2 : size;
        long have = allocatableBytes(ctx);
        if (have <= 0) {
            File dir = apk.getParentFile();
            have = dir != null ? dir.getUsableSpace() : 0;
        }
        if (have > 0 && have < need) throw new NoSpaceException(spaceMessage(need, have, willDownload));
    }

    /** Не хватает места. Отдельный тип нужен обработчику: уже скачанный APK в этом случае
     *  удалять нельзя — после освобождения места он ещё пригодится (в этом и смысл кэша). */
    private static final class NoSpaceException extends Exception {
        NoSpaceException(String message) { super(message); }
    }

    /** Сколько система реально даст занять (учитывает резерв Android). -1 — не смогли узнать. */
    private static long allocatableBytes(Context ctx) {
        try {
            StorageManager sm = (StorageManager) ctx.getSystemService(Context.STORAGE_SERVICE);
            if (sm != null) return sm.getAllocatableBytes(StorageManager.UUID_DEFAULT);
        } catch (Exception e) {
            Log.w(TAG, "allocatableBytes failed", e);
        }
        return -1;
    }

    private static String spaceMessage(long need, long have, boolean both) {
        long lack = Math.max(0, need - have);
        return "Мало места: " + (both ? "для загрузки и установки" : "для установки") + " нужно около "
                + mb(need) + " МБ, а система даёт " + mb(have) + " МБ. Освободите ещё примерно "
                + mb(lack) + " МБ.";
    }

    private static String mb(long bytes) {
        return String.valueOf(Math.round(bytes / 1048576.0));
    }

    /** Причина из DownloadManager (COLUMN_REASON) — человеческим текстом. */
    private static String downloadError(int reason) {
        switch (reason) {
            case DownloadManager.ERROR_INSUFFICIENT_SPACE: return "мало места для загрузки";
            case DownloadManager.ERROR_DEVICE_NOT_FOUND: return "внешнее хранилище недоступно";
            case DownloadManager.ERROR_FILE_ALREADY_EXISTS: return "файл уже существует";
            case DownloadManager.ERROR_FILE_ERROR: return "ошибка файла";
            case DownloadManager.ERROR_HTTP_DATA_ERROR: return "обрыв связи при загрузке";
            case DownloadManager.ERROR_TOO_MANY_REDIRECTS: return "слишком много перенаправлений";
            case DownloadManager.ERROR_UNHANDLED_HTTP_CODE: return "сервер отклонил загрузку";
            case DownloadManager.ERROR_CANNOT_RESUME: return "не удалось возобновить загрузку";
            case DownloadManager.ERROR_UNKNOWN: return "неизвестная ошибка загрузки";
            default: break;
        }
        // При HTTP-ошибке DownloadManager кладёт в reason код ответа (404, 403, ...)
        if (reason >= 400 && reason < 600) return "сервер вернул " + reason;
        return "ошибка загрузки (" + reason + ")";
    }

    /** Наши загрузки из DownloadManager (чужие он и не отдаёт): имя файла -> {id, статус, время}. */
    private static Map<String, long[]> ourDownloads(DownloadManager dm) {
        Map<String, long[]> out = new HashMap<>();
        try (Cursor c = dm.query(new DownloadManager.Query())) {
            if (c == null) return out;
            int iTitle = c.getColumnIndex(DownloadManager.COLUMN_TITLE);
            int iId = c.getColumnIndexOrThrow(DownloadManager.COLUMN_ID);
            int iStatus = c.getColumnIndex(DownloadManager.COLUMN_STATUS);
            int iMod = c.getColumnIndex(DownloadManager.COLUMN_LAST_MODIFIED_TIMESTAMP);
            int iLocal = c.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI);
            while (c.moveToNext()) {
                String title = iTitle < 0 ? null : c.getString(iTitle);
                String local = iLocal < 0 ? null : c.getString(iLocal);
                String key = null;
                if (local != null) {
                    int slash = local.lastIndexOf('/');
                    if (slash >= 0) key = local.substring(slash + 1);
                }
                if (key == null || !key.endsWith(".apk")) key = title;
                if (key == null || !key.endsWith(".apk")) continue;
                long[] v = {c.getLong(iId), iStatus < 0 ? -1 : c.getInt(iStatus), iMod < 0 ? 0 : c.getLong(iMod)};
                long[] old = out.get(key);
                if (old == null || v[0] > old[0]) out.put(key, v);   // свежайшая запись
            }
        } catch (Exception e) {
            Log.w(TAG, "cannot list downloads", e);
        }
        return out;
    }

    private static void cleanupOnce(Context ctx) {
        if (sCleanedUp) return;
        sCleanedUp = true;
        try {
            cleanupDownloads(ctx);
        } catch (Exception e) {
            Log.w(TAG, "cleanup downloads failed", e);
        }
    }

    /**
     * Убрать мусор от прерванных установок: скачанные APK, которые уже никто не ждёт, и
     * записи DownloadManager без файла. Процесс может умереть между загрузкой и установкой,
     * а такой файл на забитом диске — это сотни мегабайт (видели 161 МБ от старой Альфы).
     */
    static void cleanupDownloads(Context ctx) {
        DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
        File dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) return;
        Map<String, long[]> rows = dm == null ? new HashMap<>() : ourDownloads(dm);
        long now = System.currentTimeMillis();
        File[] files = dir.listFiles();
        if (files != null) {
            for (File f : files) {
                String name = f.getName();
                if (!name.endsWith(".apk")) continue;
                if (f.equals(sPendingApk)) continue;   // ждёт выдачи разрешения на установку
                long[] row = rows.remove(name);
                if (row != null) {
                    int st = (int) row[1];
                    if (st == DownloadManager.STATUS_RUNNING || st == DownloadManager.STATUS_PENDING
                            || st == DownloadManager.STATUS_PAUSED) continue;   // ещё качается
                }
                if (now - f.lastModified() < KEEP_DOWNLOAD_MS) continue;   // свежий — вдруг нужен
                Log.d(TAG, "cleanup stale apk " + name + " = " + f.length() + " bytes");
                if (row != null && dm != null) { try { dm.remove(row[0]); } catch (Exception ignored) {} }
                // dm.remove удаляет файл не всегда (а если запись уже пропала — вообще ничего
                // не делает), поэтому подчищаем сами: смысл чистки именно в освобождении места.
                Log.d(TAG, "cleanup delete " + name + ": " + f.delete());
            }
        }
        // Записи без файла (файл удалён после установки) — чтобы не копились в DownloadManager.
        for (Map.Entry<String, long[]> e : rows.entrySet()) {
            long[] row = e.getValue();
            int st = (int) row[1];
            if (st == DownloadManager.STATUS_RUNNING || st == DownloadManager.STATUS_PENDING
                    || st == DownloadManager.STATUS_PAUSED) continue;
            if (now - row[2] < KEEP_DOWNLOAD_MS) continue;
            Log.d(TAG, "cleanup stale download row " + e.getKey());
            if (dm != null) { try { dm.remove(row[0]); } catch (Exception ignored) {} }
        }
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
     * Открыть системный экран «установка неизвестных приложений» для нашего пакета.
     * На части прошивок такого экрана нет / он подменён — тогда остаётся только
     * подсказка на странице («Разрешите установку из этого источника»).
     */
    private static void openInstallSettings(Activity a) {
        try {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + a.getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            a.startActivity(settings);
            sPermScreenShown = true;
            Log.d(TAG, "install settings opened");
        } catch (Exception e) {
            Log.e(TAG, "cannot open install settings", e);
        }
    }

    /**
     * Установка через PackageInstaller-сессию: копируем APK в сессию и получаем
     * колбэк статуса (успех/отмена/ошибка).
     * COMMIT_OK - сессия создана (файл APK уже удалён);
     * COMMIT_PENDING - ждём разрешения/возврата в foreground (файл надо сохранить);
     * COMMIT_FALLBACK - сессия не удалась, вызывающий откатится на ACTION_VIEW.
     */
    private static int commitSession(Activity a, WebView webview, File apk) {
        boolean needPerm = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !a.getPackageManager().canRequestPackageInstalls();
        if (needPerm) {
            // Даже экран настроек нельзя открыть из фона — при свёрнутом приложении откладываем.
            sPendingApk = apk;
            sPendingActivity = new WeakReference<>(a);
            sPendingWebview = new WeakReference<>(webview);
            sPermScreenShown = false;   // для этого APK экран настроек ещё не показывали
            emit(webview, phase("permission"));
            if (MainActivity.sVisible) openInstallSettings(a);
            return COMMIT_PENDING;
        }
        // Свёрнуто → Android блокирует запуск CONFIRM_INSTALL из фона
        // (Background activity launch blocked): диалог не появится, установка «зависнет».
        // Откладываем коммит до возврата в foreground (retryPending из onResume).
        if (!MainActivity.sVisible) {
            sPendingApk = apk;
            sPendingActivity = new WeakReference<>(a);
            sPendingWebview = new WeakReference<>(webview);
            emit(webview, phase("pending"));
            return COMMIT_PENDING;
        }
        sPendingApk = null;
        try {
            PackageInstaller pi = a.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params =
                    new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setSize(apk.length());
            int id = pi.createSession(params);
            Log.d(TAG, "session " + id + " created, apk=" + apk.length() + " bytes");
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
                Log.d(TAG, "session " + id + " committed");
            }
            apk.delete();
            return COMMIT_OK;
        } catch (Exception e) {
            Log.e(TAG, "PackageInstaller session failed, fallback to ACTION_VIEW", e);
            return COMMIT_FALLBACK;
        }
    }

    /** Продолжить отложенную установку после выдачи разрешения / возврата в foreground. */
    public static void retryPending(Activity a, WebView webview) {
        // Сессия уже ждёт подтверждения, а диалог не показывался (запуск из фона
        // блокируется) — показываем теперь, когда мы на переднем плане.
        // Если диалог уже был показан, повторять нельзя: после подтверждения повторный
        // запуск того же intent'а даёт системное «ошибка анализа пакета» уже после установки.
        final Intent ua = sUserAction;
        final int attempt = ++sUserActionTry;
        if (ua != null && !sUserActionShown) {
            new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                @Override public void run() {
                    if (attempt != sUserActionTry || sUserAction != ua) return; // установка уже завершилась
                    if (sUserActionShown) return;
                    Log.w(TAG, "retry user action");
                    try { a.startActivity(ua); sUserActionShown = true; }
                    catch (Exception e) { Log.e(TAG, "retry user action failed", e); }
                }
            }, USER_ACTION_RETRY_MS);
        }
        final File apk = sPendingApk;
        if (apk == null || !apk.exists()) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !a.getPackageManager().canRequestPackageInstalls()) {
            // Разрешение так и не выдано. Экран настроек открывается только из commitSession
            // и только когда приложение на переднем плане: если APK докачался в фоне
            // (обычное дело на долгой загрузке), его не открыл никто — страница навсегда
            // остаётся на «Разрешите установку», и человек не понимает, что от него хотят.
            // Открываем сами, но ровно один раз для этого APK: иначе «назад» из настроек
            // возвращает в приложение, onResume снова открывает настройки — и не выйти.
            final WebView pw = webview != null ? webview
                    : (sPendingWebview != null ? sPendingWebview.get() : null);
            emit(pw, phase("permission"));
            if (!sPermScreenShown && MainActivity.sVisible) openInstallSettings(a);
            return;
        }
        sPendingApk = null;
        final Activity act = (sPendingActivity != null && sPendingActivity.get() != null)
                ? sPendingActivity.get() : a;
        final WebView wv = webview != null ? webview
                : (sPendingWebview != null ? sPendingWebview.get() : null);
        if (act == null || wv == null) return;
        new Thread(() -> {
            sWebview = new WeakReference<>(wv);
            int res = commitSession(act, wv, apk);
            JSONObject d = phase("done");
            try { d.put("session", res != COMMIT_FALLBACK); } catch (Exception ignored) {}
            emit(wv, d);
            if (res == COMMIT_FALLBACK) launchInstaller(act, apk);
        }, "apk-installer-retry").start();
    }

    /** Вызывается из InstallResultReceiver — статус завершения установки. */
    static void onResult(Context ctx, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        Log.d(TAG, "onResult status=" + status + " visible=" + MainActivity.sVisible + " msg=" + msg);
        JSONObject o = new JSONObject();
        try {
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent ua = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                if (ua != null) {
                    ua.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    sUserAction = ua;
                    sUserActionShown = false;
                    Log.d(TAG, "pending user action, visible=" + MainActivity.sVisible);
                    // Показываем сразу только из foreground: из фона системный диалог
                    // всё равно не откроется, а его покажет retryPending из onResume.
                    if (MainActivity.sVisible) {
                        try { ctx.startActivity(ua); sUserActionShown = true; Log.d(TAG, "user action launched"); }
                        catch (Exception e) { Log.e(TAG, "user action failed", e); }
                    }
                }
                o.put("phase", "confirm");
            } else if (status == PackageInstaller.STATUS_SUCCESS) {
                sUserAction = null;
                sUserActionShown = false;
                o.put("phase", "installed");
            } else {
                sUserAction = null;
                sUserActionShown = false;
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
                    // Для ФАЙЛА APK правильный список — содержимое подписи;
                    // getSigningCertificateHistory() на API 28 для архива возвращает пусто.
                    sigs = si.getApkContentsSigners();
                    if (sigs == null || sigs.length == 0) sigs = si.getSigningCertificateHistory();
                }
            }
            if (sigs == null || sigs.length == 0) {
                // Старый путь: работает на всех версиях (в т.ч. Android 9).
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

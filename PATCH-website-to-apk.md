# Патч `website-to-apk` для автозагрузки и установки APK

Ниже — что добавить в форк `Jipok/website-to-apk`, чтобы приложение не просто
скачивало `.apk` (как сейчас, через `DownloadManager`), но и сразу
**открывало системный установщик**.

Проект: `minSdk 24`, `targetSdk 33`, `AGP 7.3.0`, Java 11. Всё ниже совместимо.

---

## 1. `app/src/main/AndroidManifest.xml`

Добавьте разрешение и `FileProvider`.

```xml
<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
```

внутри `<application>`:

```xml
<provider
    android:name="androidx.core.content.FileProvider"
    android:authorities="${applicationId}.fileprovider"
    android:exported="false"
    android:grantUriPermissions="true">
    <meta-data
        android:name="android.support.FILE_PROVIDER_PATHS"
        android:resource="@xml/file_paths" />
</provider>
```

## 2. Новый файл `app/src/main/res/xml/file_paths.xml`

```xml
<?xml version="1.0" encoding="utf-8"?>
<paths>
    <!-- app.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) -->
    <external-files-path name="downloads" path="Download/" />
</paths>
```

## 3. `MainActivity.java`

### 3.1. Импорты (добавить)

```java
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import android.widget.Toast;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import java.io.File;
```

### 3.2. Поля класса (добавить рядом с `private WebView webview;`)

```java
private long pendingApkDownloadId = -1L;
private String pendingApkFileName = null;
private BroadcastReceiver apkInstallReceiver;
```

### 3.3. Заменить `webview.setDownloadListener(...)`

Найдите существующий блок `webview.setDownloadListener(new DownloadListener() { ... });`
и замените на такой (сохраняет прежнее поведение + добавляет APK-установку):

```java
webview.setDownloadListener(new DownloadListener() {
    @Override
    public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                String mimetype, long contentLength) {
        try {
            final boolean isApk = url.toLowerCase().endsWith(".apk")
                    || "application/vnd.android.package-archive".equals(mimetype);
            final String mime = isApk ? "application/vnd.android.package-archive" : mimetype;
            final String fileName = URLUtil.guessFileName(url, contentDisposition, mime);

            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setMimeType(mime);

            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) request.addRequestHeader("cookie", cookies);
            request.addRequestHeader("User-Agent", userAgent);
            request.setTitle(fileName);
            request.setDescription(getString(R.string.download_description));
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);

            // В app-private каталог, чтобы потом отдать через FileProvider
            request.setDestinationInExternalFilesDir(
                    MainActivity.this, Environment.DIRECTORY_DOWNLOADS, fileName);

            long id = dm.enqueue(request);
            if (isApk) {
                pendingApkDownloadId = id;
                pendingApkFileName = fileName;
            }
            Toast.makeText(getApplicationContext(), R.string.download_started, Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(getApplicationContext(), R.string.download_failed, Toast.LENGTH_LONG).show();
            Log.e("WebToApk", "Failed to start download", e);
        }
    }
});
```

### 3.4. Зарегистрировать приёмник завершения загрузки (в `onCreate`, после DownloadListener)

```java
apkInstallReceiver = new BroadcastReceiver() {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) return;
        long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
        if (id != pendingApkDownloadId) return;

        DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);

        // Проверяем, что загрузка успешна
        try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(id))) {
            if (c == null || !c.moveToFirst()) return;
            int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            if (status != DownloadManager.STATUS_SUCCESSFUL) {
                Toast.makeText(context, "Загрузка APK не удалась", Toast.LENGTH_LONG).show();
                return;
            }
        }

        installApk(context, pendingApkFileName);
        pendingApkDownloadId = -1L;
        pendingApkFileName = null;
    }
};
ContextCompat.registerReceiver(
        this, apkInstallReceiver,
        new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
        ContextCompat.RECEIVER_EXPORTED);
```

В `onDestroy()` добавьте:

```java
if (apkInstallReceiver != null) {
    try { unregisterReceiver(apkInstallReceiver); } catch (IllegalArgumentException ignored) {}
    apkInstallReceiver = null;
}
```

### 3.5. Метод установки (добавить в класс `MainActivity`)

```java
private void installApk(Context context, String fileName) {
    if (fileName == null) return;

    // Android 8+: нужно разрешение «Установка неизвестных приложений»
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && !context.getPackageManager().canRequestPackageInstalls()) {
        Toast.makeText(context,
                "Разрешите установку из этого приложения в настройках",
                Toast.LENGTH_LONG).show();
        Intent settings = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + context.getPackageName()));
        settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(settings);
        return;
    }

    File dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
    File apk = new File(dir, fileName);
    if (!apk.exists()) {
        Toast.makeText(context, "Файл APK не найден", Toast.LENGTH_LONG).show();
        return;
    }

    Uri apkUri = FileProvider.getUriForFile(
            context, context.getPackageName() + ".fileprovider", apk);

    Intent install = new Intent(Intent.ACTION_VIEW);
    install.setDataAndType(apkUri, "application/vnd.android.package-archive");
    install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_ACTIVITY_NEW_TASK);
    context.startActivity(install);
}
```

### 3.6. `shouldOverrideUrlLoading` — пропустить `.apk` в DownloadListener

В начале существующего `CustomWebViewClient.shouldOverrideUrlLoading(...)`
(там, где `String url = request.getUrl().toString();`) добавьте:

```java
// .apk не открываем наружу — пусть WebView отдаст его DownloadListener'у
if (url.toLowerCase().endsWith(".apk")) {
    return false;
}
```

Без этой строки ссылка на APK уедет во внешний браузер (в логах —
`External link:`), потому что `static.rustore.ru` не совпадает с доменом сайта.

---

## 4. Конфиг сборки (`webapk.conf`)

```ini
id = rustorem
name = RuStore mini
mainURL = https://ВАШ-ХОСТ/index.html
icon = icon.png

allowSubdomains = true
enableExternalLinks = true
openExternalLinksInBrowser = true
allowOpenMobileApp = false
requireDoubleBackToExit = true

# WebView должен уметь fetch к https://backapi.rustore.ru (CORS там открыт)
JSEnabled = true
DomStorageEnabled = true
allowMixedContent = false
```

Сборка:

```bash
./make.sh keygen      # один раз
./make.sh build       # APK в текущем каталоге
./make.sh test        # adb install + лог
```

---

## 5. Важные мелочи

* **Формат APK.** В web-UI используется `withoutSplits:true` и
  `ruStoreVerCode:1000` — приходит единый `.apk` на `static.rustore.ru`.
  Даже если придёт `.zip` (при `withoutSplits:false`), внутри него ровно
  **один** APK + `assets/dexopt/*` (это не Android split-APK), так что
  достаточно распаковать и поставить его — `PackageInstaller`-сессия не
  нужна.
* **Иконки/скриншоты**: `static-m.rustore.ru` замените на `static.rustore.ru`
  в JS (или `shouldInterceptRequest`) — иначе в WebView будут битые картинки
  из-за русского CA.
* Если хотите «без своего хостинга», положите `web/index.html` в
  `app/src/main/assets/` и поставьте `mainURL = file:///android_asset/index.html`.
  Тогда в WebView нужно `AllowFileAccess`, `AllowFileAccessFromFileURLs = true`
  и `allowMixedContent` не нужен (страница `file://`, запросы к HTTPS).
  CORS из `file://` (Origin: null) при `allow-origin: *` разрешён.
* Для автообновления приложения подпишите APK стабильным ключом
  (`make.sh` уже создаёт `my-release-key.jks`).

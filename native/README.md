# Нативное расширение форка («нашлёпка» на web-to-app)

Апстрим (`Jipok/web-to-app`, рабочая копия — `/work/2`) **не принимает** наши
нативные мосты (установка APK, список пакетов, Hail). Поэтому они живут только в
форке. Здесь лежат каноничные копии и патч, чтобы не потерять их при обновлении
апстрима.

## Что добавлено

| Файл | Что |
|---|---|
| `ApkInstaller.java` | Скачивание APK через `DownloadManager` (app-private, с прогрессом) → проверка подписи → установка через `PackageInstaller`-сессию с реальным колбэком. Плюс запросы о пакетах, их иконки, signer, Hail и openAppInfo. Также прокси `overallInfo`. |
| `InstallResultReceiver.java` | Приём статуса установки из `PackageInstaller`. |
| `upstream-src.patch` | Правки существующих файлов апстрима: `default.conf`, `make.sh`, `src/AndroidManifest.xml`, `src/java/MainActivity.java`. |

## Точки интеграции в `MainActivity.java`

1. Поля: `boolean managePackages = false;` и `public static volatile boolean sVisible = false;`.
2. `onResume()`/`onPause()` — ведут `sVisible` и вызывают `ApkInstaller.retryPending()`
   (Android блокирует коммит установки из фона — `Background activity launch blocked`).
3. `shouldInterceptRequest` — проксирует `backapi.rustore.ru/applicationData/overallInfo/*`
   (см. ниже).
4. `@JavascriptInterface`-методы: `installApk`, `getInstalledApps`, `isPackageInstalled`,
   `getInstalledVersion`, `getInstalledSigner`, `getAppIcon`, `hailAvailable`, `hailAction`,
   `openAppInfo`, `launchApp`, `getAppInfo`, `getDeviceInfo`, `openExternal`, `httpGet`.

## `make.sh` / `default.conf`

Добавлен opt-in ключ `managePackages` (по умолчанию `false`):

```
managePackages = true
```

`make.sh` при этом добавляет в манифест `QUERY_ALL_PACKAGES` и
`REQUEST_INSTALL_PACKAGES` и проставляет поле в Java. Остальные сборки апстрима
(все их confs) не затрагиваются.

Манифест: всегда объявлен `<receiver .InstallResultReceiver android:exported="false"/>`.

## Почему `overallInfo` проксируется нативно

`GET /applicationData/overallInfo/{pkg}` требует заголовок `RuStoreVerCode`, иначе
400. С кастомным заголовком браузер шлёт CORS-preflight на **каждый уникальный
URL** (кэш не помогает — URL'ы разные). Preflight-ответы RuStore отваливаются с
`net::ERR_FAILED` (WAF/нагрузка), из-за чего часть приложений выпадала из списка
обновлений («Не удалось проверить (сеть): N»).

Решение: `shouldInterceptRequest` перехватывает `overallInfo`, сам делает запрос с
заголовком и отдаёт ответ с `Access-Control-Allow-Origin: *`. JS зовёт `overallInfo`
**без** заголовка → preflight не возникает вовсе. Работает даже несмотря на то,
что OPTIONS-запрос сервер формально разрешает.

## Сборка

```bash
cd /work/2
./make.sh build confs/rustore/webapk.conf       # релиз: сайт вшит (site = site)
./make.sh build confs/rustore-dev/webapk.conf   # dev: UI с example.com
```

Каноничные конфиги — в `../confs/`. Сайт для релиза синхронизируется из `../web/`:

```bash
rsync -a --delete /work/rustore-mini/web/ /work/2/confs/rustore/site/
```

## Подпись

Релиз обязан быть подписан ключом пользователя
(`db90782f6ffe0f4cdd1af0c019f2d48e2275e63abf070a582415733973e026c2`), иначе
обновление поверх установленной «RuStore mini» не встанет. Ключ лежит в
`/work/2/my-release-key.jks` (копия из `/work/website-to-apk/app/my-release-key.jks`);
исходный ключ апстрима сохранён как `/work/2/my-release-key.webtoapp.jks.bak`.

## Пожелания апстриму

- `deleteDownload(id)` — чтобы подчищать скачанные APK (**обещано**).
- `httpGet(url)` — обход CORS для `version.json` (у нас уже есть в форке).
- Опционально: `installDownloaded(id)`, `getInstalledApps()`, `getAppIcon(pkg)`.

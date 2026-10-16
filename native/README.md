# Нативное расширение форка («нашлёпка» на web-to-app)

Апстрим (`Jipok/web-to-app`, рабочая копия — `/work/4`) **не принимает** наши
нативные мосты (установка APK, список пакетов, Hail). Поэтому они живут только в
форке. Здесь лежат каноничные копии и патч, чтобы не потерять их при обновлении
апстрима.

## Что добавлено

| Файл | Что |
|---|---|
| `ApkInstaller.java` | Скачивание APK через `DownloadManager` (app-private, с прогрессом) → проверка подписи → установка через `PackageInstaller`-сессию с реальным колбэком. Плюс запросы о пакетах, их иконки, signer, Hail и openAppInfo. |
| `InstallResultReceiver.java` | Приём статуса установки из `PackageInstaller`. |
| `upstream-src.patch` | Правки существующих файлов апстрима: `default.conf`, `make.sh`, `src/AndroidManifest.xml`, `src/java/MainActivity.java`. |

## Точки интеграции в `MainActivity.java`

1. Поля: `boolean managePackages = false;` (внутри блока `// <webtoapk:config>`, иначе
   `make.sh` его не найдёт) и `public static volatile boolean sVisible = false;` (вне блока).
2. `onResume()`/`onPause()` — ведут `sVisible` и вызывают `ApkInstaller.retryPending()`
   (Android блокирует коммит установки из фона — `Background activity launch blocked`).
   `retryPending()` заодно повторяет запуск диалога подтверждения, если система его
   потеряла (`sUserAction`, см. ниже) — **с задержкой 4 с**, иначе после успешной
   установки показывался устаревший диалог («Не удалось установить приложение»).
3. Инжект инсетов: `document.documentElement` может быть ещё `null` (инжект прилетает
   до парсинга `<html>`) — вызов обёрнут в `(function(){var d=document.documentElement;if(!d)return;…})()`,
   иначе на каждом холодном старте 3 × `Cannot read properties of null (reading 'style')`.
4. `@JavascriptInterface`-методы: `installApk`, `getInstalledApps`, `isPackageInstalled`,
   `getInstalledVersion`, `getInstalledSigner`, `getAppIcon`, `hailAvailable`, `hailAction`,
   `openAppInfo`, `launchApp`, `getAppInfo`, `getDeviceInfo`, `openExternal`.
   `shouldInterceptRequest` НЕ трогаем: CORS-проблему снимает `GM_xmlhttpRequest` апстрима.

## Почему повторяется диалог подтверждения установки

`PackageInstaller` отдаёт `STATUS_PENDING_USER_ACTION` и интент диалога, который мы
запускаем сами. Если запуск заблокирован (приложение в фоне / уже висит другой
диалог установки), интент теряется — сессия навсегда остаётся «ждёт пользователя»,
а страница навсегда ждёт `installed`/`error` (кнопка навсегда «…»). Поэтому интент
запоминается в `sUserAction` и повторно запускается из `onResume` → `retryPending()`;
сбрасывается на `STATUS_SUCCESS`/любой ошибке.

**Повтор — только пока диалог ни разу не показан.** Иначе на медленном устройстве
(установка 15–130 МБ длится дольше 4 с) повтор срабатывает уже после подтверждения
пользователем: устаревший интент заставляет PIA перечитать применённую сессию и выдать
системное «Ошибка при синтаксическом анализе пакета» **после** успешной установки.
Поэтому `sUserActionShown`: сразу запускаем только из foreground (`MainActivity.sVisible`),
а `retryPending()` повторяет лишь если диалог ещё ни разу не показывался
(`USER_ACTION_RETRY_MS = 1200`).

## Проверка подписи скачанного APK

`signersSha256()` сверяет сертификаты скачанного APK с `signature` из RuStore. Для
**файла** APK на API 28 `SigningInfo.getSigningCertificateHistory()` возвращает пустой
массив (она осмысленна только для установленных пакетов) → `signer mismatch: []` и отказ
установки. Поэтому порядок такой: `getApkContentsSigners()` → `getSigningCertificateHistory()`
→ легаси `getPackageArchiveInfo(..., GET_SIGNATURES)`. Если список всё равно пуст — `Log.w`
и установку НЕ блокируем: совпадение подписи при обновлении всё равно проверяет
`PackageInstaller` (а для свежей установки APK пришёл с доверенного хоста RuStore).

## Контракт `installApk` (фазы события `apk`)

| фаза | когда | что делает страница |
|---|---|---|
| `progress` | качаем (`DownloadManager`, опрос каждые 400 мс) | рисует проценты |
| `permission` | нет разрешения «неизвестные источники» (APK уже скачан) | «Разрешите установку», открывает настройки |
| `pending` | приложение свёрнуто — коммит отложен (BAL) | «Разверните приложение» |
| `confirm` | система показала диалог подтверждения | ничего (промис НЕ резолвится) |
| `done{session:true}` | сессия PackageInstaller создана, ждём пользователя | ничего |
| `done{session:false}` | сессия не открылась — откат на ACTION_VIEW | промис резолвится `{installed:false}`: статус нам неизвестен |
| `installed` | `InstallResultReceiver` получил `STATUS_SUCCESS` | промис резолвится `{installed:true}` |
| `error` | ошибка/отмена сессии | промис реджектится |

Важно: промис резолвится по **реальному концу установки**, а не по «открытию
установщика». Поэтому проверка версии/повторная заморозка (Hail) после `await`
корректны. Только в ветке `{installed:false}` (ACTION_VIEW) статуса нет — там
версия не проверяется, строка не убирается и заморозка не возвращается.

## `make.sh` / `default.conf`

Добавлен opt-in ключ `managePackages` (по умолчанию `false`):

```
managePackages = true
```

`make.sh` при этом добавляет в манифест `QUERY_ALL_PACKAGES` и
`REQUEST_INSTALL_PACKAGES` и проставляет поле в Java. Остальные сборки апстрима
(все их confs) не затрагиваются.

Манифест: всегда объявлен `<receiver .InstallResultReceiver android:exported="false"/>`.

## Почему НЕ нужен нативный прокси `overallInfo`

`GET /applicationData/overallInfo/{pkg}` требует заголовок `RuStoreVerCode`, иначе
400. С кастомным заголовком браузер шлёт CORS-preflight на **каждый уникальный URL**,
из-за чего часть приложений выпадала из списка обновлений («Не удалось проверить
(сеть): N»). Раньше это лечилось нативным `shouldInterceptRequest`-прокси.

Теперь прокси не нужен: все запросы идут через `GM_xmlhttpRequest` апстрима
(нативный мост, cookie-less, без CORS) — заголовок ставится прямо в JS
(`web/native.js` → `gmRequest`/`httpRaw`), preflight'ов нет вообще.

## Переход на свежий апстрим

1. Взять свежий checkout и **заменить ключ подписи на наш** (в checkout'е лежит ключ
   апстрима — иначе самообновление не встанет):
   `cp my-release-key.jks my-release-key.upstream.jks.bak && cp <наш>.jks my-release-key.jks`.
2. Снять снапшот «чистых» файлов, которые правит патч:
   `default.conf`, `make.sh`, `src/AndroidManifest.xml`, `src/java/MainActivity.java`.
3. Наложить оверлей: `native/apply.sh <дерево>` (или те же правки руками —
   см. «Точки интеграции» выше).
4. Перегенерировать патч из снапшота:
   ```bash
   cd <снапшот> && : > native/upstream-src.patch
   for f in default.conf make.sh src/AndroidManifest.xml src/java/MainActivity.java; do
     diff -u --label "a/$f" --label "b/$f" "$f" "<дерево>/$f" >> native/upstream-src.patch
   done
   ```
5. Проверить: `git apply --check` на чистом дереве + сравнение результата с рабочим
   (байт-в-байт), затем `./make.sh build` и запуск на устройстве.

Апстрим переписывает `make.sh`/`MainActivity` довольно сильно, поэтому после переезда
проверять нужно всё: холодный старт (консоль), рейлы/поиск/карточку/отзывы,
установку, pull-to-refresh.

## Сборка

```bash
cd /work/4
./make.sh build confs/rustore/webapk.conf       # релиз: сайт вшит (site = site)
./make.sh build confs/rustore-dev/webapk.conf   # dev: UI с сервера раздачи
```

Каноничные конфиги — в `../confs/`. Сайт для релиза синхронизируется из `../web/`:

```bash
rsync -a --delete /work/rustore-mini/web/ /work/4/confs/rustore/site/
```

## Подпись

Релиз обязан быть подписан ключом пользователя
(`db90782f6ffe0f4cdd1af0c019f2d48e2275e63abf070a582415733973e026c2`), иначе
обновление поверх установленной «RuStore mini» не встанет. Ключ лежит в
`/work/4/my-release-key.jks` (копия старого ключа; форк `website-to-apk`, откуда он
взят, удалён);
исходный ключ апстрима сохранён как `/work/4/my-release-key.webtoapp.jks.bak`.

## Пожелания апстриму

- **Баг:** инжект инсетов падает до парсинга `<html>` — 3 × `Cannot read properties of
  null (reading 'style')` в консоли на каждом холодном старте (лечится guard'ом, см. выше).
- **Баг:** потерянный интент подтверждения установки (`STATUS_PENDING_USER_ACTION`)
  навсегда вешает установку — нужен повторный запуск из `onResume` (и, что важнее,
  с задержкой: см. выше).
- **Баг:** `SwipeRefreshLayout` видит только скролл WebView — при своей прокрутке внутри
  страницы (оверлей) pull-to-refresh дёргается не вовремя. Спасает только
  `setPullToRefreshEnabled` из JS на каждый scroll своего скроллера.
- `getDownloads().url`, `removeDownload(id)` — **уже есть** в свежем апстриме (нам не
  нужны: `ApkInstaller` сам зовёт `dm.remove`).
- `GM_xmlhttpRequest` — **уже есть** и решает CORS/preflight целиком (мы перешли на него).
- Документация JS-хуков: страница сама присваивает `WebToApk.onDownloadStarted = fn`;
  `onPullToRefresh` обязан вернуть `true`, иначе обёртка перезагружает страницу.
- Опционально: `installDownloaded(id)`, `getInstalledApps()`, `getAppIcon(pkg)`.

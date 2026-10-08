# RuStore: препарирование + мини-клиент

Разбор сделан в октябре 2026 по живому API, сайту `www.rustore.ru`, JS-бандлам
и нескольким сторонним проектам. Все ключевые факты проверены реальными
запросами (команды есть ниже).

---

## TL;DR

* **Качать APK можно напрямую и без аккаунта** через
  `https://backapi.rustore.ru` (поиск/инфо) и `https://api.rustore.ru`
  (новый API, скачивание). Схема: `overallInfo` (узнать `appId`) →
  `POST /v3/showcase/apps/download-link` (`withoutSplits:true`) →
  прямая ссылка на **единый `.apk`** на `static.rustore.ru`.
* **API не обфусцирован** — обычный REST/JSON. Но он **недокументированный и
  капризный**: есть неочевидные правила по заголовку версии и `deviceType`,
  которые и «ломают» старые даунлоадеры (в т.ч. `k7361/rustore-downloader`).
* **Картинки не грузятся в демо не из-за API**, а потому что `overallInfo`
  отдаёт иконки/скриншоты с `static-m.rustore.ru`, а он подписан
  **Russian Trusted CA**, который западные браузеры/Android не признают →
  TLS-ошибка. Лечится заменой хоста на `static.rustore.ru` (те же файлы,
  глобально доверенный сертификат).
* У `k7361` поиск/инфа работают (`mobile` + `1105001` — валидная комбинация),
  но карточки тянут иконки с `static-m` (битые), а download-link с его
  параметрами отдаёт `.zip` тоже на `static-m` — в браузере и это упадёт по
  TLS. Плюс он дёргает устаревший путь `/api/v3/...` (сейчас 502) и только
  потом откатывается на `v2`. Отсюда «API поменялся».
* **Меняться API может, но редко** (основные ручки живут год+). Главные риски —
  заголовок версии и хост картинок. Правильная архитектура: тонкая нативная
  оболочка + обновляемый web-UI/прокси, чтобы не пересобирать APK.
* **«Свежий» API тоже доступен** без подписи и без русского CA: на
  `api.rustore.ru` / `web-api.rustore.ru` (сертификат HARICA). Гейт
  `ruStoreVerCode ≥ 1105002 → 419` — универсален для всех хостов.
* **Самый дешёвый путь для «своего мини-стора»** — не писать установщик с нуля,
  а взять **F-Droid** (`visionavtr/rustore-fdroid` генерирует нормальный
  F-Droid-репозиторий из приложений RuStore) **или** обернуть свой web-UI через
  `website-to-apk` + ~100 строк Java для автоустановки APK.

---

## 1. Устройство API

Базовый хост: `https://backapi.rustore.ru` (это API мобильного приложения
RuStore). Сайт `www.rustore.ru` теперь ходит в другой шлюз —
`web-api.rustore.ru` (только `suggests`, `trends`, `comments`), но для
поиска/скачивания нужен именно `backapi`.

### Проверенные ручки

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/applicationData/apps?pageNumber=0&pageSize=20&query=` | поиск |
| GET | `/search/suggest?query=` | подсказки |
| GET | `/applicationData/overallInfo/{packageName}` | полная инфа о приложении |
| GET | `/applicationData/allAppVersionWhatsNew/{appId}` | список версий + «что нового» |
| GET | `/comment/comment?packageName=&sortBy=NEW_FIRST&pageNumber=0&pageSize=20` | отзывы |
| POST | `/applicationData/v2/download-link` | ссылка на APK |
| POST | `/v3/showcase/apps/download-link` | то же (новый путь, без `/api`) |
| GET | `/rustore-info/new-version` | `minVersion`/`latestVersion` (нужен `deviceId`) |

Обязательный заголовок для POST: **`ruStoreVerCode`**. Для GET часто
необязателен. `Accept: application/json`. Ответ всегда `{code, message, body}`,
успех — `"code":"OK"`.

### Правила заголовка `ruStoreVerCode` (вот тут всё и ломается)

* **`>= 1105002` → HTTP 419** с пустым телом. Поэтому `1111003` (текущий
  latest!) **не работает**. Рабочие значения: `1000` … `1105001`.
* `download-link` **без** заголовка → HTTP 400.
* `deviceType`:
  * валидны только `mobile` и `tv`;
  * `phone`, `tablet` → HTTP 400 `IllegalArgumentException` (в `k7361` как раз
    `mobile`, так что поиск у него работает; но см. ниже про картинки/скачивание);
  * `mobile` дополнительно требует `ruStoreVerCode >= minVersion`
    (сейчас `1101002`), иначе **HTTP 417 «Обновите RuStore»**. Без `deviceType`
    проверки нет — **проще всего `deviceType` вообще не слать**.
* **Версия влияет на формат APK:**
  * `ruStoreVerCode: 1000` + `withoutSplits:true` → единый `.apk`
    на **`static.rustore.ru`** (доверенный TLS) — то, что нам нужно;
  * `ruStoreVerCode: 1105001` + `withoutSplits:true` → `.zip` на
    **`static-m.rustore.ru`** (русский CA) — хуже. Внутри zip — **один**
    `.apk` + `assets/dexopt/*` (проверено на 6 приложениях, вкл. крупные);
    это не набор Android split-APK, а транспортный контейнер.

### Скачивание (проверенный запрос)

```
POST https://backapi.rustore.ru/applicationData/v2/download-link
Headers: ruStoreVerCode: 1000
Body: {"appId":2688703,"firstInstall":true,"screenDensity":480,
       "sdkVersion":36,"withoutSplits":true,"supportedAbis":["arm64-v8a"]}
```

Ответ:
```json
{"code":"OK","body":{
  "versionCode":3561,
  "downloadUrls":[{"url":"https://static.rustore.ru/2026/09/30/....apk",
                   "size":364421181,"hash":"c2c514aee550cf9d"}],
  "signature":"daacf9...8f9a"}}
```

* `signature` — **SHA-256 сертификата подписи** (тот же, что в `overallInfo`).
  Можно проверять, что APK подписан тем же ключом (через `apksigner`).
* `hash` — короткий (16 hex), похоже на xxhash64 объекта; для честной проверки
  используйте `size` и подпись.

### `.zip` или `.apk` — зачем zip, если APK и так zip?

`withoutSplits` меняет только контейнер:

* `false` → отдают `.zip`; внутри ровно **один** `.apk` + baseline-профили
  `assets/dexopt/baseline.prof|profm`. Это **не** набор Android split-APK.
* `true` → тот же APK, но сразу как `.apk`.

Смысл zip всё же есть: APK — это zip, но часть внутренних записей лежит
без сжатия (нативные `.so` для mmap, выровненные ресурсы). Повторный deflate
реально экономит трафик. Замеры по центральной директории:

| Приложение | `.apk` | `.zip` | экономия |
|---|---|---|---|
| Avito | 347.5 МБ | 221.0 МБ | 36% |
| Сбербанк | 157.9 МБ | 79.4 МБ | 50% |
| Яндекс.Карты | 347.3 МБ | 328.4 МБ | 5% |
| Sudoku | 22.5 МБ | 21.0 МБ | 6% |

Плюс zip несёт baseline-профили отдельными файлами. Для мини-аппа берите
`withoutSplits:true` — меньше возни.

### CORS

`backapi` отдаёт **`access-control-allow-origin: *`** и для GET, и для POST
(preflight разрешает `content-type`, `rustorevercode`, `devicetype`). Поэтому
**веб-страница может ходить в API напрямую из WebView без прокси**. Прокси
всё равно бывает полезен (см. §4).

### Картинки и TLS — почему «не грузятся»

* `static.rustore.ru` — сертификат `HARICA DV TLS RSA` (доверенный везде).
* `static-m.rustore.ru` — сертификат `CN=rustore.ru`, выдан
  **«Russian Trusted Sub CA» / Минцифры**. В Chrome/Firefox/Android **без
  установленного русского корневого CA** это TLS-ошибка → битые картинки.
* `overallInfo` отдаёт `iconUrl` и `fileUrls` именно с `static-m`.
  Содержимое идентично `static.rustore.ru` (сравнено побайтово) →
  **достаточно заменить хост**.

---

## 2. API стабильный или обфусцированный?

**Не обфусцирован.** Никакого шифрования/подписи запросов, обычный JSON REST,
человекочитаемые пути. Obfuscated только JS сайта (webpack), но не API.

**Стабильный — но не гарантированно.** Эндпоинты `overallInfo` и
`v2/download-link` живут минимум год, сторонние проекты (2025–2026) используют
те же пути. При этом ломаются «мягкие» правила:

| Что менялось / риск | Проявление | Обход |
|---|---|---|
| Порог `ruStoreVerCode` | `>=1105002` → 419 | пин `1000`/`1105001` |
| enum `deviceType` | `phone` → 400 | не слать или `mobile`/`tv` |
| минимальная версия для `mobile` | 417 | не слать `deviceType` |
| хост картинок + CA | битые иконки | `static-m` → `static` |
| формат ответа (`signature`, поля) | — | парсить мягко |

**Вывод:** это «полу-приватный» API: функционально стабилен, но без SLA.
Гарантий, что завтра не отключат `v2/download-link`, нет.

---

## 3. Как часто придётся обновлять мини-апк?

Если APK **сам** зовёт `backapi` и в нём зашиты заголовки/эндпоинты, то при
любом изменении API придётся выпускать новую версию APK. Частота — «раз в
несколько месяцев», не каждый день.

**Как снять зависимость от пересборки:**

1. **Web-UI + тонкая нативная оболочка (рекомендую).** Логика (поиск, инфа,
   ссылки) живёт в HTML/JS, который грузится с вашего сервера или GitHub Pages.
   Обновили страницу — обновилось у всех, APK не пересобирается. Нативная
   оболочка нужна только для «скачать и поставить».
2. **Свой прокси-слой** (как `vercel.json` у k7361): клиент ходит в ваш
   `/api`, вы внутри чините/подменяете `backapi`. Тогда правки — на сервере.
3. **Remote-config**: min/max `ruStoreVerCode`, список эндпоинтов — с сервера.
4. Если уж совсем не хочется сервера — вынесите все константы (хост, версию,
   пути) в одно место и держите `static.rustore.ru`/`ruStoreVerCode=1000`.

Нативная часть с установщиком практически **не зависит** от RuStore-API —
она меняется только при изменениях самого Android.

---

## 4. Android: как делать мини-апк

Оценка «человеко-дней» для одного разработчика, знакомого с Android/JS.

### Вариант A. WebView-обёртка (`website-to-apk`) + свой web-UI — **минимум кода**

Что уже есть в `website-to-apk`:
* готовая сборка APK без Android Studio (`./make.sh build`), скачивание
  JDK17/SDK/Gradle;
* `WebView` c `DownloadListener` → качает через системный `DownloadManager`;
* JS-bridge `WebToApk`, userscripts, куки, deeplink.

Что надо дописать для «установщика» (~100–150 строк Java):
* в манифест: `REQUEST_INSTALL_PACKAGES`, `FileProvider`;
* в `DownloadListener`: для `.apk` форсить MIME
  `application/vnd.android.package-archive`;
* `BroadcastReceiver` на `DownloadManager.ACTION_DOWNLOAD_COMPLETE` →
  `FileProvider.getUriForFile(...)` → `Intent(ACTION_VIEW)` → системный
  установщик;
* проверка `PackageManager.canRequestPackageInstalls()` (Android 8+) с
  переходом в настройки «Установка неизвестных приложений»;
* в `shouldOverrideUrlLoading` вернуть `false` для `.apk`, чтобы WebView
  отдал загрузку в `DownloadListener` (иначе внешняя ссылка уйдёт в браузер).

Плюс: APK почти не надо пересобирать (UI обновляется на сервере), нативная
часть крошечная, поддержка установки/сплитов не нужна (мы качаем unified APK).

Минус: WebView-приложение, требуется собственный web-хостинг (впрочем, можно
и `file:///android_asset/…`).

**Готовый гайд с кодом — в `PATCH-website-to-apk.md`.**

### Вариант B. F-Droid репозиторий — **0 строк Android-кода**

Проект `visionavtr/rustore-fdroid` (Go, авг 2026):
* `rustore-fdroid -r ./repo add <pkg> <pkg>…` — тянет метаданные, APK, иконки,
  скриншоты, вытаскивает подпись/разрешения;
* `update` — обновляет версии; `sign` — публикует `index-v1.jar`,
  `index-v2.json`, `entry.jar` (подпись своим ключом);
* есть встроенный web-frontend для просмотра и QR-кода добавления репозитория;
* в комплекте кладёт **Russian Trusted Root CA** и применяет его только к
  `*.rustore.ru` — то есть авторы уже решили проблему `static-m`.

Дальше вы просто добавляете URL репозитория в **штатный F-Droid** (или
Droid-ify). Установкой/обновлениями/сплитами занимается F-Droid — это самый
надёжный установщик. Нужен лишь хостинг статики + периодический прогон
`update && sign` (cron).

Минус: это не «браузер всего каталога RuStore», а список тех приложений, что вы
добавили. Но для «своего мини-стора» — самое то.

### Вариант C. Нативное приложение на Kotlin

Полный контроль (нормальный список, поиск, загрузки, обновления, Material), но:
свой `RecyclerView`, `Retrofit`/`OkHttp`, `DownloadManager`/`WorkManager`,
`PackageInstaller`, экраны деталей, кэш иконок, обновления. Реально
**3–7 дней** на аккуратную версию. Для «для себя» избыточно.

### Вариант D. Obtainium + обёртка

`alexlag/rustore-wrapper` делает из API HTML, который понимает **Obtainium**.
Obtainium сам качает APK с сайта и ставит, умеет отслеживать обновления.
Минимум кода, но это сторонний клиент, а не «ваш список».

### Итог сравнения

| Вариант | Код | Установщик | Обновл. без пересборки | «Каталог RuStore» |
|---|---|---|---|---|
| A. WebView + свой UI | ~150 строк | свой (несколько дней) | да (web) | да (поиск) |
| B. F-Droid репа | ~0 | F-Droid (отличный) | да (CLI) | нет (только добавленные) |
| C. Native Kotlin | много | свой | нет | да |
| D. Obtainium | ~0 | Obtainium | да | нет |

**Рекомендация:** если цель — «чтобы ставилось и обновлялось надёжно» →
**B (F-Droid)**. Если цель — «мой красивый список всего RuStore» → **A**.

---

## 5. Что в этой папке

* `rustore.py` — рабочий CLI (только stdlib): `search`, `info`, `url`,
  `download`. Умеет `static-m`→`static`, `withoutSplits`, проверку размера.
* `web/index.html` — самодостаточный web-UI (поиск, карточка, скриншоты,
  «Скачать APK») для WebView-обёртки. Ходит в `backapi` напрямую (CORS открыт).
* `PATCH-website-to-apk.md` — что и куда дописать в `website-to-apk`, чтобы
  скачанный APK сразу ставился.

Проверить CLI:
```bash
python3 rustore.py search flashlight
python3 rustore.py info com.one.tap.flashlight
python3 rustore.py download com.one.tap.flashlight -o downloads
```

---

## 6. Проверочные команды (чтобы убедиться самому)

```bash
# поиск
curl -s -H 'ruStoreVerCode: 1000' \
  'https://backapi.rustore.ru/applicationData/apps?pageNumber=0&pageSize=3&query=avito'

# инфа
curl -s -H 'ruStoreVerCode: 1000' \
  'https://backapi.rustore.ru/applicationData/overallInfo/com.avito.android'

# единый APK (обратите внимание на static.rustore.ru и .apk)
curl -s -H 'ruStoreVerCode: 1000' -H 'Content-Type: application/json' \
  -X POST 'https://backapi.rustore.ru/applicationData/v2/download-link' \
  -d '{"appId":2688703,"firstInstall":true,"screenDensity":480,"sdkVersion":36,"withoutSplits":true,"supportedAbis":["arm64-v8a"]}'

# доказательство 419
curl -s -o /dev/null -w '%{http_code}\n' -H 'ruStoreVerCode: 1111003' \
  'https://backapi.rustore.ru/applicationData/overallInfo/com.avito.android'
```

---

## 8. Что внутри свежего приложения RuStore (1.111.0.3)

Официальный APK лежит на странице `/instruction`:
`https://static.rustore.ru/rustore-releases/stable/RuStore-mobile-1.111.0.3.apk`.
Разобрал 5 DEX-файлов (≈59 МБ bytecode). Приложение эволюционировало в
микросервисы, но legacy-ручки `applicationData` **не выкинуты**.

**Хосты нового приложения** (все `-m` — под Russian Trusted CA):

| Хост | Назначение |
|---|---|
| `api-m.rustore.ru` | шлюз микросервисов: `/product-catalog-gateway/`, `/feedbacks/`, `/selection/`, `/promotion/`, `/payment-gateway/`, `/payment-token-management/`, `/notification-service/`, `/user-start-flow/`, `/user-event-handler/`, `/app-attribute/`, `/deeplink/`, `/invoices-history/` |
| `backapi-m.rustore.ru` | те же `applicationData/...` (каталог, overallInfo, download) |
| `pay-backapi-m.rustore.ru` | платежи |
| `rc-m.rustore.ru`, `ads-m.rustore.ru`, `stats-dg.rustore.ru` | remote config, реклама, статистика |

**Новые пути**, которых нет в старом клиенте:
`/v1..v5/showcase/...`, `/api/v1/recommendation`,
`/applicationData/signature/valid`, `/applicationData/allCategory`,
`/applicationData/newApps`, `/applicationData/devices/{deviceId}/recommendation`,
`/applicationData/devs/{devId}/apps`.

**Защита:** в strings видны `X-Client-Signature`, `X-Challenge`,
`X-Challenge-Solution`, `X-Challenge-Url`, `X-Device-Id`, `X-APP-PACKAGE-ID` —
новые ручки, похоже, требуют подписи запроса/анти-бот-челленджа. Плюс APK
везёт с собой русские корневые CA (`russian_trusted_root_ca_gost_2025`,
`russian_trusted_sub_ca_gost_2025`, `inapp_russian_trusted_sub_ca_2024`).

**Вывод (обновлено):** микросервисы `api-m` требуют русского CA, но те же
ручки **открыты на HARICA-хостах** `api.rustore.ru` и `web-api.rustore.ru`
без подписи — см. §9. А `applicationData` (поиск, overallInfo) живёт только
на `backapi`/`backapi-m` и там работает `ruStoreVerCode ≤ 1105001`.

---

## 9. Новый API задействован (HARICA, без подписи)

`api.rustore.ru` (тот же HARICA-сертификат, что у `backapi`) отдаёт новый
REST-API микросервисов. Заголовок `ruStoreVerCode` обязателен, но подпись/
challenge **не нужны**. Проверено с `ruStoreVerCode: 1000`:

| Метод | Путь | Что |
|---|---|---|
| POST | `/v3/showcase/apps/download-link` | ссылка на APK (то же тело; `ver=1000` → `static.rustore.ru`) |
| GET | `/v1/showcase/trends`, `/v2/showcase/trends` | тренды |
| GET | `/v2/showcase/comments/by-app?packageName=&limit=&offset=` | отзывы |
| GET | `/v2/showcase/popular/apps?limit=&offset=` | популярное |
| POST | `/v1/showcase/startup-destination` | стартовый экран |
| GET | `/v5/showcase/sections?selectionIds=&limit=` | секции/подборки |

Веб-шлюз `web-api.rustore.ru` (тоже HARICA) — то, что использует сайт:
`/v1/showcase/web/trends`, `/v1/showcase/web/search/suggests?query=...`.
Полноценный поиск сайта рендерится на сервере, отдельной публичной ручки
не нашлось.

Чего в новом API **нет**: `applicationData/*` (поиск, overallInfo) — только
на `backapi`/`backapi-m`.

**Гейт 419 универсален**: `backapi`, `api` и `backapi-m` одинаково режут
`ruStoreVerCode ≥ 1105002`. С `1000` новый download-link отдаёт
`static.rustore.ru`; с `1105001` — `static-m.rustore.ru` (русский CA). Итого:
* поиск/инфо → `backapi.rustore.ru/applicationData/*` (`ver=1000`);
* скачивание → `api.rustore.ru/v3/showcase/apps/download-link` (`ver=1000`).

### Дропнут ли старый API?

Точно неизвестно, но по признакам — не завтра:
* свежее приложение 1.111.0.3 **всё ещё** ходит в `applicationData/*`;
* `minVersion` = 1101002, а `applicationData` принимает до 1105001 — запас есть;
* если убьют хост `backapi`, те же пути есть на `backapi-m` (нужен русский CA,
  его умеет `rustore-fdroid`), а скачивание уже есть на HARICA `api.rustore.ru`.

Риск наступит, когда `minVersion` перевалит за 1105001 — тогда старый
compat-уровень отключат. Это недели/месяцы, не дни. На этот случай держите
базовые URL в конфиге (или прокси), чтобы не перевыпускать APK.

---

## 7. Оговорки

* API неофициальный; это reverse-engineering, а не публичный контракт. Может
  меняться без предупреждения. Для личного использования ок, для продукта —
  на свой риск.
* У части приложений `aggregatorInfo != null` (внешний источник) — прямой APK
  может отсутствовать. Проверяйте.
* Платные приложения напрямую не скачиваются.
* Скачивание/распространение APK сторонних приложений — вопрос лицензий;
  для личного использования обычно ок.

---

## 10. Клиент: тема, кэш и авто-обновление (v1.8 / versionCode 9)

**Системная тема.** Android-WebView не всегда отдаёт `prefers-color-scheme`
(на Android 12: система в night, а `matchMedia('(prefers-color-scheme: dark)').matches === false`).
Поэтому обёртка пробрасывает тему в JS:
* `WebToApk.getSystemTheme()` → `"dark"`/`"light"` (по `Configuration.uiMode`);
* `onConfigurationChanged` → `window.__onNativeTheme(t)` на лету;
* в JS: `window.Native.systemTheme()` (helpers.js) с фолбэком на `matchMedia`.
Кнопка темы циклит `auto → light → dark → auto`, режим — в
`localStorage['rs_theme_mode']`, по умолчанию `auto` (за системой).

**Кэш.** `cacheMode = aggressive` (`LOAD_CACHE_ELSE_NETWORK`) — мгновенный старт
из кэша. API RuStore отдаёт `Cache-Control: no-store`, поэтому поиск/инфо не залипают.

**Авто-обновление web-части (без ручной правки версии).** Деплой — `./deploy.sh [DST]`:
* версия = sha256 содержимого `web/*` (12 hex);
* в `index.html` проставляются `<meta name="web-ver" content="ВЕРСИЯ">` и версии в URL
  подресурсов (`app.js?v=...`, `incr.js?v=...`, `pre.js?v=...`);
* `web` пишется в `version.json` (поля APK сохраняются).
Клиент при старте сравнивает свою мету с `version.json.web`; при расхождении делает
`clearCache()` + `location.reload()` — базовый URL перекэшируется, следующий старт
мгновенный из кэша. Кнопка ⟳ делает то же вручную.

**Edge-to-edge.** `edgeToEdge = true`: прозрачные статус/нав-бары, контент под ними;
инсеты приходят как `--safe-area-inset-*` (обёртка) с фолбэком на `env()`, и
переприменяются в `onPageFinished`. В итоге статус-бар сливается с фоном (не чёрная полоса).

**Отзывы.** В карточке — кнопка «Показать отзывы» (лённо). Только просмотр, без входа:
`GET backapi.rustore.ru/comment/comment?packageName=&sortBy=NEW_FIRST&pageNumber=&pageSize=`.
Показ: имя, звёзды, дата, текст, ответ разработчика, «Показать ещё».

## 11. Заморозка приложений (Hail) — детект и интеграция

**Проблема.** Пользователь морозит приложения через [Hail](https://github.com/aistra0528/Hail)
(root/Shizuku). Замороженные приложения «исчезают»: Hail в режиме **DISABLE**
(`pm disable-user`, `enabled=2`) / **HIDE** (`pm hide`) / **SUSPEND** (`pm suspend`).
Обёртка их не видела, потому что `getInstalledPackages(0)` не отдаёт выключенные.

**Фикс в обёртке (нативная часть):**
* `installedApps()` теперь ходит с `MATCH_UNINSTALLED_PACKAGES` (и отсекает
  «удалённые, но с данными» по `FLAG_INSTALLED`), а в JSON добавлены `enabled` и
  `suspended`. Замороженное = `!enabled || suspended`.
* Мост Hail: `hailAvailable()` и `hailAction(action, pkg)` → шлём интент в
  экспортированную `com.aistra.hail.ui.api.ApiActivity` с экшеном
  `com.aistra.hail.action.{FREEZE,UNFREEZE,LAUNCH}` и extra `package`.

**Публичный API Hail** (README проекта): экшены `FREEZE/UNFREEZE/LAUNCH`,
`FREEZE_TAG/UNFREEZE_TAG`, `FREEZE_ALL/UNFREEZE_ALL`, `FREEZE_NON_WHITELISTED`,
`FREEZE_AUTO`, `LOCK/LOCK_FREEZE`; extra `package`/`tag`. Плюс схема
`hail://freeze?package=xxx`. `FREEZE` требует, чтобы пакет был отмечен в Hail
(иначе `SecurityException`); `UNFREEZE` — нет.

**UI:** в «Установленных» — значок ❄/☀ (заморозить/разморозить) и бейдж
«заморожено»; в «Обновлениях» — бейдж, а `updateOne()` сам размораживает перед
установкой и возвращает заморозку после. Запуск замороженного — через
`LAUNCH` Hail (он сам разморозит и запустит).

Проверено на устройстве: `enabled 2 → 1 → 2` (разморозка и обратная заморозка).

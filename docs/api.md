# RuStore API — разбор

Что проверено живыми запросами (октябрь 2026): ручки, правила заголовков,
подводные камни и доказательства. Всё, что нужно знать, чтобы ходить в API RuStore
напрямую, без официального приложения.

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

## Устройство API

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
веб-страница может ходить в API напрямую из WebView без прокси.

**Но есть грабли (важно):** `overallInfo` требует заголовок `RuStoreVerCode` (без
него 400). С кастомным заголовком браузер шлёт **CORS-preflight на каждый уникальный
URL** (кэш не помогает — URL'ы разные). OPTIONS-ответ RuStore формально разрешает
заголовок, но при проверке обновлений (55 пакетов) часть preflight'ов отваливается
с `net::ERR_FAILED` → приложения выпадают из списка («Не удалось проверить (сеть): N»).

**Решение** (в форке): `shouldInterceptRequest` в WebView перехватывает
`backapi.rustore.ru/applicationData/overallInfo/*`, сам делает запрос с заголовком
и отдаёт JSON с `Access-Control-Allow-Origin: *`; JS зовёт `overallInfo` **без**
заголовка → preflight не возникает вообще.

**Ещё грабля:** у 404-ответа RuStore тело —
`{"code":"ERROR","message":"Couldn't find required data, error: android_app_ver"}` —
**без цифр**. Если определять 404 через `/404/` по тексту ошибки, такие приложения
попадут в «сетевые ошибки». Детектить надо по HTTP-статусу.

### Картинки и TLS — почему «не грузятся»

* `static.rustore.ru` — сертификат `HARICA DV TLS RSA` (доверенный везде).
* `static-m.rustore.ru` — сертификат `CN=rustore.ru`, выдан
  **«Russian Trusted Sub CA» / Минцифры**. В Chrome/Firefox/Android **без
  установленного русского корневого CA** это TLS-ошибка → битые картинки.
* `overallInfo` отдаёт `iconUrl` и `fileUrls` именно с `static-m`.
  Содержимое идентично `static.rustore.ru` (сравнено побайтово) →
  **достаточно заменить хост**.


---

## API стабильный или обфусцированный?

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

## Как часто придётся обновлять мини-апк?

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

## Проверочные команды (чтобы убедиться самому)

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

## Что внутри свежего приложения RuStore (1.111.0.3)

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

## Новый API задействован (HARICA, без подписи)

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

## Оговорки

* API неофициальный; это reverse-engineering, а не публичный контракт. Может
  меняться без предупреждения. Для личного использования ок, для продукта —
  на свой риск.
* У части приложений `aggregatorInfo != null` (внешний источник) — прямой APK
  может отсутствовать. Проверяйте.
* Платные приложения напрямую не скачиваются.
* Скачивание/распространение APK сторонних приложений — вопрос лицензий;
  для личного использования обычно ок.



# Headless-тесты UI

Гоняются без устройства и без сборки APK: `python3 -m http.server 8099` в `web/` +
`chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=9223
--user-data-dir=/tmp/cr-detail`, затем `BASE=http://127.0.0.1:8099 node <тест>.mjs`.
Негативный контроль — тот же тест с `BASE=http://127.0.0.1:8098` на старом `app.js`.

| Тест | Что проверяет |
|---|---|
| `ptrsync.mjs` | pull-to-refresh запрещается, пока прокручен оверлей карточки (`.dbody`), и возвращается в начале/при закрытии |
| `cardupdremove.mjs` | установка из карточки убирает строку из списка обновлений (и тост «обновлён», а не «Установлено») |
| `popularhdr.mjs` | рейл «Популярное сейчас» рисуется: запрос к `popular/apps` уходит С заголовком `RuStoreVerCode` (без него API отвечает 400) |
| `dlfallback.mjs` | `v3/download-link` ответил 200 без `downloadUrls` → идём в старый backapi-путь, а не падаем «RuStore не отдал ссылку» |
| `afterinstall.mjs` | после установки: кнопка в карточке меняется на «Открыть» (реактивность через `ST.rowBusy`) и приложение появляется во вкладке «Установленные» (`refreshInstalled`) |

Исторические тесты (жили в `/tmp`, потеряны при перезагрузке — воссоздавать по мере
надобности): `updlist` (список обновлений: 404/сеть/удаление), `updrace` (гонки
проверки), `installphase` (промис резолвится по `installed`, а не по открытию
установщика), `rowbusy` (занятость строки живёт в состоянии и переживает
перерисовку), `cardhail` (карточка размораживает и морозит обратно), `detailrace`,
`searchrace`, `backsentinel`, `selfupd`, `visjump2`.

Важно: `const`/`let` из `app.js` не видны через CDP (indirect eval) — проверять
через DOM. Стаб ставится через `Page.addScriptToEvaluateOnNewDocument`.

Важно-3: `window.Native.installApk` передаёт в натив **JSON-строку**
(`BT.installApk(JSON.stringify({...}))`), а не объект. Стаб `WebToApk.installApk`
обязан делать `JSON.parse`, иначе не найдёт `name`/`url` и «установка» молча
не применится (тест покажет «Установка не применилась»).

Важно-2: `Page.addScriptToEvaluateOnNewDocument` живёт до конца жизни процесса
браузера, а не таба. Стабы разных тестов протекают друг в друга — после теста со
стабом надо перезапускать chromium (иначе видно синтетические данные: имена вида
`APP-<pkg>` из стаба `cardupdremove.mjs`).

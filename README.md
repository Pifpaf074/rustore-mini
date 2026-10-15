# RuStore mini

Мини-клиент RuStore для Android: каталог, поиск, карточка приложения, отзывы и
обновление установленных приложений. Без рекламы, телеметрии и входа в аккаунт —
RuStore видит только ваш IP и UA WebView.

Web-UI вшит в APK и живёт в WebView; запросы к RuStore идут через нативный мост
(без CORS и preflight), скачивание — системный `DownloadManager`, установка —
`PackageInstaller`. Свой сервер нужен только чтобы раздавать APK и `version.json`
(самообновление приложения).

## Возможности

- **Каталог и поиск** — вкладки «Приложения» / «Игры», рейлы «Популярное» и
  подборки, поиск с подсказками.
- **Карточка приложения** — описание, скриншоты, «что нового», отзывы (только
  просмотр), установка / обновление / открытие.
- **Обновления** — какие из установленных приложений устарели. Список наполняется
  по ходу проверки, подпись сверяется (несовместимые исключаются), есть
  «Обновить все».
- **Установленные** — все пакеты с иконками, запуск и обновление; замороженные
  через [Hail](https://github.com/aistra0528/Hail) — отдельной секцией.
- **Мелочи** — тема (системная / светлая / тёмная), pull-to-refresh, системная
  кнопка «Назад» внутри приложения, самообновление самого APK.

## Сборка

Нужен только `git` — JDK 17 и Android SDK `make.sh` скачает сам.

```bash
git clone https://github.com/Jipok/web-to-app      /work/4   # апстрим-обёртка
git clone https://github.com/Pifpaf074/rustore-mini /work/rustore-mini
/work/rustore-mini/native/apply.sh /work/4                   # наложить наш слой
cd /work/4 && ./make.sh build confs/rustore/webapk.conf      # релиз: UI вшит в APK
# → /work/4/rustore.apk
```

`apply.sh` кладёт в дерево сборки конфиги, web-UI и нативные мосты. Если в дереве
лежит **ключ апстрима** — скрипт предупредит: для обновления по воздуху нужен свой
ключ подписи (`my-release-key.jks`).

Dev-сборка — UI тянется с сервера, правки видны без пересборки APK:

```bash
cd /work/4 && ./make.sh build confs/rustore-dev/webapk.conf
/work/rustore-mini/deploy.sh /work/rustore      # разложить web/* на сервер раздачи
```

Адрес сервера раздачи в репозитории не хранится: `web/app.js` берёт его из
`window.RS_VER_URL` (локальный `web/config.local.js`), dev-конфиг — из
`confs/rustore-dev/webapk.local.conf`; оба файла в `.gitignore`.

## Что где лежит

| Путь | Что |
|---|---|
| `web/` | UI: `index.html`, `app.js`, `native.js` (мост) + движок `incr.js` / `pre.js` |
| `confs/rustore/` | конфиг релиза (`site = site` — UI вшит), иконка, русские CA |
| `confs/rustore-dev/` | конфиг dev-сборки (UI с сервера, `DebugWebView`) |
| `native/` | нативная часть форка: `ApkInstaller`, `InstallResultReceiver`, `apply.sh`, патч |
| `rustore.py` | CLI к API RuStore: `search`, `info`, `url`, `download`, `trends`, `comments` |
| `tests/` | headless-тесты UI (chromium + CDP) |
| `docs/` | `api.md` — разбор API, `hail.md` — Hail, `alternatives.md` — другие варианты |
| `deploy.sh` | выкладка `web/*` на сервер раздачи |

CLI работает без зависимостей (только stdlib):

```bash
python3 rustore.py search flashlight
python3 rustore.py download com.one.tap.flashlight -o downloads
```

## Документация

- [`docs/api.md`](docs/api.md) — ручки RuStore, правила `ruStoreVerCode`, CORS, TLS
  картинок, curl-доказательства.
- [`native/README.md`](native/README.md) — что мы дописали в апстрим и зачем.
- [`docs/hail.md`](docs/hail.md) — заморозка приложений через Hail.
- [`tests/README.md`](tests/README.md) — как гонять headless-тесты.
- [`docs/alternatives.md`](docs/alternatives.md) — как ещё можно было сделать.

## Оговорки

API RuStore неофициальный — это reverse engineering, а не контракт: может меняться
без предупреждения. Платные приложения напрямую не скачиваются; у части приложений
APK отдаёт внешний источник (`aggregatorInfo`) — тогда прямой ссылки нет.
Скачивание APK сторонних приложений — вопрос лицензий, для личного использования
обычно ок. Подробности — в [`docs/api.md`](docs/api.md).

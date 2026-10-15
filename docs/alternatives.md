# Как ещё можно было сделать

Оценка вариантов «свой мини-стор поверх RuStore», сделанная до того, как проект
пошёл по варианту A (WebView-обёртка + свой web-UI). Оставлено как контекст.

## Android: как делать мини-апк

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

**Готовый гайд с кодом — в `native/README.md`** (и сам патч — `native/upstream-src.patch`).

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



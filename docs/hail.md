# Hail: заморозка приложений

Как мини-клиент видит замороженные приложения и как их морозит/размораживает.
Нативная часть моста — в `native/README.md`.

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


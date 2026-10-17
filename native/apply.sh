#!/bin/sh
# Накладывает оверлей «RuStore mini» на свежий checkout website-to-apk.
#
#   rustore-mini/native/apply.sh /work/5
#
# Делает три вещи (идемпотентно, ничего не удаляет):
#   1. git apply native/upstream-src.patch  — правки src/ + make.sh + default.conf
#   2. копирует ApkInstaller.java / InstallResultReceiver.java в src/java/
#   3. копирует confs/rustore{,-dev}/ и web/ (UI) в дерево сборки
#
# После перехода на более свежий апстрим патч надо перегенерировать:
#   см. «Переход на свежий апстрим» в native/README.md.
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
ROOT=${1:-}

[ -n "$ROOT" ] || { echo "usage: $0 <upstream-checkout>"; exit 2; }
[ -d "$ROOT/src/java" ] || { echo "ошибка: $ROOT не похож на checkout website-to-apk"; exit 2; }
[ -f "$ROOT/src/java/MainActivity.java" ] || { echo "ошибка: нет src/java/MainActivity.java"; exit 2; }

echo "== 1/3 патч апстрима =="
if git -C "$ROOT" apply --check "$HERE/upstream-src.patch" 2>/dev/null; then
    git -C "$ROOT" apply "$HERE/upstream-src.patch"
    echo "   применён"
elif git -C "$ROOT" apply --check --reverse "$HERE/upstream-src.patch" 2>/dev/null; then
    echo "   уже применён — пропускаю"
else
    echo "   ОШИБКА: патч не ложится (апстрим уехал). Перегенерируй native/upstream-src.patch."
    exit 1
fi

echo "== 2/3 нативные классы =="
cp "$HERE/ApkInstaller.java" "$HERE/InstallResultReceiver.java" "$ROOT/src/java/"
echo "   ApkInstaller.java, InstallResultReceiver.java"

echo "== 3/3 confs + UI =="
for c in rustore rustore-dev; do
    mkdir -p "$ROOT/confs/$c"
    cp -a "$REPO/confs/$c/." "$ROOT/confs/$c/"
    # Локальные значения (реальный домен раздачи и т.п.). Файл не в git;
    # дописываем в конец — cp выше каждый раз возвращает конфиг к репозиторному.
    if [ -f "$REPO/confs/$c/webapk.local.conf" ]; then
        cat "$REPO/confs/$c/webapk.local.conf" >> "$ROOT/confs/$c/webapk.conf"
    fi
done
mkdir -p "$ROOT/confs/rustore/site"
cp -a "$REPO/web/." "$ROOT/confs/rustore/site/"
echo "   confs/rustore{,-dev}/, confs/rustore/site/ (UI вшит)"

echo
echo "Готово. Сборка:"
echo "  cd $ROOT && ./make.sh build confs/rustore/webapk.conf"
echo
if [ -f "$ROOT/my-release-key.jks" ]; then
    FP=$(keytool -list -v -keystore "$ROOT/my-release-key.jks" -storepass 123456 2>/dev/null \
         | sed -n 's/.*SHA256: //p' | head -1 | tr -d ':' | tr 'A-Z' 'a-z')
    case "$FP" in
        db90782f6ffe0f4cdd1af0c019f2d48e2275e63abf070a582415733973e026c2)
            echo "Ключ подписи: наш (db90782f…) — самообновление сработает." ;;
        *)
            echo "ВНИМАНИЕ: ключ подписи НЕ наш ($FP)."
            echo "Скопируй наш: cp <старый-дерево>/my-release-key.jks $ROOT/my-release-key.jks" ;;
    esac
fi

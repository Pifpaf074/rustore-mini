#!/usr/bin/env bash
# Публикация релиза «RuStore mini» на GitHub Releases.
#
#   ./release.sh                   # собрать релиз в дереве сборки и опубликовать
#   ./release.sh путь/rustore.apk  # опубликовать готовый APK
#   NOTES="что нового" ./release.sh
#   MIRROR_DIR=/work/rustore ./release.sh   # ещё и положить копию на свой сервер
#
# В релиз попадают два ассета, имена важны — на них завязан автоапдейт:
#   rustore-mini.apk  — сам APK
#   version.json      — {versionCode, versionName, size, signer, url}
# Приложение читает https://github.com/<repo>/releases/latest/download/version.json
# и качает APK по url оттуда же (тоже .../releases/latest/download/...).
#
# Версия берётся из confs/rustore/webapk.conf — поднимите её перед релизом.
# Нужен авторизованный `gh` с правом на запись контента (fine-grained:
# Contents: Read and write; classic: scope `repo`) — иначе релизы дают 403.
set -euo pipefail
cd "$(dirname "$0")"

REPO="${REPO:-Pifpaf074/rustore-mini}"
TREE="${TREE:-/work/4}"
APK="${1:-}"
CONF="$TREE/confs/rustore/webapk.conf"

[ -f "$CONF" ] || { echo "нет конфига: $CONF (наложите native/apply.sh)" >&2; exit 1; }
ver_name=$(grep -m1 '^versionName' "$CONF" | cut -d= -f2- | tr -d ' \r')
ver_code=$(grep -m1 '^versionCode' "$CONF" | cut -d= -f2- | tr -d ' \r')
[ -n "$ver_name" ] && [ -n "$ver_code" ] || { echo "в конфиге нет versionName/versionCode" >&2; exit 1; }
tag="v$ver_name"
asset_url="https://github.com/$REPO/releases/latest/download/rustore-mini.apk"

if [ -z "$APK" ]; then
    echo "== сборка $ver_name ($ver_code) =="
    ( cd "$TREE" && ./make.sh build confs/rustore/webapk.conf )
    APK="$TREE/rustore.apk"
fi
[ -f "$APK" ] || { echo "нет файла: $APK" >&2; exit 1; }

build_tools=$(ls -d "$TREE"/cmdline-tools/build-tools/*/ 2>/dev/null | sort -V | tail -1)
[ -n "$build_tools" ] || { echo "не нашёл build-tools в $TREE/cmdline-tools" >&2; exit 1; }
signer=$("${build_tools}apksigner" verify --print-certs "$APK" | awk -F': ' '/SHA-256 digest/ {print $2; exit}')
size=$(stat -c%s "$APK")

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
cp "$APK" "$work/rustore-mini.apk"
printf '{"versionCode":%s,"versionName":"%s","size":%s,"signer":"%s","url":"%s"}\n' \
    "$ver_code" "$ver_name" "$size" "$signer" "$asset_url" > "$work/version.json"

echo "== $tag — $ver_name ($ver_code), $((size / 1024)) КиБ, signer ${signer:0:12}… =="
cat "$work/version.json"

if gh release view "$tag" --repo "$REPO" >/dev/null 2>&1; then
    gh release upload "$tag" "$work/rustore-mini.apk" "$work/version.json" --repo "$REPO" --clobber
    echo "релиз $tag обновлён"
else
    gh release create "$tag" "$work/rustore-mini.apk" "$work/version.json" \
        --repo "$REPO" --title "RuStore mini $ver_name" --latest \
        --notes "${NOTES:-Сборка $ver_name (versionCode $ver_code).}"
    echo "релиз $tag создан"
fi

# Копия на свой сервер: старые сборки ходят за version.json туда, а url внутри
# уже указывает на GitHub — так они один раз обновятся и переедут на GitHub.
if [ -n "${MIRROR_DIR:-}" ]; then
    mkdir -p "$MIRROR_DIR"
    cp "$work/rustore-mini.apk" "$MIRROR_DIR/rustore-mini.apk"
    cp "$work/version.json"      "$MIRROR_DIR/version.json"
    echo "зеркало обновлено: $MIRROR_DIR"
fi

echo
echo "Проверить: curl -sL $asset_url"

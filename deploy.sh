#!/usr/bin/env bash
# Деплой web-части «RuStore mini» — только для DEV-сборки
# (confs/rustore-dev, mainURL из локального webapk.local.conf).
#
# Релизный APK НЕ использует этот сервер для UI: сайт вшит в APK (site = site).
# Здесь же лежит только APK + version.json (для самообновления).
#
#   ./deploy.sh [DST]     DST по умолчанию /work/rustore
#
# Никакого версионирования/кэш-бастинга: сайт один и тот же, обновление UI —
# это просто перезапись файлов (dev-сборка читает их заново при старте).
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/web"
DST="${1:-/work/rustore}"

mkdir -p "$DST"
cp "$SRC/index.html" "$SRC/app.js" "$SRC/native.js" "$SRC/incr.js" "$SRC/pre.js" "$DST/"

echo "Deployed UI to $DST"
ls -l "$DST"

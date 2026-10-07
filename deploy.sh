#!/usr/bin/env bash
# Деплой web-части «RuStore mini» с авто-версионированием (без ручной правки версии).
#
#   ./deploy.sh [DST]     DST по умолчанию /work/rustore
#
# Что делает:
#   1) считает версию = sha256 от web/{index.html,app.js,incr.js,pre.js} (12 hex);
#   2) копирует incr.js/pre.js/app.js и index.html, подставляя:
#        <meta name="web-ver" content="ВЕРСИЯ">
#        src="incr.js?v=ВЕРСИЯ", src="pre.js?v=ВЕРСИЯ", data-src="app.js?v=ВЕРСИЯ"
#      → при смене контента меняются URL подресурсов, кэш не мешает;
#   3) обновляет web в client/version.json (поля APK сохраняются).
#
# Клиент сравнивает свою мету web-ver с version.json.web и делает hardReload при расхождении.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/web"
DST="${1:-/work/rustore}"

VER="$(cat "$SRC/index.html" "$SRC/app.js" "$SRC/incr.js" "$SRC/pre.js" | sha256sum | cut -c1-12)"

mkdir -p "$DST/client"
cp "$SRC/incr.js" "$SRC/pre.js" "$SRC/app.js" "$DST/"

sed -E \
  -e "s#(<meta name=\"web-ver\" content=\")[^\"]*(\")#\1${VER}\2#" \
  -e "s#(src=\"incr\.js)(\")#\1?v=${VER}\2#" \
  -e "s#(src=\"pre\.js)(\")#\1?v=${VER}\2#" \
  -e "s#(data-src=\"app\.js)(\")#\1?v=${VER}\2#" \
  "$SRC/index.html" > "$DST/index.html"

python3 - "$DST/client/version.json" "$VER" <<'PY'
import json, os, sys
p, ver = sys.argv[1], sys.argv[2]
j = {}
if os.path.exists(p):
    try:
        j = json.load(open(p))
    except Exception:
        j = {}
j["web"] = ver
with open(p, "w") as f:
    json.dump(j, f, ensure_ascii=False, separators=(",", ":"))
PY

echo "Deployed to $DST  (web=$VER)"

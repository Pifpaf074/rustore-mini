#!/usr/bin/env python3
"""
rustore.py - минимальный клиент RuStore (backapi.rustore.ru).

Проверено в октябре 2026. Использует только стандартную библиотеку.

Ключевые факты (см. README.md):
  * заголовок ruStoreVerCode=1000 - обязателен; гейт универсален для
    backapi / api / backapi-m: >=1105002 -> HTTP 419 (проверено 10.2026);
  * без "deviceType" - надёжнее всего;
  * download-link теперь есть и в НОВОМ API api.rustore.ru
    (/v3/showcase/apps/download-link, HARICA-TLS, без подписи);
    with withoutSplits=true -> единый .apk на глобально доверенном
    static.rustore.ru (обход "русского" CA у static-m);
  * версия 1000 -> static.rustore.ru, 1105001 -> static-m.rustore.ru;
  * картинки в overallInfo лежат на static-m.rustore.ru -> переписываем хост.

Использование:
    python3 rustore.py search "avito"
    python3 rustore.py info com.avito.android
    python3 rustore.py url com.avito.android
    python3 rustore.py download com.avito.android [-o dir]
    python3 rustore.py trends
    python3 rustore.py comments com.avito.android [--limit 10]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

API = "https://backapi.rustore.ru"
API_NEW = "https://api.rustore.ru"      # новый шлюз, HARICA-TLS, без подписи
VER = "1000"  # безопасный ruStoreVerCode (см. README)
UA = "rustore-mini/1.0"

# Заголовки, которые backapi принимает в CORS-preflight
# (access-control-allow-headers: rustorevercode, devicetype)
def _headers(json_body: bool = False) -> dict[str, str]:
    h = {
        "Accept": "application/json",
        "RuStoreVerCode": VER,
        "User-Agent": UA,
    }
    if json_body:
        h["Content-Type"] = "application/json"
    return h


def _get(path: str, params: dict | None = None) -> dict:
    url = API + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=_headers())
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    if data.get("code") != "OK" or not isinstance(data.get("body"), dict):
        raise RuntimeError(f"RuStore: {data.get('code')} {data.get('message')}")
    return data["body"]


def _post(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        API + path,
        data=json.dumps(payload).encode(),
        headers=_headers(json_body=True),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    if data.get("code") != "OK" or not isinstance(data.get("body"), dict):
        raise RuntimeError(f"RuStore: {data.get('code')} {data.get('message')}")
    return data["body"]


def _get_new(path: str, params: dict | None = None) -> dict:
    """Новый API (api.rustore.ru) отдаёт объект без обёртки {code,body}."""
    url = API_NEW + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=_headers())
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def _post_new(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        API_NEW + path,
        data=json.dumps(payload).encode(),
        headers=_headers(json_body=True),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def fix_img(url: str | None) -> str | None:
    """static-m.rustore.ru подписан Russian Trusted CA: браузеры/Android
    его не знают. Те же объекты доступны на static.rustore.ru."""
    if not url:
        return url
    return url.replace("//static-m.rustore.ru/", "//static.rustore.ru/")


def search(query: str, page: int = 0, size: int = 20) -> dict:
    return _get("/applicationData/apps",
                {"pageNumber": page, "pageSize": size, "query": query})


def info(package: str) -> dict:
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+", package):
        raise SystemExit(f"не похоже на package name: {package!r}")
    b = _get(f"/applicationData/overallInfo/{package}")
    b["iconUrl"] = fix_img(b.get("iconUrl"))
    for f in b.get("fileUrls") or []:
        f["fileUrl"] = fix_img(f.get("fileUrl"))
    return b


def download_link(app_id: int) -> dict:
    payload = {
        "appId": app_id,
        "firstInstall": True,
        "screenDensity": 480,
        "sdkVersion": 36,
        "withoutSplits": True,          # единый .apk вместо .zip-контейнера
        "supportedAbis": ["arm64-v8a"],
    }
    # Приоритет - новый API; старый backapi оставлен как фолбэк.
    try:
        return _post_new("/v3/showcase/apps/download-link", payload)
    except urllib.error.HTTPError:
        return _post("/applicationData/v2/download-link", payload)


def trends() -> dict:
    return _get_new("/v2/showcase/trends")


def comments(package: str, limit: int = 20, offset: int = 0) -> dict:
    return _get_new("/v2/showcase/comments/by-app",
                    {"packageName": package, "limit": limit, "offset": offset})


def resolve(package: str) -> tuple[dict, dict]:
    i = info(package)
    d = download_link(i["appId"])
    # Целостность: подпись сертификата должна совпадать
    if d.get("signature") and i.get("signature") and \
       d["signature"].lower() != i["signature"].lower():
        raise RuntimeError("signature mismatch: API отдал разные сертификаты!")
    return i, d


def cmd_search(args) -> None:
    b = search(args.query, size=args.limit)
    for a in b.get("content", []):
        print(f"{a['appId']:>12}  {a['packageName']:<45} "
              f"★{a.get('averageUserRating', 0):<4} {a['appName']}")


def cmd_info(args) -> None:
    i = info(args.package)
    print(json.dumps({
        "appId": i.get("appId"),
        "packageName": i.get("packageName"),
        "appName": i.get("appName"),
        "versionName": i.get("versionName"),
        "versionCode": i.get("versionCode"),
        "minSdkVersion": i.get("minSdkVersion"),
        "fileSize": i.get("fileSize"),
        "downloads": i.get("downloads"),
        "rating": i.get("averageUserRating") or i.get("rating"),
        "iconUrl": i.get("iconUrl"),
        "companyName": i.get("companyName"),
        "signature": i.get("signature"),
        "external": i.get("aggregatorInfo") is not None,
    }, ensure_ascii=False, indent=2))


def cmd_url(args) -> None:
    _, d = resolve(args.package)
    for u in d.get("downloadUrls", []):
        print(u["url"], u["size"])


def cmd_trends(args) -> None:
    for name in trends().get("content", []):
        print(name)


def cmd_comments(args) -> None:
    b = comments(args.package, limit=args.limit)
    for c in b.get("elements", []):
        who = (c.get("user") or {}).get("name", "?")
        txt = (c.get("comment") or c.get("text") or "").replace("\n", " ")
        print(f"★{c.get('appRating')}  {who}: {txt[:100]}")


def cmd_download(args) -> None:
    i, d = resolve(args.package)
    urls = d.get("downloadUrls") or []
    if len(urls) != 1:
        raise SystemExit("нет единого APK (возможно, split-бандл или внешний источник)")
    u = urls[0]
    if not u["url"].startswith("https://static.rustore.ru/"):
        print(f"! предупреждение: CDN не static.rustore.ru: {u['url']}", file=sys.stderr)
    os.makedirs(args.out, exist_ok=True)
    name = f"{i['packageName']}-{i['versionCode']}.apk"
    path = os.path.join(args.out, name)
    print(f"→ {path} ({u['size'] / 1048576:.1f} MB)")
    got = 0
    req = urllib.request.Request(u["url"], headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r, open(path, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            print(f"\r  {got / (1 << 20):8.1f} МБ", end="", file=sys.stderr)
    print(file=sys.stderr)
    if got != u["size"]:
        os.unlink(path)
        raise SystemExit(f"размер не совпал: {got} != {u['size']}")
    print("OK")


def main() -> None:
    p = argparse.ArgumentParser(description="минимальный клиент RuStore")
    sub = p.add_subparsers(required=True)

    s = sub.add_parser("search"); s.add_argument("query"); s.add_argument("--limit", type=int, default=20)
    s.set_defaults(fn=cmd_search)

    s = sub.add_parser("info"); s.add_argument("package"); s.set_defaults(fn=cmd_info)

    s = sub.add_parser("url"); s.add_argument("package"); s.set_defaults(fn=cmd_url)

    s = sub.add_parser("download"); s.add_argument("package"); s.add_argument("-o", "--out", default="downloads")
    s.set_defaults(fn=cmd_download)

    s = sub.add_parser("trends"); s.set_defaults(fn=cmd_trends)

    s = sub.add_parser("comments"); s.add_argument("package"); s.add_argument("--limit", type=int, default=20)
    s.set_defaults(fn=cmd_comments)

    a = p.parse_args()
    try:
        a.fn(a)
    except (urllib.error.HTTPError, urllib.error.URLError) as e:
        raise SystemExit(f"сеть: {e}")


if __name__ == "__main__":
    main()

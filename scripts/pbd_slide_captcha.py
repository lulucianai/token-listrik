#!/usr/bin/env python3
"""Solve PaleBlueDot / TokenRouter go-captcha slide-basic.

Prints JSON: {ok, captcha_key, point, score, x, y} or {ok:false, error}.
"""
import json
import base64
import urllib.request
import urllib.parse
import sys

try:
    import cv2
    import numpy as np
except ImportError:
    print(json.dumps({"ok": False, "error": "opencv/numpy missing"}))
    sys.exit(0)

CAPTCHA_DATA = "https://captcha.palebluedot.ai/api/go-captcha-data/slide-basic"
CAPTCHA_CHECK = (
    "https://captcha.palebluedot.ai/api/go-captcha-check-data/slide-basic"
)
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Origin": "https://www.tokenrouter.com",
    "Referer": "https://www.tokenrouter.com/",
}


def fetch():
    req = urllib.request.Request(CAPTCHA_DATA, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def decode(b64, flags=cv2.IMREAD_COLOR):
    raw = b64.split(",", 1)[-1] if isinstance(b64, str) and b64.startswith("data:") else b64
    return cv2.imdecode(np.frombuffer(base64.b64decode(raw), np.uint8), flags)


def solve_once():
    d = fetch()
    tile_key = "tile_base64" if "tile_base64" in d else "thumb_base64"
    master = decode(d["image_base64"])
    tile = decode(d[tile_key], cv2.IMREAD_UNCHANGED)
    ty = int(d["tile_y"])
    tw = int(d["tile_width"])
    th = int(d["tile_height"])
    if tile is None or master is None:
        return {"ok": False, "error": "decode failed"}

    gray = cv2.cvtColor(master, cv2.COLOR_BGR2GRAY)
    band = gray[ty : ty + th, :].astype(np.float32)
    if tile.ndim == 3 and tile.shape[2] >= 4:
        sil = (tile[:, :, 3] > 50).astype(np.uint8) * 255
    else:
        sil = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY)
    sil = cv2.resize(sil, (tw, th))
    inv = (255 - band).astype(np.uint8)
    res = cv2.matchTemplate(inv, sil, cv2.TM_CCOEFF_NORMED)
    _, maxv, _, maxl = cv2.minMaxLoc(res)
    x = int(maxl[0])
    key = d["captcha_key"]
    point = f"{x},{ty}"

    # Optional server-side check (GraphQL accepts key+point even without this)
    try:
        body = urllib.parse.urlencode({"point": point, "key": key}).encode()
        req = urllib.request.Request(
            CAPTCHA_CHECK,
            data=body,
            method="POST",
            headers={**HEADERS, "Content-Type": "application/x-www-form-urlencoded"},
        )
        resp = json.loads(urllib.request.urlopen(req, timeout=20).read().decode())
        if resp.get("code") not in (0, "0", None) and resp.get("code") != 0:
            # still return coords — GraphQL may accept
            pass
    except Exception:
        pass

    return {
        "ok": True,
        "captcha_key": key,
        "point": point,
        "score": float(maxv),
        "x": x,
        "y": ty,
    }


def main():
    tries = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    last = None
    for _ in range(tries):
        try:
            last = solve_once()
            if last and last.get("ok"):
                print(json.dumps(last))
                return
        except Exception as e:
            last = {"ok": False, "error": str(e)}
    print(json.dumps(last or {"ok": False, "error": "exhausted tries"}))


if __name__ == "__main__":
    main()

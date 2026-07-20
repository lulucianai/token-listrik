#!/usr/bin/env python3
"""Solve Yunwu go-captcha slide-basic; print JSON {ok, token} or {ok:false, error}."""
import json, base64, urllib.request, urllib.parse, sys

try:
    import cv2
    import numpy as np
except ImportError:
    print(json.dumps({"ok": False, "error": "opencv/numpy missing"}))
    sys.exit(0)

def fetch():
    with urllib.request.urlopen("https://yunwu.ai/api/go-captcha-data/slide-basic", timeout=30) as r:
        return json.loads(r.read().decode())

def decode(b64, flags=cv2.IMREAD_COLOR):
    return cv2.imdecode(np.frombuffer(base64.b64decode(b64), np.uint8), flags)

def solve_once():
    d = fetch()
    master = decode(d["image_base64"])
    tile = decode(d["thumb_base64"], cv2.IMREAD_UNCHANGED)
    ty = int(d["tile_y"])
    tw = int(d["tile_width"])
    th = int(d["tile_height"])
    if tile is None or tile.ndim < 3 or tile.shape[2] < 4:
        return None
    gray = cv2.cvtColor(master, cv2.COLOR_BGR2GRAY)
    band = gray[ty : ty + th, :].astype(np.float32)
    sil = (tile[:, :, 3] > 50).astype(np.uint8) * 255
    sil = cv2.resize(sil, (tw, th))
    inv = (255 - band).astype(np.uint8)
    res = cv2.matchTemplate(inv, sil, cv2.TM_CCOEFF_NORMED)
    _, maxv, _, maxl = cv2.minMaxLoc(res)
    x = int(maxl[0])
    body = urllib.parse.urlencode({"point": f"{x},{ty}", "key": d["captcha_key"]}).encode()
    req = urllib.request.Request(
        "https://yunwu.ai/api/go-captcha-check-data/slide-basic",
        data=body,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    resp = json.loads(urllib.request.urlopen(req, timeout=30).read().decode())
    if resp.get("code") == 0 and resp.get("token"):
        return {"ok": True, "token": resp["token"], "score": float(maxv), "x": x, "y": ty}
    return {"ok": False, "error": resp.get("message", "verify failed"), "score": float(maxv), "x": x}

def main():
    tries = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    last = None
    for i in range(tries):
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

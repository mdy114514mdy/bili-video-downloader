# -*- coding: utf-8 -*-
"""探测 B 站 playurl 的全部可用流（验证脚本逻辑/账号权限）"""
import hashlib, json, re, sys, time, http.cookiejar
import requests

BV = sys.argv[1] if len(sys.argv) > 1 else "BV1qM4y1w716"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
H = {"User-Agent": UA, "Referer": "https://www.bilibili.com/",
     "Origin": "https://www.bilibili.com"}

# ---- 用 Netscape cookies.txt ----
cj = http.cookiejar.MozillaCookieJar("cookies.txt")
cj.load(ignore_discard=True, ignore_expires=True)
s = requests.Session()
s.cookies = cj
s.headers.update(H)

MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,
         39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,
         6,63,57,62,11,36,20,34,44,52]

def mixin_key(orig):
    return "".join(orig[i] for i in MIXIN)[:32]

def wbi_sign(params, img_key, sub_key):
    key = mixin_key(img_key + sub_key)
    p = dict(params); p["wts"] = int(time.time())
    q = "&".join(f"{k}={requests.utils.quote(str(p[k]), safe='')}" for k in sorted(p))
    p["w_rid"] = hashlib.md5((q + key).encode()).hexdigest()
    return p

def get(url, **kw):
    r = s.get(url, timeout=20, **kw)
    try: return r.json()
    except Exception: return {"_raw": r.text[:400], "_status": r.status_code}

print("=== nav (登录态 / wbi key) ===")
nav = get("https://api.bilibili.com/x/web-interface/nav")
navd = nav.get("data", {})
print("code:", nav.get("code"), "isLogin:", navd.get("isLogin"),
      "vip:", (navd.get("vipStatus") == 1), "vipType:", navd.get("vipType"),
      "level:", navd.get("level_info", {}).get("current_level"),
      "uname:", navd.get("uname"))
img = re.sub(r".*/([^/]+)\.\w+$", r"\1", navd["wbi_img"]["img_url"])
sub = re.sub(r".*/([^/]+)\.\w+$", r"\1", navd["wbi_img"]["sub_url"])

print("\n=== view ===")
v = get(f"https://api.bilibili.com/x/web-interface/view?bvid={BV}")
d = v.get("data", {})
aid, cid, dur = d.get("aid"), d.get("cid"), d.get("duration")
print("code:", v.get("code"), "aid:", aid, "cid:", cid, "dur:", dur,
      "pages:", len(d.get("pages", [])), "title:", d.get("title"))
print("desc:", (d.get("desc") or "")[:120].replace("\n", " "))

print("\n=== playurl wbi (fnval=4048 全开) ===")
params = {"avid": aid, "bvid": BV, "cid": cid, "qn": 127, "fnver": 0,
          "fnval": 4048, "fourk": 1, "platform": "pc"}
r = get("https://api.bilibili.com/x/player/wbi/playurl", params=wbi_sign(params, img, sub))
print("code:", r.get("code"), "msg:", r.get("message"), "quality:", r.get("data", {}).get("quality"),
      "accept_desc:", r.get("data", {}).get("accept_description"))
dash = (r.get("data") or {}).get("dash") or {}
vinfo = dash.get("video") or []
ainfo = dash.get("audio") or []
print(f"video streams: {len(vinfo)}  audio streams: {len(ainfo)}")
print("dolby:", json.dumps(dash.get("dolby"), ensure_ascii=False)[:180])
print("flac:", bool(dash.get("flac")), "support_formats:", len(r.get("data", {}).get("support_formats") or []))

QN = {127: "8K", 126: "杜比视界", 125: "HDR", 120: "4K", 116: "1080P60", 112: "1080P+",
      80: "1080P", 74: "720P60", 64: "720P", 32: "480P", 16: "360P", 6: "240P"}

print("\n--- 视频轨 (按码率降序) ---")
vinfo.sort(key=lambda x: -x["bandwidth"])
for x in vinfo:
    est = x["bandwidth"] * dur / 8 / 1024 / 1024
    print(f"id={x['id']:<4}{QN.get(x['id'],'?'):<8} {x['width']}x{x['height']:<5} "
          f"fps={str(x.get('frameRate')):<6} {x['bandwidth']/1000:>8.0f} kbps  "
          f"codec={x.get('codecs',''):<18} ~{est:.1f} MB  host={x['baseUrl'].split('/')[2]}")

print("\n--- 音频轨 ---")
ainfo.sort(key=lambda x: -x["bandwidth"])
for x in ainfo:
    est = x["bandwidth"] * dur / 8 / 1024 / 1024
    print(f"id={x['id']:<4} {x['bandwidth']/1000:>6.0f} kbps  codec={x.get('codecs',''):<12} ~{est:.1f} MB")

if dash.get("flac"):
    f = dash["flac"]["audio"]
    print(f"FLAC(Hi-Res): {f['bandwidth']/1000:.0f} kbps  codec={f.get('codecs')}")

print("\n=== 测 CDN Range + Referer (取 4K 流前 1KB) ===")
if vinfo:
    u = vinfo[0]["baseUrl"]
    for label, hdrs in [("带 Referer", {"Referer": "https://www.bilibili.com/", "Range": "bytes=0-1023"}),
                        ("无 Referer", {"Range": "bytes=0-1023"})]:
        try:
            rr = requests.get(u, headers={**H, **hdrs}, timeout=20, stream=True)
            print(f"{label}: {rr.status_code}  Content-Range={rr.headers.get('Content-Range')}  "
                  f"len={len(rr.raw.read(1024))}  ACAO={rr.headers.get('Access-Control-Allow-Origin')}")
        except Exception as e:
            print(f"{label}: ERR {e}")

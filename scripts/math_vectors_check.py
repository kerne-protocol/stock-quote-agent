"""Recomputes the Worker's math vectors with the verifier's own integer math.

    node scripts/math-vectors.ts vectors.json
    python -I scripts/math_vectors_check.py vectors.json
"""
import importlib.util
import json
import math
import os
import sys

spec = importlib.util.spec_from_file_location("verify", os.path.join(os.path.dirname(os.path.abspath(__file__)), "verify.py"))
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)

d = json.load(open(sys.argv[1]))
POL = {"min_tenor_seconds": 259200, "expiry_anchor_unix": 144000, "expiry_period_seconds": 604800, "vol_markup_bps": 1000, "vol_floor_wad": "200000000000000000",
       "vol_cap_wad": "2000000000000000000", "target_z_wad": "841621233572914205", "strike_buffer_bps": 100}
bad = 0
worst = {"ln": 0.0, "exp": 0.0, "cdf": 0.0}
for x, y in d["ln"]:
    bad += str(v.ln_w(int(x))) != y
    worst["ln"] = max(worst["ln"], abs(int(y) / v.WAD - math.log(int(x) / v.WAD)))
for x, y in d["exp"]:
    bad += str(v.exp_w(int(x))) != y
    worst["exp"] = max(worst["exp"], abs(int(y) / v.WAD / math.exp(int(x) / v.WAD) - 1))
for x, y in d["cdf"]:
    bad += str(v.norm_cdf_w(int(x))) != y
    worst["cdf"] = max(worst["cdf"], abs(int(y) / v.WAD - 0.5 * math.erfc(-int(x) / v.WAD / math.sqrt(2))))
for x, y in d["sqrt"]:
    bad += str(v.sqrt_w(int(x))) != y
for t, e in d["expiry"]:
    bad += v.next_expiry(t, POL) != e
    import datetime
    dt = datetime.datetime.fromtimestamp(e, datetime.timezone.utc)
    bad += not (dt.weekday() == 4 and dt.hour == 16 and dt.minute == 0 and 259200 <= e - t < 259200 + 604800)
for spot, vol, ts, mo, mp, want in d["price"]:
    got = v.price_call(int(spot), 8, int(vol), ts, POL, mo, mp)
    bad += got != want
for rounds, block_ts, want in d["vol"]:
    rs = [(int(i), int(a), t) for i, a, t in rounds]
    ws = block_ts - 14 * 86400
    idx = max([k for k, r in enumerate(rs) if r[2] <= ws], default=None)
    trunc = idx is None
    used = rs if trunc else rs[idx:]
    start = used[0][2] if trunc else ws
    total, ann, vol = v.realized_vol(used, block_ts - start)
    got = {"window_start": start, "window_seconds": block_ts - start, "truncated": trunc, "anchor": str(used[0][0]),
           "returns": len(used) - 1, "sum": str(total), "ann": str(ann), "vol": str(vol)}
    bad += got != want
n = sum(len(x) for x in d.values())
print(f"{n} vectors, {bad} mismatches; worst error vs float: ln {worst['ln']:.2e} abs, exp {worst['exp']:.2e} rel, cdf {worst['cdf']:.2e} abs")
sys.exit(1 if bad else 0)

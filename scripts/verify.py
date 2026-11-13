"""Independent verifier for the Kerne stock quote agent (schema kerne-stock-quote v1).

Shares no code with the Worker. Needs Python 3.9+ and `pip install eth-account`.

    python -I verify.py [URL]

What it checks:
 1. sha256(signed_payload_canonical) equals attestation_hash
 2. the EIP-191 signature over that hash recovers to the published signer
 3. every displayed field equals the signed field
 4. the inputs are real: re-reads the Chainlink rounds and the vault bounds at the signed
    block on a different public RPC and compares them
 5. the numbers follow from the inputs: recomputes realized volatility, expiry, strike and
    premium with its own integer math and compares to the last digit
 6. the EIP-712 signature a contract would check recovers to the same signer

The quote is a REFERENCE. Passing these checks means the quote is authentic and follows the
published rule. It does not mean the price is right.
"""
import hashlib
import json
import math
import sys
import time
import urllib.request

TRUST_ROOT = "0x9653Bf177239C979921DC8C0639eD00409F4Db88"  # the agent's only signing key
DEFAULT_URL = "https://kerne-stock-quote.r4woutreach.workers.dev/api/quote"
RPCS = [
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
    "https://base.drpc.org",
    "https://1rpc.io/base",
    "https://gateway.tenderly.co/public/base",
]
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
YEAR = 31_536_000

# ------------------------------------------------------------------ integer math
WAD = 10**18
LN2 = 693147180559945309
INV_SQRT_2PI = 398942280401432678


def tdiv(a, b):
    """Integer division that truncates toward zero (Python's // floors instead)."""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


def mul_w(a, b):
    return tdiv(a * b, WAD)


def div_w(a, b):
    return tdiv(a * WAD, b)


def sqrt_w(x):
    return math.isqrt(x * WAD)


def ln_w(x):
    assert x > 0
    k, y = 0, x
    while y >= 3 * WAD // 2:
        y, k = y // 2, k + 1
    while y < 3 * WAD // 4:
        y, k = y * 2, k - 1
    z = div_w(y - WAD, y + WAD)
    z2 = mul_w(z, z)
    term, total, n = z, 0, 0
    while n < 40 and term != 0:
        total += tdiv(term, 2 * n + 1)
        term = mul_w(term, z2)
        n += 1
    return k * LN2 + 2 * total


def exp_w(x):
    assert -40 * WAD <= x <= 40 * WAD
    k = tdiv(2 * x + LN2, 2 * LN2) if x >= 0 else tdiv(2 * x - LN2, 2 * LN2)
    r = x - k * LN2
    term, total, n = WAD, WAD, 1
    while n <= 30 and term != 0:
        term = tdiv(mul_w(term, r), n)
        total += term
        n += 1
    return total * (1 << k) if k >= 0 else tdiv(total, 1 << -k)


def norm_cdf_w(x):
    if x < 0:
        return WAD - norm_cdf_w(-x)
    p = 231641900000000000
    b = [319381530000000000, -356563782000000000, 1781477937000000000, -1821255978000000000, 1330274429000000000]
    t = div_w(WAD, WAD + mul_w(p, x))
    poly = b[4]
    for coeff in (b[3], b[2], b[1], b[0]):
        poly = coeff + mul_w(poly, t)
    poly = mul_w(poly, t)
    pdf = mul_w(exp_w(-tdiv(mul_w(x, x), 2)), INV_SQRT_2PI)
    return WAD - mul_w(pdf, poly)


def ceil_div(a, b):
    return (a + b - 1) // b


def next_expiry(t, pol):
    anchor, period = pol["expiry_anchor_unix"], pol["expiry_period_seconds"]
    n = -((-(t + pol["min_tenor_seconds"] - anchor)) // period)
    return anchor + n * period


def realized_vol(rounds, window_seconds):
    """rounds: [(id, answer, updatedAt)] with the anchor first."""
    total = 0
    for (_, a, _), (_, b, _) in zip(rounds, rounds[1:]):
        if a <= 0 or b <= 0:  # the agent stops summing at the first non-positive answer
            break
        r = ln_w(div_w(b, a))
        total += mul_w(r, r)
    ann = total * YEAR // window_seconds if window_seconds > 0 else 0
    return total, ann, sqrt_w(ann)


def price_call(spot, decimals, vol, block_ts, pol, min_otm_bps, min_premium_bps):
    expiry = next_expiry(block_ts, pol)
    tenor = expiry - block_ts
    priced = vol * (10_000 + pol["vol_markup_bps"]) // 10_000
    priced = max(int(pol["vol_floor_wad"]), min(int(pol["vol_cap_wad"]), priced))
    sd = mul_w(priced, sqrt_w(tenor * WAD // YEAR))
    half_var = mul_w(sd, sd) // 2
    target = spot * exp_w(mul_w(int(pol["target_z_wad"]), sd) + half_var) // WAD
    floor = ceil_div(spot * (10_000 + min_otm_bps + pol["strike_buffer_bps"]), 10_000)
    step = 10**decimals
    strike = ceil_div(max(target, floor), step) * step
    d1 = div_w(ln_w(div_w(spot, strike)) + half_var, sd)
    d2 = d1 - sd
    c = max(0, norm_cdf_w(d1) - mul_w(div_w(strike, spot), norm_cdf_w(d2)))
    model = ceil_div(c * 10_000, WAD)
    return {
        "expiry": expiry, "tenor_seconds": tenor, "priced_vol_wad": str(priced), "sd_wad": str(sd),
        "strike_raw": str(strike), "strike_bound": "delta_target" if target >= floor else "vault_floor_plus_buffer",
        "strike_otm_bps": (strike - spot) * 10_000 // spot, "d1_wad": str(d1), "call_delta_wad": str(norm_cdf_w(d1)),
        "premium_fraction_wad": str(c), "model_premium_bps": model, "premium_bps": max(model, min_premium_bps),
        "premium_floor_applied": max(model, min_premium_bps) != model,
    }


# ------------------------------------------------------------------ chain reads
def http_json(url, data=None):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                 headers={"content-type": "application/json", "user-agent": "quote-verify"})
    return json.load(urllib.request.urlopen(req, timeout=25))


class Rpc:
    def __init__(self, avoid_host):
        self.urls = [u for u in RPCS if avoid_host not in u] or RPCS
        self.used = None

    def call(self, method, params):
        last = None
        for _ in range(2):
            for u in ([self.used] if self.used else []) + self.urls:
                try:
                    r = http_json(u, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
                    if "error" in r or r.get("result") is None:
                        raise RuntimeError(str(r.get("error"))[:120])
                    self.used = u
                    return r["result"]
                except Exception as e:  # noqa: BLE001
                    last = e
                    self.used = None
            time.sleep(2)
        raise last


def p32(h):
    return h.lower().rjust(64, "0")


def aggregate3(rpc, calls, block):
    elems = []
    for to, data in calls:
        d = data[2:]
        elems.append(p32(to[2:]) + p32("1") + p32("60") + p32(hex(len(d) // 2)[2:]) + d.ljust(-(-len(d) // 64) * 64, "0"))
    off, offs = len(calls) * 32, []
    for e in elems:
        offs.append(p32(hex(off)[2:]))
        off += len(e) // 2
    data = "0x82ad56cb" + p32("20") + p32(hex(len(calls))[2:]) + "".join(offs) + "".join(elems)
    h = rpc.call("eth_call", [{"to": MULTICALL3, "data": data}, hex(block)])[2:]
    w = lambda o: int(h[o * 2:o * 2 + 64], 16)  # noqa: E731
    arr = w(0)
    assert w(arr) == len(calls), "multicall length mismatch"
    base, out = arr + 32, []
    for i in range(len(calls)):
        el = base + w(base + i * 32)
        do = el + w(el + 32)
        out.append((w(el) == 1, h[(do + 32) * 2:(do + 32 + w(do)) * 2]))
    return out


def word(data, i, signed=False):
    v = int(data[i * 64:(i + 1) * 64], 16)
    return v - (1 << 256) if signed and v >> 255 else v


# ------------------------------------------------------------------ main
def main():
    from eth_account import Account
    from eth_account.messages import encode_defunct, encode_typed_data

    global TRUST_ROOT
    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
    if len(sys.argv) > 2:  # only for testing a local build signed by a throwaway key
        TRUST_ROOT = sys.argv[2]
        print("NOTE: trust root overridden on the command line:", TRUST_ROOT)
    doc = http_json(url)
    results = []

    def check(name, ok, detail=""):
        results.append(ok)
        print(("PASS " if ok else "FAIL ") + name + (("  " + str(detail)) if detail else ""))

    canonical = doc["signed_payload_canonical"]
    p = json.loads(canonical)
    print("label:", p["label"])
    print("status:", p["status"], "| sequence", p["sequence"], "| signed", p["timestamp"])

    h = "0x" + hashlib.sha256(canonical.encode()).hexdigest()
    check("1 sha256(canonical) == attestation_hash", h == doc["attestation_hash"], h)
    rec = Account.recover_message(encode_defunct(hexstr=doc["attestation_hash"]), signature=doc["signature"])
    check("2 EIP-191 signature recovers to the trust root", rec == TRUST_ROOT and p["signer"] == TRUST_ROOT, rec)
    check("3 displayed fields == signed fields", all(doc.get(k) == v for k, v in p.items()))
    check("3 canonical form is canonical", json.dumps(p, sort_keys=True, separators=(",", ":")) == canonical)

    if p["chain"] is None:
        print("no chain read in this attestation:", p.get("read_errors"))
        return finish(results)

    pol, ch, spot, rv, vb, mk = p["policy"], p["chain"], p["spot"], p["realized_vol"], p["vault_bounds"], p["market"]
    block, block_ts = ch["block_number"], ch["block_timestamp"]
    rpc = Rpc(ch["rpc_host"])
    blk = rpc.call("eth_getBlockByNumber", [hex(block), False])
    check("4 block hash and timestamp match", blk["hash"] == ch["block_hash"] and int(blk["timestamp"], 16) == block_ts,
          f"block {block} via {rpc.used} (the agent used {ch['rpc_host']})")

    feed, vault = mk["feed"], mk["vault"]
    names = ["minOtmBps", "minPremiumBps", "minDuration", "maxDuration", "maxStaleness", "epochLive", "salesPaused",
             "currentEpoch", "depositCap", "lastSettledAt", "idleWindow", "keeper", "feed", "asset", "buyMaxStaleness", "totalAssets"]
    sels = ["0x90787d8e", "0xd8fcb368", "0x56715761", "0x6db5c8fd", "0x87cf4696", "0x17627ce9", "0xb6b97664",
            "0x76671808", "0xdbd5edc7", "0x20456ad8", "0x18479a84", "0xaced1661", "0x37a7b7d8", "0x38d52e0f", "0x606d66ef", "0x01e1d114"]
    res = aggregate3(rpc, [(feed, "0xfeaf968c"), (feed, "0x313ce567")] + [(vault, s) for s in sels], block)
    lr = res[0][1]
    check("4 spot is the feed's latest round at that block",
          str(word(lr, 0)) == spot["round_id"] and str(word(lr, 1, True)) == spot["price_raw"] and word(lr, 3) == spot["updated_at"]
          and word(res[1][1], 0) == spot["decimals"] and spot["age_seconds"] == block_ts - spot["updated_at"],
          f"{spot['price']} at round {spot['round_id']}, {spot['age_seconds']}s old")
    vr = {n: (word(r[1], 0) if r[0] and len(r[1]) >= 64 else None) for n, r in zip(names, res[2:])}
    same_vault = (
        vr["minOtmBps"] == vb["min_otm_bps"] and vr["minPremiumBps"] == vb["min_premium_bps"]
        and vr["minDuration"] == vb["min_duration_seconds"] and vr["maxDuration"] == vb["max_duration_seconds"]
        and vr["maxStaleness"] == vb["max_staleness_seconds"] and vr["buyMaxStaleness"] == vb["buy_max_staleness_seconds"] and bool(vr["epochLive"]) == vb["epoch_live"]
        and bool(vr["salesPaused"]) == vb["sales_paused"] and vr["currentEpoch"] == vb["current_epoch"]
        and str(vr["depositCap"]) == vb["deposit_cap_raw"] and vr["lastSettledAt"] == vb["last_settled_at"]
        and vr["idleWindow"] == vb["idle_window_seconds"] and vr["keeper"] == int(vb["keeper"], 16)
        and vr["feed"] == int(feed, 16) and vr["asset"] == int(mk["stock_token"], 16)
        and (vb["total_assets_raw"] is None or vr["totalAssets"] is None or str(vr["totalAssets"]) == vb["total_assets_raw"])
    )
    check("4 vault bounds match the vault at that block", same_vault,
          f"min OTM {vb['min_otm_bps']} bps, min premium {vb['min_premium_bps']} bps, could_open_now={vb['could_open_now']}")

    anchor, last = int(rv["anchor_round_id"]), int(rv["last_round_id"])
    ids = list(range(anchor - 1, last + 1)) if (anchor & ((1 << 64) - 1)) > 1 else list(range(anchor, last + 1))
    rr = aggregate3(rpc, [(feed, "0x9a6fc8f5" + p32(hex(i)[2:])) for i in ids], block)
    allr = [(i, word(d, 1, True), word(d, 3)) for i, (ok, d) in zip(ids, rr) if ok and len(d) >= 320]
    rounds = [r for r in allr if r[0] >= anchor]
    before = [r for r in allr if r[0] < anchor]
    digest = "0x" + hashlib.sha256("\n".join(f"{i}:{a}:{t}" for i, a, t in rounds).encode()).hexdigest()
    check("4 the rounds used are the feed's rounds", len(rounds) == last - anchor + 1 and digest == rv["rounds_sha256"]
          and str(last) == spot["round_id"], f"{len(rounds)} rounds re-read")
    if rv["truncated"]:
        window_ok = rv["window_start"] == rounds[0][2] and (not before or last - anchor + 1 == pol["max_rounds_read"])
    else:
        window_ok = (rv["window_start"] == block_ts - pol["lookback_seconds"] and rounds[0][2] <= rv["window_start"]
                     and (len(rounds) < 2 or rounds[1][2] > rv["window_start"]))
    check("5 window and anchor follow the rule", window_ok and rv["window_end"] == block_ts
          and rv["window_seconds"] == block_ts - rv["window_start"] and rv["returns"] == len(rounds) - 1,
          f"{rv['window_seconds']}s, {rv['returns']} returns, truncated={rv['truncated']}")
    total, ann, vol = realized_vol(rounds, rv["window_seconds"])
    check("5 realized volatility recomputed", str(total) == rv["sum_squared_log_returns_wad"]
          and str(ann) == rv["annualized_variance_wad"] and str(vol) == rv["annualized_vol_wad"],
          f"{vol / WAD * 100:.2f}% annualized (float cross-check {float_vol(rounds, rv['window_seconds']) * 100:.2f}%)")

    q = p["quote"]
    # The agent's gates, in the agent's order. A quote may only exist when none of them trips.
    bad_round = any(a <= 0 for _, a, _ in rounds)
    if int(spot["price_raw"]) <= 0:
        expect = "NO_QUOTE_BAD_FEED_DATA"
    elif spot["age_seconds"] < 0 or spot["age_seconds"] > vb["max_staleness_seconds"]:
        expect = "NO_QUOTE_FEED_STALE"
    elif bad_round or rv["returns"] < pol["min_returns"] or rv["window_seconds"] < pol["min_window_seconds"]:
        expect = "NO_QUOTE_INSUFFICIENT_HISTORY"
    else:
        tenor = next_expiry(block_ts, pol) - block_ts
        expect = "QUOTE_OK" if vb["min_duration_seconds"] <= tenor <= vb["max_duration_seconds"] else "NO_QUOTE_OUT_OF_VAULT_BOUNDS"
    check("5 the status follows the agent's gates", p["status"] == expect, f"{p['status']} (expected {expect})")
    if p["status"] != "QUOTE_OK":
        check("5 a no-quote record carries no quote", q is None and p["onchain_quote"] is None, p["status_reason"])
        return finish(results)

    mine = price_call(int(spot["price_raw"]), spot["decimals"], vol, block_ts, pol, vb["min_otm_bps"], vb["min_premium_bps"])
    diffs = {k: (v, q.get(k)) for k, v in mine.items() if q.get(k) != v}
    check("5 expiry, strike and premium recomputed", not diffs, diffs or
          f"strike {q['strike']} ({q['strike_otm_bps']} bps OTM), premium {q['premium_bps']} bps, expiry {q['expiry_time']}")
    fl = float_premium(int(spot["price_raw"]), int(q["strike_raw"]), int(q["priced_vol_wad"]) / WAD, q["tenor_seconds"])
    check("5 float Black-Scholes cross-check within 0.01 bps", abs(fl - int(q["premium_fraction_wad"]) / WAD * 1e4) < 0.01, f"{fl:.4f} bps")
    floor = ceil_div(int(spot["price_raw"]) * (10_000 + vb["min_otm_bps"]), 10_000)
    check("5 quote is inside the vault's bounds", int(q["strike_raw"]) >= floor and q["premium_bps"] >= vb["min_premium_bps"]
          and vb["min_duration_seconds"] <= q["tenor_seconds"] <= vb["max_duration_seconds"]
          and q["valid_until"] == block_ts + pol["quote_ttl_seconds"] and q["sale_window_seconds"] == pol["sale_window_seconds"]
          and q["bound_to_round_id"] == spot["round_id"]
          and q["sellable_now"] == (spot["age_seconds"] <= vb["buy_max_staleness_seconds"]),
          f"sellable_now={q['sellable_now']}")

    oc = p["onchain_quote"]
    m = oc["message"]
    check("6 on-chain message equals the quote", m == {
        "vault": vault, "feed": feed, "roundId": spot["round_id"], "spot": spot["price_raw"], "strike": q["strike_raw"],
        "premiumBps": q["premium_bps"], "saleWindow": q["sale_window_seconds"], "expiry": q["expiry"], "validUntil": q["valid_until"]})
    typed = {
        "types": {
            "EIP712Domain": [{"name": "name", "type": "string"}, {"name": "version", "type": "string"}, {"name": "chainId", "type": "uint256"}],
            "Quote": [{"name": n, "type": t} for t, n in (f.split(" ") for f in oc["type"][len("Quote("):-1].split(","))],
        },
        "primaryType": "Quote",
        "domain": oc["domain"],
        "message": {**m, "roundId": int(m["roundId"]), "spot": int(m["spot"]), "strike": int(m["strike"])},
    }
    signable = encode_typed_data(full_message=typed)
    rec712 = Account.recover_message(signable, signature=oc["signature"])
    from eth_utils import keccak
    dg = "0x" + keccak(b"\x19\x01" + signable.header + signable.body).hex()
    check("6 EIP-712 signature recovers to the trust root", rec712 == TRUST_ROOT and dg == oc["digest"], rec712)

    age = int(time.time()) - block_ts
    print(f"quote age {age}s; valid_until is {'still ahead' if time.time() <= q['valid_until'] else 'past (a newer quote should exist)'}")
    return finish(results)


def float_vol(rounds, window_seconds):
    s = sum(math.log(b / a) ** 2 for (_, a, _), (_, b, _) in zip(rounds, rounds[1:]))
    return math.sqrt(s * YEAR / window_seconds)


def float_premium(spot, strike, vol, tenor):
    sd = vol * math.sqrt(tenor / YEAR)
    d1 = (math.log(spot / strike) + sd * sd / 2) / sd
    n = lambda x: 0.5 * math.erfc(-x / math.sqrt(2))  # noqa: E731
    return (n(d1) - strike / spot * n(d1 - sd)) * 1e4


def finish(results):
    ok = all(results)
    print("ALL OK" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

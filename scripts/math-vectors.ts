// Writes deterministic test vectors from the Worker's integer math to argv[2].
// scripts/math_vectors_check.py recomputes every one with the verifier's own math.
import { writeFileSync } from 'node:fs';
import { WAD, divW, expW, lnW, normCdfW, sqrtW } from '../src/fixed.ts';
import { nextExpiry, priceCall, realizedVol } from '../src/quote.ts';

let seed = 0x9e3779b97f4a7c15n;
const rnd = (): bigint => { // xorshift64*
  seed ^= seed >> 12n; seed ^= (seed << 25n) & 0xffffffffffffffffn; seed ^= seed >> 27n;
  return (seed * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
};
const between = (lo: bigint, hi: bigint): bigint => lo + (rnd() % (hi - lo + 1n));

const out: Record<string, unknown[]> = { ln: [], exp: [], cdf: [], sqrt: [], expiry: [], price: [], vol: [] };
for (let i = 0; i < 400; i++) {
  const x = i < 200 ? between(990n * WAD / 1000n, 1010n * WAD / 1000n) : between(1n, 5000n * WAD);
  out.ln!.push([x.toString(), lnW(x).toString()]);
  const e = between(-30n * WAD, 30n * WAD);
  out.exp!.push([e.toString(), expW(e).toString()]);
  const c = between(-8n * WAD, 8n * WAD);
  out.cdf!.push([c.toString(), normCdfW(c).toString()]);
  const s = between(0n, 10n ** 30n);
  out.sqrt!.push([s.toString(), sqrtW(s).toString()]);
  const t = Number(between(1_700_000_000n, 1_900_000_000n));
  out.expiry!.push([t, nextExpiry(t)]);
}
for (let i = 0; i < 400; i++) {
  const spot = between(5n * 10n ** 8n, 2000n * 10n ** 8n);
  const vol = between(5n * WAD / 100n, 3n * WAD);
  const ts = Number(between(1_790_000_000n, 1_800_000_000n));
  const minOtm = Number(between(1n, 2000n));
  const minPrem = Number(between(1n, 300n));
  const p = priceCall(spot, 8, vol, ts, minOtm, minPrem);
  out.price!.push([spot.toString(), vol.toString(), ts, minOtm, minPrem, {
    expiry: p.expiry, tenor_seconds: p.tenorSeconds, priced_vol_wad: p.pricedVolWad.toString(), sd_wad: p.sdWad.toString(),
    strike_raw: p.strike.toString(), strike_bound: p.strikeBound, strike_otm_bps: p.strikeOtmBps, d1_wad: p.d1Wad.toString(),
    call_delta_wad: p.deltaWad.toString(), premium_fraction_wad: p.premiumFractionWad.toString(),
    model_premium_bps: p.modelPremiumBps, premium_bps: p.premiumBps, premium_floor_applied: p.premiumFloorApplied,
  }]);
}
for (let i = 0; i < 40; i++) {
  const blockTs = 1_794_000_000 + i * 977;
  let t = blockTs - 20 * 86400;
  let price = between(50n * 10n ** 8n, 900n * 10n ** 8n);
  const rounds: Array<{ id: bigint; answer: bigint; updatedAt: number }> = [];
  let id = 36893488147419103232n + 1n;
  while (t < blockTs) {
    rounds.push({ id: id++, answer: price, updatedAt: t });
    price = (price * between(9900n, 10100n)) / 10000n;
    t += Number(between(30n, 20000n));
  }
  const v = realizedVol(rounds, blockTs);
  out.vol!.push([rounds.map((r) => [r.id.toString(), r.answer.toString(), r.updatedAt]), blockTs, {
    window_start: v.windowStart, window_seconds: v.windowSeconds, truncated: v.truncated, anchor: v.used[0]!.id.toString(),
    returns: v.returns, sum: v.sumSqWad.toString(), ann: v.annVarWad.toString(), vol: v.volWad.toString(),
  }]);
}
void divW;
writeFileSync(process.argv[2]!, JSON.stringify(out));
console.log('vectors written:', Object.entries(out).map(([k, v]) => `${k}=${v.length}`).join(' '));

// Integer fixed-point math, 18 decimals ("WAD"). No floats anywhere in the pricing path.
// Every division truncates toward zero (BigInt semantics). scripts/verify.py re-implements
// the same definitions with Python integers, so a quote can be recomputed to the last digit.

export const WAD = 10n ** 18n;
export const LN2 = 693147180559945309n; // ln(2) * 1e18, truncated
const INV_SQRT_2PI = 398942280401432678n; // 1/sqrt(2*pi) * 1e18, truncated

export const mulW = (a: bigint, b: bigint): bigint => (a * b) / WAD;
export const divW = (a: bigint, b: bigint): bigint => (a * WAD) / b;

/// floor(sqrt(n)) for n >= 0 (Newton).
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('isqrt of negative');
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/// sqrt of a WAD number, as a WAD number.
export const sqrtW = (x: bigint): bigint => isqrt(x * WAD);

/// Natural log of a positive WAD number.
/// Reduce x = y * 2^k with y in [0.75, 1.5), then ln(y) = 2 * atanh((y-1)/(y+1)) as an odd
/// power series, summed until the term truncates to zero (at most 40 terms).
export function lnW(x: bigint): bigint {
  if (x <= 0n) throw new Error('ln of non-positive');
  let k = 0n;
  let y = x;
  while (y >= (3n * WAD) / 2n) { y = y / 2n; k += 1n; }
  while (y < (3n * WAD) / 4n) { y = y * 2n; k -= 1n; }
  const z = divW(y - WAD, y + WAD);
  const z2 = mulW(z, z);
  let term = z;
  let sum = 0n;
  for (let n = 0n; n < 40n && term !== 0n; n++) {
    sum += term / (2n * n + 1n);
    term = mulW(term, z2);
  }
  return k * LN2 + 2n * sum;
}

/// e^x for a signed WAD number (|x| must stay under 40 WAD here).
/// k = round(x / ln2), r = x - k*ln2, Taylor series of e^r to 30 terms, then scale by 2^k.
export function expW(x: bigint): bigint {
  if (x > 40n * WAD || x < -40n * WAD) throw new Error('exp out of range');
  const k = x >= 0n ? (2n * x + LN2) / (2n * LN2) : (2n * x - LN2) / (2n * LN2);
  const r = x - k * LN2;
  let term = WAD;
  let sum = WAD;
  for (let n = 1n; n <= 30n && term !== 0n; n++) {
    term = mulW(term, r) / n;
    sum += term;
  }
  return k >= 0n ? sum * (1n << k) : sum / (1n << -k);
}

/// Standard normal CDF of a signed WAD number, Abramowitz and Stegun 26.2.17
/// (absolute error under 7.5e-8, which moves a premium by well under 0.01 basis points).
export function normCdfW(x: bigint): bigint {
  if (x < 0n) return WAD - normCdfW(-x);
  const P = 231641900000000000n;
  const B1 = 319381530000000000n;
  const B2 = -356563782000000000n;
  const B3 = 1781477937000000000n;
  const B4 = -1821255978000000000n;
  const B5 = 1330274429000000000n;
  const t = divW(WAD, WAD + mulW(P, x));
  let poly = B5;
  poly = B4 + mulW(poly, t);
  poly = B3 + mulW(poly, t);
  poly = B2 + mulW(poly, t);
  poly = B1 + mulW(poly, t);
  poly = mulW(poly, t);
  const pdf = mulW(expW(-(mulW(x, x) / 2n)), INV_SQRT_2PI);
  return WAD - mulW(pdf, poly);
}

/// Decimal string of raw / 10^decimals, exact, no float.
export function fmtUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, '0');
  return (neg ? '-' : '') + (v / base).toString() + (decimals > 0 ? '.' + frac : '');
}

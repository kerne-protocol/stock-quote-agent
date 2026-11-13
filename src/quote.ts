// The pricing agent's whole decision, as pure integer functions of on-chain inputs.
// Given the same block, anyone can recompute the same strike and premium (scripts/verify.py).

import type { Json } from './canonical.ts';
import { WAD, divW, expW, fmtUnits, lnW, mulW, normCdfW, sqrtW } from './fixed.ts';
import { EIP712_DOMAIN, QUOTE_TYPE, toChecksumAddress, type OnchainQuote } from './sign.ts';
import { MARKET, MAX_ROUNDS, asciiOnly, type ChainRead, type Round } from './reads.ts';

export const SCHEMA = 'kerne-stock-quote';
export const SCHEMA_VERSION = 1;
export const LABEL =
  'REFERENCE QUOTE ONLY. Not an offer, not a solicitation, not investment advice, not for US persons. ' +
  'Nothing executes from this quote automatically: the agent holds no funds and sends no transactions.';

const YEAR = 31_536_000n; // 365 days, calendar time for both the vol and the tenor

export const POLICY = {
  lookbackSeconds: 14 * 86400,
  minReturns: 30,
  minWindowSeconds: 5 * 86400,
  volMarkupBps: 1000, // the vault is the seller: price at realized vol times 1.10
  volFloorWad: 200000000000000000n, // 20%
  volCapWad: 2000000000000000000n, // 200%
  targetZWad: 841621233572914205n, // strike = spot*exp(z*sd + sd^2/2) has call delta N(-z) = 0.20
  strikeBufferBps: 100, // on top of the vault's minOtmBps, so a small rally does not close the sale
  minTenorSeconds: 3 * 86400,
  saleWindowSeconds: 86400,
  quoteTtlSeconds: 900, // one cron period, so two quotes on the same feed round barely overlap
  // Expiry is Friday 16:00 UTC, inside the regular US session all year. The vault settles on the
  // first feed round at or after expiry. The feed often writes nothing between the Friday close
  // and Monday 00:00 UTC, so an expiry at the close would settle on Monday's first print and carry
  // a weekend the premium did not price. At 16:00 UTC the next round came within the hour on each
  // of the three Fridays checked (2026-10-23, 10-30, 11-06).
  expiryAnchorUnix: 144_000, // 1970-01-02T16:00:00Z, a Friday
  expiryPeriodSeconds: 604_800,
} as const;

/// First Friday 16:00 UTC that is at least minTenorSeconds after `t`.
export function nextExpiry(t: number): number {
  const earliest = t + POLICY.minTenorSeconds;
  const n = Math.ceil((earliest - POLICY.expiryAnchorUnix) / POLICY.expiryPeriodSeconds);
  return POLICY.expiryAnchorUnix + n * POLICY.expiryPeriodSeconds;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export interface VolResult {
  ok: boolean;
  reason: string | null;
  windowStart: number;
  windowSeconds: number;
  truncated: boolean;
  used: Round[]; // anchor round first, then every round inside the window
  returns: number;
  sumSqWad: bigint;
  annVarWad: bigint;
  volWad: bigint;
}

/// Calendar-time realized volatility from Chainlink rounds.
/// The feed writes a round when the price has moved about 0.5%, so rounds are unevenly spaced.
/// Realized variance over the window = sum of squared log returns between consecutive rounds,
/// starting from the anchor (the last round at or before the window start, which is the price
/// at the window start because the feed holds its value). Annualized by 365d / window length.
export function realizedVol(rounds: Round[], blockTs: number): VolResult {
  let windowStart = blockTs - POLICY.lookbackSeconds;
  let idx = -1;
  for (let i = 0; i < rounds.length; i++) if (rounds[i]!.updatedAt <= windowStart) idx = i;
  let truncated = false;
  if (idx < 0) { idx = 0; truncated = true; windowStart = rounds[0]!.updatedAt; }
  const used = rounds.slice(idx);
  const windowSeconds = blockTs - windowStart;
  let sumSq = 0n;
  let bad = false;
  for (let i = 1; i < used.length; i++) {
    const a = used[i - 1]!.answer;
    const b = used[i]!.answer;
    if (a <= 0n || b <= 0n) { bad = true; break; }
    const r = lnW(divW(b, a));
    sumSq += mulW(r, r);
  }
  const returns = used.length - 1;
  const annVar = windowSeconds > 0 ? (sumSq * YEAR) / BigInt(windowSeconds) : 0n;
  let reason: string | null = null;
  if (bad) reason = 'a feed round in the window has a non-positive answer';
  else if (returns < POLICY.minReturns) reason = `only ${returns} returns in the window, need ${POLICY.minReturns}`;
  else if (windowSeconds < POLICY.minWindowSeconds) reason = `window is ${windowSeconds}s, need ${POLICY.minWindowSeconds}s`;
  return { ok: reason === null, reason, windowStart, windowSeconds, truncated, used, returns, sumSqWad: sumSq, annVarWad: annVar, volWad: sqrtW(annVar) };
}

export interface Priced {
  expiry: number;
  tenorSeconds: number;
  pricedVolWad: bigint;
  sdWad: bigint;
  strike: bigint;
  strikeBound: 'delta_target' | 'vault_floor_plus_buffer';
  strikeOtmBps: number;
  d1Wad: bigint;
  deltaWad: bigint;
  premiumFractionWad: bigint; // model call value as a fraction of notional, in the stock
  modelPremiumBps: number;
  premiumBps: number;
  premiumFloorApplied: boolean;
}

/// Black-Scholes call with zero rate and zero carry (the feed is total return per token and
/// both legs are paid in the stock), as a fraction of notional:
///   premium / notional = N(d1) - (K/S) * N(d2)
export function priceCall(spot: bigint, feedDecimals: number, volWad: bigint, blockTs: number, minOtmBps: number, minPremiumBps: number): Priced {
  const expiry = nextExpiry(blockTs);
  const tenorSeconds = expiry - blockTs;
  let pricedVol = (volWad * BigInt(10_000 + POLICY.volMarkupBps)) / 10_000n;
  if (pricedVol < POLICY.volFloorWad) pricedVol = POLICY.volFloorWad;
  if (pricedVol > POLICY.volCapWad) pricedVol = POLICY.volCapWad;
  const tW = (BigInt(tenorSeconds) * WAD) / YEAR;
  const sd = mulW(pricedVol, sqrtW(tW));
  const halfVar = mulW(sd, sd) / 2n;

  const target = (spot * expW(mulW(POLICY.targetZWad, sd) + halfVar)) / WAD;
  const floor = ceilDiv(spot * BigInt(10_000 + minOtmBps + POLICY.strikeBufferBps), 10_000n);
  const step = 10n ** BigInt(feedDecimals); // one whole dollar
  const strike = ceilDiv(target >= floor ? target : floor, step) * step;

  const d1 = divW(lnW(divW(spot, strike)) + halfVar, sd);
  const d2 = d1 - sd;
  let c = normCdfW(d1) - mulW(divW(strike, spot), normCdfW(d2));
  if (c < 0n) c = 0n;
  const model = Number(ceilDiv(c * 10_000n, WAD));
  const premiumBps = model > minPremiumBps ? model : minPremiumBps;
  return {
    expiry, tenorSeconds, pricedVolWad: pricedVol, sdWad: sd, strike,
    strikeBound: target >= floor ? 'delta_target' : 'vault_floor_plus_buffer',
    strikeOtmBps: Number(((strike - spot) * 10_000n) / spot),
    d1Wad: d1, deltaWad: normCdfW(d1), premiumFractionWad: c,
    modelPremiumBps: model, premiumBps, premiumFloorApplied: premiumBps !== model,
  };
}

const iso = (t: number) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
const pct = (wad: bigint) => fmtUnits((wad * 10_000n) / WAD, 2); // WAD fraction to percent, 2 dp, truncated

export interface BuildInput {
  now: Date;
  signer: string;
  signerValidFrom: string;
  chain: { ok: true; data: ChainRead } | { ok: false; errors: string[] };
  previousHash: string | null;
  sequence: number;
  roundsDigest: (lines: string) => Promise<string>;
}

export interface Built {
  pre: { [k: string]: Json };
  status: string;
  onchain: OnchainQuote | null;
}

type Ctx = Pick<BuildInput, 'now' | 'signer' | 'signerValidFrom' | 'previousHash' | 'sequence'>;

function basePayload(i: Ctx): { [k: string]: Json } {
  return {
    schema: SCHEMA,
    schema_version: SCHEMA_VERSION,
    label: LABEL,
    sequence: i.sequence,
    previous_attestation_hash: i.previousHash,
    timestamp: i.now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    unix_timestamp: Math.floor(i.now.getTime() / 1000),
    signer: i.signer,
    signer_valid_from: i.signerValidFrom,
    market: {
      symbol: MARKET.symbol,
      stock_token: MARKET.stockToken,
      feed: MARKET.feed,
      feed_description: MARKET.feedDescription,
      vault: MARKET.vault,
      chain_id: EIP712_DOMAIN.chainId,
    },
    policy: {
      vol_method: 'sum of squared log returns between consecutive Chainlink rounds over the lookback window, anchored at the last round at or before the window start, times 31536000 / window seconds, square root',
      lookback_seconds: POLICY.lookbackSeconds,
      max_rounds_read: MAX_ROUNDS,
      min_returns: POLICY.minReturns,
      min_window_seconds: POLICY.minWindowSeconds,
      vol_markup_bps: POLICY.volMarkupBps,
      vol_floor_wad: POLICY.volFloorWad.toString(),
      vol_cap_wad: POLICY.volCapWad.toString(),
      strike_rule: 'strike = spot * exp(z * sd + sd^2 / 2), sd = priced_vol * sqrt(tenor / 365d); raised to spot * (1 + (vault min_otm_bps + strike_buffer_bps) / 10000) if that is higher; rounded up to a whole dollar',
      target_z_wad: POLICY.targetZWad.toString(),
      target_call_delta: '0.20',
      strike_buffer_bps: POLICY.strikeBufferBps,
      premium_rule: 'premium_bps = ceil(10000 * (N(d1) - (strike / spot) * N(d2))), zero rate, zero carry, paid in the stock; never below the vault min_premium_bps',
      expiry_rule: 'first Friday 16:00 UTC at least min_tenor_seconds after the block timestamp, that is expiry_anchor_unix + k * expiry_period_seconds',
      expiry_anchor_unix: POLICY.expiryAnchorUnix,
      expiry_period_seconds: POLICY.expiryPeriodSeconds,
      min_tenor_seconds: POLICY.minTenorSeconds,
      sale_window_seconds: POLICY.saleWindowSeconds,
      quote_ttl_seconds: POLICY.quoteTtlSeconds,
      math: 'integer fixed point, 18 decimals, every division truncates toward zero; normal CDF is Abramowitz and Stegun 26.2.17',
    },
  };
}

/// A signed record for a cycle that failed for a reason the agent did not expect. Publishing the
/// failure beats publishing nothing: the hash chain keeps moving and the reason is public.
export function buildErrorPreSign(i: Ctx, reason: string): { [k: string]: Json } {
  return {
    ...basePayload(i), status: 'NO_QUOTE_INTERNAL_ERROR', status_reason: asciiOnly(reason).slice(0, 300),
    chain: null, spot: null, realized_vol: null, vault_bounds: null, quote: null, onchain_quote: null,
  };
}

/// Builds everything that gets signed, except the EIP-712 signature (added by the caller).
export async function buildPreSign(i: BuildInput): Promise<Built> {
  const base = basePayload(i);

  if (!i.chain.ok) {
    return {
      pre: { ...base, status: 'NO_QUOTE_READ_FAILED', status_reason: 'no public Base RPC answered this cycle', read_errors: i.chain.errors.slice(0, 14).map(asciiOnly), chain: null, spot: null, realized_vol: null, vault_bounds: null, quote: null, onchain_quote: null },
      status: 'NO_QUOTE_READ_FAILED', onchain: null,
    };
  }
  const c = i.chain.data;
  const v = c.vault;
  const spotAge = c.blockTimestamp - c.latest.updatedAt;
  const vol = realizedVol(c.rounds, c.blockTimestamp);
  const digest = await i.roundsDigest(vol.used.map((r) => `${r.id}:${r.answer}:${r.updatedAt}`).join('\n'));

  const blockers: string[] = [];
  if (v.epochLive) blockers.push('an epoch is live');
  if (v.salesPaused) blockers.push('sales are paused by the owner');
  if (v.lastSettledAt !== 0 && c.blockTimestamp < v.lastSettledAt + v.idleWindow) blockers.push(`exit window is open until ${iso(v.lastSettledAt + v.idleWindow)}`);
  if (v.totalAssets === null) blockers.push('vault assets could not be read on this RPC');
  else if (v.totalAssets === 0n) blockers.push('the vault holds no stock' + (v.depositCap === 0n ? ' (deposit cap is 0, the vault is closed)' : ''));

  const common: { [k: string]: Json } = {
    ...base,
    chain: { block_number: c.blockNumber, block_hash: c.blockHash, block_timestamp: c.blockTimestamp, block_time: iso(c.blockTimestamp), rpc_host: c.rpcHost },
    spot: {
      round_id: c.latest.id.toString(),
      price_raw: c.latest.answer.toString(),
      price: c.latest.answer > 0n ? fmtUnits(c.latest.answer, c.feedDecimals) : null,
      decimals: c.feedDecimals,
      updated_at: c.latest.updatedAt,
      age_seconds: spotAge,
    },
    realized_vol: {
      window_start: vol.windowStart,
      window_end: c.blockTimestamp,
      window_seconds: vol.windowSeconds,
      truncated: vol.truncated,
      truncated_note: vol.truncated ? (c.roundsReachPhaseStart ? 'the current feed phase is younger than the lookback' : `the lookback holds more than ${MAX_ROUNDS} rounds; the window starts at the oldest round read`) : null,
      anchor_round_id: vol.used[0]!.id.toString(),
      last_round_id: vol.used[vol.used.length - 1]!.id.toString(),
      returns: vol.returns,
      rounds_sha256: digest,
      sum_squared_log_returns_wad: vol.sumSqWad.toString(),
      annualized_variance_wad: vol.annVarWad.toString(),
      annualized_vol_wad: vol.volWad.toString(),
      annualized_vol_pct: pct(vol.volWad),
    },
    vault_bounds: {
      min_otm_bps: v.minOtmBps,
      min_premium_bps: v.minPremiumBps,
      min_duration_seconds: v.minDuration,
      max_duration_seconds: v.maxDuration,
      max_staleness_seconds: v.maxStaleness,
      buy_max_staleness_seconds: v.buyMaxStaleness,
      epoch_live: v.epochLive,
      sales_paused: v.salesPaused,
      current_epoch: v.currentEpoch,
      deposit_cap_raw: v.depositCap.toString(),
      total_assets_raw: v.totalAssets === null ? null : v.totalAssets.toString(),
      last_settled_at: v.lastSettledAt,
      idle_window_seconds: v.idleWindow,
      keeper: toChecksumAddress(v.keeper),
      keeper_note: 'the keeper sends openEpoch by hand; this agent is not the keeper and has no role on the vault',
      could_open_now: blockers.length === 0,
      open_blockers: blockers,
    },
  };

  const none = (status: string, reason: string): Built => ({
    pre: { ...common, status, status_reason: reason, quote: null, onchain_quote: null }, status, onchain: null,
  });
  if (c.latest.answer <= 0n) return none('NO_QUOTE_BAD_FEED_DATA', 'the latest feed answer is not positive');
  if (spotAge < 0 || spotAge > v.maxStaleness) {
    return none('NO_QUOTE_FEED_STALE', `the feed last updated ${spotAge}s ago and the vault refuses a spot older than ${v.maxStaleness}s (the feed is quiet when US markets are closed)`);
  }
  if (!vol.ok) return none('NO_QUOTE_INSUFFICIENT_HISTORY', vol.reason!);

  const p = priceCall(c.latest.answer, c.feedDecimals, vol.volWad, c.blockTimestamp, v.minOtmBps, v.minPremiumBps);
  if (p.tenorSeconds < v.minDuration || p.tenorSeconds > v.maxDuration || p.premiumBps >= 10_000) {
    return none('NO_QUOTE_OUT_OF_VAULT_BOUNDS', `tenor ${p.tenorSeconds}s or premium ${p.premiumBps} bps is outside what the vault accepts`);
  }
  const validUntil = c.blockTimestamp + POLICY.quoteTtlSeconds;
  const onchain: OnchainQuote = {
    vault: MARKET.vault, feed: MARKET.feed, roundId: c.latest.id, spot: c.latest.answer, strike: p.strike,
    premiumBps: BigInt(p.premiumBps), saleWindow: BigInt(POLICY.saleWindowSeconds), expiry: BigInt(p.expiry), validUntil: BigInt(validUntil),
  };
  return {
    pre: {
      ...common,
      status: 'QUOTE_OK',
      status_reason: null,
      quote: {
        expiry: p.expiry,
        expiry_time: iso(p.expiry),
        tenor_seconds: p.tenorSeconds,
        priced_vol_wad: p.pricedVolWad.toString(),
        priced_vol_pct: pct(p.pricedVolWad),
        sd_wad: p.sdWad.toString(),
        strike_raw: p.strike.toString(),
        strike: fmtUnits(p.strike, c.feedDecimals),
        strike_bound: p.strikeBound,
        strike_otm_bps: p.strikeOtmBps,
        d1_wad: p.d1Wad.toString(),
        call_delta_wad: p.deltaWad.toString(),
        premium_fraction_wad: p.premiumFractionWad.toString(),
        model_premium_bps: p.modelPremiumBps,
        premium_bps: p.premiumBps,
        premium_floor_applied: p.premiumFloorApplied,
        premium_per_1_stock: fmtUnits(ceilDiv(10n ** BigInt(c.feedDecimals) * BigInt(p.premiumBps), 10_000n), c.feedDecimals),
        sale_window_seconds: POLICY.saleWindowSeconds,
        sellable_now: spotAge <= v.buyMaxStaleness,
        sellable_note: 'the vault sells only while the feed price is at most buy_max_staleness_seconds old; an epoch can open on an older price (up to max_staleness_seconds) and sell once the feed moves again',
        valid_until: validUntil,
        valid_until_time: iso(validUntil),
        bound_to_round_id: c.latest.id.toString(),
      },
      onchain_quote: {
        domain: { name: EIP712_DOMAIN.name, version: EIP712_DOMAIN.version, chainId: EIP712_DOMAIN.chainId },
        primary_type: 'Quote',
        type: QUOTE_TYPE,
        message: {
          vault: MARKET.vault, feed: MARKET.feed, roundId: onchain.roundId.toString(), spot: onchain.spot.toString(), strike: onchain.strike.toString(),
          premiumBps: p.premiumBps, saleWindow: POLICY.saleWindowSeconds, expiry: p.expiry, validUntil,
        },
      },
    },
    status: 'QUOTE_OK',
    onchain,
  };
}

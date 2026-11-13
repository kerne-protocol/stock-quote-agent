import { canonicalize, type Json } from './canonical.ts';
import { addressFromPrivateKey, recoverHash, recoverQuote, sha256Hex, signHash, signQuote, type OnchainQuote } from './sign.ts';
import { readChain } from './reads.ts';
import { buildErrorPreSign, buildPreSign, LABEL, SCHEMA, SCHEMA_VERSION } from './quote.ts';
import { PAGE } from './page.ts';
import verifyPy from '../scripts/verify.py';
import keeperSol from '../contracts/src/KerneQuoteKeeper.sol';

export interface Env {
  QUOTE_KV: KVNamespace;
  QUOTE_SIGNING_KEY: string; // secret, never logged, never returned
  EXPECTED_SIGNER: string; // published trust root; the Worker refuses to sign under any other key
  SIGNER_VALID_FROM: string;
}

const CADENCE_SECONDS = 15 * 60;
const FRESH_SECONDS = 3 * CADENCE_SECONDS;
const HISTORY_KEEP_SECONDS = 60 * 60 * 24 * 120;

export interface StoredRecord {
  signed_payload_canonical: string;
  attestation_hash: string;
  signature: string;
  signer: string;
}

const histKey = (ts: number) => `h:${String(9_999_999_999 - ts).padStart(10, '0')}`;

/// One full cycle: read, price, sign twice, check both signatures, return the record.
/// Exported so scripts/local-cycle.ts runs exactly the code the cron runs.
export async function produce(key: string, expectedSigner: string, signerValidFrom: string, prev: StoredRecord | null): Promise<StoredRecord> {
  const signer = addressFromPrivateKey(key);
  if (signer.toLowerCase() !== expectedSigner.toLowerCase()) {
    throw new Error(`signing key does not match EXPECTED_SIGNER (${expectedSigner}); refusing to sign`);
  }
  const previousHash = prev ? prev.attestation_hash : null;
  const sequence = prev ? Number((JSON.parse(prev.signed_payload_canonical) as { sequence?: number }).sequence ?? 0) + 1 : 1;
  const ctx = { now: new Date(), signer, signerValidFrom, previousHash, sequence };
  let canonical: string;
  try {
    const chain = await readChain();
    const { pre, onchain } = await buildPreSign({ ...ctx, chain, roundsDigest: sha256Hex });
    if (onchain) {
      const { digest, signature } = signQuote(onchain, key);
      if (recoverQuote(onchain, signature).toLowerCase() !== signer.toLowerCase()) throw new Error('EIP-712 self-check failed');
      const oc = pre.onchain_quote as { [k: string]: Json };
      oc.digest = digest;
      oc.signature = signature;
    }
    canonical = canonicalize(pre);
  } catch (e) {
    // Never a quote on this path: a signed NO_QUOTE with the reason, so the cycle still leaves a record.
    canonical = canonicalize(buildErrorPreSign(ctx, String((e as Error)?.message ?? e)));
  }
  const attestation_hash = await sha256Hex(canonical);
  const signature = signHash(attestation_hash, key);
  if (recoverHash(attestation_hash, signature).toLowerCase() !== signer.toLowerCase()) throw new Error('EIP-191 self-check failed; not publishing');
  return { signed_payload_canonical: canonical, attestation_hash, signature, signer };
}

async function runCycle(env: Env): Promise<StoredRecord> {
  const prevRaw = await env.QUOTE_KV.get('latest');
  const record = await produce(env.QUOTE_SIGNING_KEY.trim(), env.EXPECTED_SIGNER, env.SIGNER_VALID_FROM, prevRaw ? (JSON.parse(prevRaw) as StoredRecord) : null);
  const ts = (JSON.parse(record.signed_payload_canonical) as { unix_timestamp: number }).unix_timestamp;
  const body = JSON.stringify(record);
  await env.QUOTE_KV.put(histKey(ts), body, { expirationTtl: HISTORY_KEEP_SECONDS });
  await env.QUOTE_KV.put('latest', body);
  return record;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra } });
}
const text = (body: string, type: string) =>
  new Response(body, { headers: { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'public, max-age=300', ...CORS } });

async function present(rec: StoredRecord, env: Env, liveRecover: boolean): Promise<Record<string, unknown>> {
  const payload = JSON.parse(rec.signed_payload_canonical) as Record<string, any>;
  const hashMatches = (await sha256Hex(rec.signed_payload_canonical)) === rec.attestation_hash;
  const signerMatches = rec.signer.toLowerCase() === env.EXPECTED_SIGNER.toLowerCase();
  let recovered: string | null = null;
  let recovered712: string | null = null;
  if (liveRecover) {
    try { recovered = recoverHash(rec.attestation_hash, rec.signature); } catch { recovered = null; }
    const oc = payload.onchain_quote;
    if (oc) {
      try {
        const m = oc.message;
        const q: OnchainQuote = {
          vault: m.vault, feed: m.feed, roundId: BigInt(m.roundId), spot: BigInt(m.spot), strike: BigInt(m.strike),
          premiumBps: BigInt(m.premiumBps), saleWindow: BigInt(m.saleWindow), expiry: BigInt(m.expiry), validUntil: BigInt(m.validUntil),
        };
        recovered712 = recoverQuote(q, oc.signature);
      } catch { recovered712 = null; }
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const age = now - Number(payload.unix_timestamp);
  const fresh = age <= FRESH_SECONDS;
  const validUntil = payload.quote ? Number(payload.quote.valid_until) : null;
  const expected = env.EXPECTED_SIGNER.toLowerCase();
  return {
    // Everything outside _meta is parsed from signed_payload_canonical, so what you read is what was signed.
    ...payload,
    attestation_hash: rec.attestation_hash,
    signature: rec.signature,
    signed_payload_canonical: rec.signed_payload_canonical,
    _meta: {
      note: 'Fields outside _meta are the signed payload. _meta is unsigned relay metadata computed at read time.',
      reference_only: LABEL,
      expected_signer: env.EXPECTED_SIGNER,
      signer_matches_expected: signerMatches,
      hash_matches: hashMatches,
      recovered_signer: liveRecover ? recovered : 'add ?verify=1 to recover both signers at the edge',
      recovered_onchain_quote_signer: liveRecover ? recovered712 : null,
      verified: liveRecover
        ? hashMatches && recovered?.toLowerCase() === expected && (payload.onchain_quote ? recovered712?.toLowerCase() === expected : true)
        : null,
      age_seconds: age,
      is_fresh: fresh,
      stale_note: fresh ? null : `This attestation is ${age}s old (cadence is 15 minutes). Treat it as last known, not current.`,
      quote_expired: validUntil === null ? null : now > validUntil,
      cadence: 'every 15 minutes (Cloudflare cron */15)',
      trust_root: '/api/signer',
      verify_yourself: {
        step_1: 'sha256(utf8 bytes of signed_payload_canonical) must equal attestation_hash',
        step_2_cast: `cast wallet verify --address ${env.EXPECTED_SIGNER} ${rec.attestation_hash} ${rec.signature}`,
        step_3: 'python -I verify.py (from /verify.py) re-reads the feed rounds at chain.block_number on another RPC and recomputes the volatility, strike and premium with its own integer math',
      },
    },
  };
}

function signerDoc(env: Env) {
  return {
    current_signer: env.EXPECTED_SIGNER,
    valid_from: env.SIGNER_VALID_FROM,
    role: 'Signs reference quotes for covered calls on Coinbase tokenized stocks. Nothing else.',
    holds_funds: false,
    onchain_roles: 'none. This address is not the keeper or the owner of the vault, has no allowance anywhere and has never sent a transaction.',
    is_proof_of_reserves_signer: false,
    key_custody: 'a Cloudflare Worker secret (write only). The Worker refuses to sign unless the key derives to current_signer.',
    schema: SCHEMA,
    schema_version: SCHEMA_VERSION,
    reference_only: LABEL,
  };
}

export default {
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCycle(env));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'access-control-max-age': '86400' } });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'method not allowed' }, 405);
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/') {
      return new Response(PAGE.replaceAll('__SIGNER__', env.EXPECTED_SIGNER), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-robots-tag': 'noindex' },
      });
    }
    if (path === '/api/quote' || path === '/latest.json') {
      const raw = await env.QUOTE_KV.get('latest');
      if (!raw) return json({ error: 'no quote has been produced yet', trust_root: '/api/signer' }, 503);
      return json(await present(JSON.parse(raw), env, url.searchParams.get('verify') === '1'), 200, { 'cache-control': 'public, max-age=30' });
    }
    if (path === '/api/quote/history') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 24) || 24, 1), 100);
      const list = await env.QUOTE_KV.list({ prefix: 'h:', limit });
      const items = (await Promise.all(list.keys.map(async (k) => {
        const v = await env.QUOTE_KV.get(k.name);
        return v ? (JSON.parse(v) as StoredRecord) : null;
      }))).filter(Boolean);
      return json({ count: items.length, newest_first: true, reference_only: LABEL, attestations: items }, 200, { 'cache-control': 'public, max-age=60' });
    }
    if (path === '/api/signer') return json(signerDoc(env), 200, { 'cache-control': 'public, max-age=300' });
    if (path === '/healthz') {
      const raw = await env.QUOTE_KV.get('latest');
      if (!raw) return json({ ok: false, reason: 'no quote yet' }, 503);
      const p = JSON.parse((JSON.parse(raw) as StoredRecord).signed_payload_canonical) as { unix_timestamp: number; status: string };
      const age = Math.floor(Date.now() / 1000) - p.unix_timestamp;
      return json({ ok: age <= FRESH_SECONDS, age_seconds: age, status: p.status }, age <= FRESH_SECONDS ? 200 : 503);
    }
    if (path === '/verify.py') return text(verifyPy, 'text/plain');
    if (path === '/KerneQuoteKeeper.sol') return text(keeperSol, 'text/plain');
    return json({ error: 'not found', endpoints: ['/', '/api/quote', '/api/quote?verify=1', '/api/quote/history?limit=24', '/api/signer', '/healthz', '/verify.py', '/KerneQuoteKeeper.sol'] }, 404);
  },
};

// Runs one full cycle locally with a THROWAWAY key (real public reads, real math, both
// signatures) and writes the record to argv[2]. It never touches the live key or KV.
// Imports the same modules the cron uses, but not index.ts (which bundles text assets).
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { canonicalize, type Json } from '../src/canonical.ts';
import { addressFromPrivateKey, recoverHash, recoverQuote, sha256Hex, signHash, signQuote } from '../src/sign.ts';
import { readChain } from '../src/reads.ts';
import { buildPreSign } from '../src/quote.ts';

const key = randomBytes(32).toString('hex');
const signer = addressFromPrivateKey(key);
const t0 = performance.now();
const chain = await readChain();
const t1 = performance.now();
const c0 = process.cpuUsage();
const { pre, onchain, status } = await buildPreSign({ now: new Date(), signer, signerValidFrom: '2026-11-12T00:00:00Z', chain, previousHash: null, sequence: 1, roundsDigest: sha256Hex });
const t2 = performance.now();
if (onchain) {
  const { digest, signature } = signQuote(onchain, key);
  if (recoverQuote(onchain, signature) !== signer) throw new Error('712 self-check failed');
  const oc = pre.onchain_quote as { [k: string]: Json };
  oc.digest = digest;
  oc.signature = signature;
}
const canonical = canonicalize(pre);
const h = await sha256Hex(canonical);
const sig = signHash(h, key);
if (recoverHash(h, sig) !== signer) throw new Error('191 self-check failed');
const t3 = performance.now();
const cpu = process.cpuUsage(c0);
console.log({ status, read_ms: (t1 - t0).toFixed(0), price_ms: (t2 - t1).toFixed(1), sign_ms: (t3 - t2).toFixed(1), cpu_ms_after_read: ((cpu.user + cpu.system) / 1000).toFixed(1), throwaway_signer: signer });
writeFileSync(process.argv[2]!, JSON.stringify({ ...JSON.parse(canonical), signed_payload_canonical: canonical, attestation_hash: h, signature: sig }, null, 2));

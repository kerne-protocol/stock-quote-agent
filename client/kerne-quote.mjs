// Fetch Kerne's signed TSLAc covered call quote and verify it in one call. Reference only: not an offer, not for US persons.
import { sha256, stringToBytes, recoverMessageAddress, recoverTypedDataAddress, isAddressEqual } from 'viem'

export const KERNE_QUOTE_URL = 'https://kerne-stock-quote.r4woutreach.workers.dev/api/quote'
export const KERNE_SIGNER = '0x9653Bf177239C979921DC8C0639eD00409F4Db88' // the trust root, also served at /api/signer
const DOMAIN = { name: 'KerneStockQuote', version: '1', chainId: 8453 }
const TYPES = { Quote: [['vault', 'address'], ['feed', 'address'], ['roundId', 'uint80'], ['spot', 'uint256'], ['strike', 'uint256'],
  ['premiumBps', 'uint32'], ['saleWindow', 'uint64'], ['expiry', 'uint64'], ['validUntil', 'uint64']].map(([name, type]) => ({ name, type })) }

export async function getKerneQuote({ url = KERNE_QUOTE_URL, maxAgeSeconds = 1800, fetchFn = fetch } = {}) {
  const res = await fetchFn(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`kerne quote: HTTP ${res.status}`)
  const { signed_payload_canonical: canonical, attestation_hash: hash, signature } = await res.json()
  if (typeof canonical !== 'string' || sha256(stringToBytes(canonical)) !== String(hash).toLowerCase()) throw new Error('kerne quote: hash mismatch')
  if (!isAddressEqual(await recoverMessageAddress({ message: { raw: hash }, signature }), KERNE_SIGNER)) throw new Error('kerne quote: not signed by Kerne')
  const q = JSON.parse(canonical) // from here on, only signed bytes are read
  const age = Math.floor(Date.now() / 1000) - q.unix_timestamp
  if (!(age <= maxAgeSeconds)) throw new Error(`kerne quote: stale (${age}s old)`)
  if (q.status !== 'QUOTE_OK') return { ok: false, status: q.status, reason: q.status_reason, ageSeconds: age, signed: q }
  const oc = q.onchain_quote, m = oc.message
  const message = { ...m, roundId: BigInt(m.roundId), spot: BigInt(m.spot), strike: BigInt(m.strike), premiumBps: m.premiumBps,
    saleWindow: BigInt(m.saleWindow), expiry: BigInt(m.expiry), validUntil: BigInt(m.validUntil) }
  const signer712 = await recoverTypedDataAddress({ domain: DOMAIN, types: TYPES, primaryType: 'Quote', message, signature: oc.signature })
  if (!isAddressEqual(signer712, KERNE_SIGNER)) throw new Error('kerne quote: typed quote not signed by Kerne')
  return {
    ok: true, symbol: q.market.symbol, vault: m.vault, ageSeconds: age, validUntil: m.validUntil, expired: Date.now() / 1000 > m.validUntil,
    spot: Number(m.spot) / 10 ** q.spot.decimals, strike: Number(m.strike) / 10 ** q.spot.decimals, premiumBps: m.premiumBps, expiry: q.quote.expiry_time,
    vaultOpen: q.vault_bounds.deposit_cap_raw !== '0', typed: { domain: DOMAIN, message, signature: oc.signature }, signed: q,
  }
}

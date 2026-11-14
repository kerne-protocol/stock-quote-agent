// node test.mjs : one live read, then the same record replayed with tampering. Every bad case must throw.
import { sha256, stringToBytes, recoverMessageAddress, hashTypedData } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { getKerneQuote, KERNE_QUOTE_URL, KERNE_SIGNER } from './kerne-quote.mjs'

let pass = 0, fail = 0
const ok = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`) }
const throws = async (name, fn, re) => { try { await fn(); ok(name, false) } catch (e) { ok(`${name} -> ${e.message}`, re.test(e.message)) } }

const raw = await (await fetch(KERNE_QUOTE_URL)).json()
const serve = (doc, status = 200) => async () => new Response(JSON.stringify(doc), { status })
const run = (doc, opts = {}) => getKerneQuote({ fetchFn: serve(doc), maxAgeSeconds: 1e12, ...opts })

const live = await getKerneQuote({ maxAgeSeconds: 3600 })
ok('live read verifies', live.ok === true || live.ok === false)
ok('live record is QUOTE_OK', live.ok === true)
if (live.ok) {
  const p = JSON.parse(raw.signed_payload_canonical)
  ok('strike equals signed raw strike', live.strike * 10 ** p.spot.decimals === Number(p.onchain_quote.message.strike))
  ok('premium equals signed premium', live.premiumBps === p.quote.premium_bps)
  ok('vault is the deployed vault', live.vault === '0xc6180E9af7Cb4c6D47A230a6c5047fA615Bd0956')
  ok('vaultOpen matches deposit cap', live.vaultOpen === (p.vault_bounds.deposit_cap_raw !== '0'))
  const t = live.typed
  ok('typed digest equals the published digest', hashTypedData({ domain: t.domain, primaryType: 'Quote',
    types: { Quote: p.onchain_quote.type.slice(6, -1).split(',').map(f => { const [type, name] = f.split(' '); return { name, type } }) },
    message: t.message }) === p.onchain_quote.digest)
  console.log(`     ${live.symbol} spot ${live.spot} strike ${live.strike} ${live.premiumBps} bps expiry ${live.expiry} age ${live.ageSeconds}s`)
}
ok('EIP-191 signer recovers to the pinned signer',
  (await recoverMessageAddress({ message: { raw: raw.attestation_hash }, signature: raw.signature })) === KERNE_SIGNER)

// Tampering: edit one digit of the signed body, keep the old hash.
const edited = raw.signed_payload_canonical.replace(/"premium_bps":(\d+)/, (_, n) => `"premium_bps":${Number(n) + 1}`)
ok('tamper target present', edited !== raw.signed_payload_canonical)
await throws('edited body, old hash', () => run({ ...raw, signed_payload_canonical: edited }), /hash mismatch/)
// Edit the body AND recompute the hash: the signature no longer matches.
await throws('edited body, new hash', () => run({ ...raw, signed_payload_canonical: edited, attestation_hash: sha256(stringToBytes(edited)) }), /not signed by Kerne/)
// A stranger signs a self-consistent fake end to end.
const stranger = privateKeyToAccount(generatePrivateKey())
const fakeHash = sha256(stringToBytes(edited))
await throws('stranger-signed record', async () => run({ signed_payload_canonical: edited, attestation_hash: fakeHash,
  signature: await stranger.signMessage({ message: { raw: fakeHash } }) }), /not signed by Kerne/)
await throws('garbage signature', () => run({ ...raw, signature: '0x' + '11'.repeat(65) }), /./)
await throws('missing canonical', () => run({ attestation_hash: raw.attestation_hash, signature: raw.signature }), /hash mismatch/)
await throws('HTTP 503', () => getKerneQuote({ fetchFn: serve(raw, 503) }), /HTTP 503/)
await throws('stale record', () => run(raw, { maxAgeSeconds: 1 }), /stale/)
// Unsigned _meta can say anything; the client never reads it.
const lies = await run({ ...raw, _meta: { verified: true, premium_bps: 9999 }, quote: { premium_bps: 9999 } })
ok('unsigned fields ignored', lies.ok && lies.premiumBps !== 9999)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

# Kerne quote client

One function that fetches the agent's latest TSLAc covered call quote and refuses to return it unless
it is genuine. 30 lines, one dependency (`viem`). Tested on Node 24; it needs nothing beyond `fetch`,
so any runtime that has `fetch` and runs viem should work.

**Reference quote only.** Not an offer, not investment advice, not for US persons. The vault it
prices for is deployed, closed to deposits and not audited. Nothing executes from a quote.

```js
import { getKerneQuote } from './kerne-quote.mjs'

const q = await getKerneQuote()
if (q.ok) console.log(q.symbol, q.spot, q.strike, q.premiumBps, q.expiry)
```

Copy `kerne-quote.mjs` into your project (`npm i viem`), or run it here:

```
cd client
npm ci
node example.mjs   # TSLAc: spot $389.7445, 86 bps for the $419 call to 2026-11-20T16:00:00Z, ...
node test.mjs      # live read plus tampered, re-hashed, stranger-signed and stale records
```

## What it checks before it returns anything

1. `sha256(signed_payload_canonical)` equals `attestation_hash`.
2. The EIP-191 signature over that hash recovers to the pinned signer
   `0x9653Bf177239C979921DC8C0639eD00409F4Db88` (also served at `/api/signer`).
3. Every value it returns is parsed from the signed bytes. The unsigned `_meta` block and any other
   field outside the signed payload are never read.
4. The quote is younger than `maxAgeSeconds` (default 30 minutes; the agent signs every 15).
5. For a priced quote, the EIP-712 `Quote` struct (domain `KerneStockQuote`, version 1, chain 8453)
   also recovers to the signer. `q.typed` holds the domain, message and signature in the form a
   contract can check with `ecrecover`.

Any failure throws. When the agent signs a "no quote" (feed silent over a weekend, too few rounds,
RPC down), you get `{ ok: false, status, reason }` instead of numbers.

## What you get back

| field | meaning |
| --- | --- |
| `ok` | `true` for a priced quote |
| `symbol`, `vault` | `TSLAc` and the vault the quote is for |
| `spot`, `strike` | dollars, from the Chainlink "Coinbase TSLA" feed round the quote is bound to |
| `premiumBps` | call premium in basis points of notional, paid in the stock |
| `expiry` | ISO time of the option's expiry (a Friday, 16:00 UTC) |
| `ageSeconds`, `validUntil`, `expired` | freshness; a quote is valid for 15 minutes |
| `vaultOpen` | `false` while the vault's deposit cap is 0 |
| `typed` | EIP-712 domain, message and signature |
| `signed` | the whole signed document (inputs, policy, vault limits, hash chain) |

Options: `getKerneQuote({ url, maxAgeSeconds, fetchFn })`. Pointing `url` at a mirror is safe: the
signature, not the host, is what is trusted.

To recompute the volatility, strike and premium from chain data yourself, use `../scripts/verify.py`.

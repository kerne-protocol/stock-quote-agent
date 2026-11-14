# Kerne stock quote agent

A pricing agent for covered calls on Coinbase tokenized stocks on Base. Every 15 minutes it reads the
Chainlink TSLA feed, measures realized volatility, prices next week's call for the
[Kerne covered call vault](https://kerne.fi/stocks), signs the result and publishes it with every
input it used.

**Reference quote only.** Not an offer, not investment advice, not for US persons. Nothing executes
from a quote automatically: the agent holds no funds, has no role on the vault and sends no
transactions.

Built for Base Stocks Maxxing Season (Nov 5 to Dec 5, 2026), Agentic Stock Finance track.

- Live: https://kerne-stock-quote.r4woutreach.workers.dev (explainer page with the current quote)
- Quote: https://kerne-stock-quote.r4woutreach.workers.dev/api/quote (add `?verify=1`)
- Signer (trust root): `0x9653Bf177239C979921DC8C0639eD00409F4Db88`
- Vault it prices for: `0xc6180E9af7Cb4c6D47A230a6c5047fA615Bd0956` on Base (deployed, closed, not audited).
  Its source and tests: https://github.com/kerne-protocol/contracts-public/tree/main/stocks/covered-call
- Feed: Chainlink "Coinbase TSLA" `0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4` (8 decimals, total return per token)

## Why it exists

The covered call vault lets a keeper list one call per epoch inside owner-set floors. Until now the
keeper picked the premium by hand, which is the weakest part of that design. This agent is the
answer to "who sets the price": a published rule, run on a schedule, signed, and recomputable by
anyone from public chain data.

## The rule

All inputs come from ONE Base block, read through one Multicall3 call per group.

1. **Spot** is the feed's latest round at that block.
2. **Realized volatility.** The feed writes a round when the price has moved about 0.5%, so rounds
   are unevenly spaced. Variance over the last 14 days is the sum of squared log returns between
   consecutive rounds, starting from the last round at or before the window start. It is annualized
   by 365 days over the window length (calendar time, weekends included, the same clock the tenor
   uses). Volatility is the square root.
3. **Expiry** is the first Friday 16:00 UTC at least 3 days after the block. The vault settles on the
   first feed round at or after expiry, and the feed is often silent from the Friday close until
   Monday 00:00 UTC. An expiry at the close would settle on Monday's print and carry a weekend the
   premium did not price. At 16:00 UTC the next round came within the hour on each of the three
   Fridays checked (2026-10-23, 10-30, 11-06).
4. **Strike** is `spot * exp(z * sd + sd^2 / 2)` with `z = 0.8416` (a 20 delta call) and
   `sd = priced_vol * sqrt(tenor / 365d)`. It is never closer than the vault's own minimum distance
   plus 1%, and it is rounded up to a whole dollar.
5. **Premium** is Black-Scholes with zero rate and zero carry at `priced_vol = 1.10 * realized`
   (clamped to 20% and 200%), as basis points of notional paid in the stock, rounded up, never below
   the vault's minimum premium.
6. **Validity.** A quote is tied to the feed round it was priced on and expires 15 minutes after its
   block (one cron period). `quote.sellable_now` says whether the price is fresh enough (4 hours) for
   the vault to sell at that moment.

The agent signs a "no quote" with the reason, and no strike or premium, when: the latest answer is
not positive; the feed's last price is older than the vault accepts for opening an epoch (25 hours
today, which happens on weekends); the window holds fewer than 30 returns, covers less than 5 days,
or contains a non-positive answer; the tenor falls outside the vault's duration limits; no public
RPC answered; or the cycle hit an unexpected error.

All pricing math is integer fixed point with 18 decimals and truncating division
(`src/fixed.ts`). There are no floats in the pricing path, so a second implementation gets the same
digits.

## What gets signed

One dedicated key, used for nothing else, signs twice:

- **EIP-191** over `sha256(signed_payload_canonical)`. This covers the whole document: inputs,
  policy, vault limits, quote, and a hash chain to the previous attestation.
- **EIP-712** over the compact `Quote` struct (domain `KerneStockQuote`, version `1`, chain 8453).
  This is the form a contract can check with `ecrecover`.

The Worker refuses to sign unless its key derives to the published signer, and checks both
signatures by recovery before it stores anything. The HTTP handler only serves stored records.

## Use it from your own code

`client/kerne-quote.mjs` is a 30-line client (one dependency, `viem`) that fetches the latest quote
and returns it only after the hash, the EIP-191 signature and, for a priced quote, the EIP-712
signature all check out against the pinned signer. Every value it returns comes from the signed
bytes.

```js
import { getKerneQuote } from './client/kerne-quote.mjs'

const q = await getKerneQuote()
if (q.ok) console.log(q.symbol, q.spot, q.strike, q.premiumBps, q.expiry)
```

It is for baskets, indexes and agents that want a covered call reference price for TSLAc next to
their own holdings. `cd client && npm ci && node test.mjs` runs it against the live endpoint and
against tampered, re-hashed, stranger-signed and stale records. Details in [client/README.md](client/README.md).

## Verify it yourself

```
curl -s https://kerne-stock-quote.r4woutreach.workers.dev/api/quote?verify=1
cast wallet verify --address 0x9653Bf177239C979921DC8C0639eD00409F4Db88 <attestation_hash> <signature>

pip install eth-account
python -I scripts/verify.py
```

`scripts/verify.py` shares no code with the Worker. It checks both signatures, re-reads the same feed
rounds and vault limits at the signed block from a different public RPC, and recomputes the
volatility, expiry, strike and premium with its own integer math. It also runs a float
Black-Scholes as a sanity check. The Worker serves the same file at `/verify.py`.

`scripts/math_vectors_check.py` recomputes 2,440 test vectors produced by the Worker's math:

```
node scripts/math-vectors.ts vectors.json
python -I scripts/math_vectors_check.py vectors.json
```

## From quote to epoch (fork test)

`contracts/src/KerneQuoteKeeper.sol` is a small reference contract, **not deployed and not
audited**. Set as the vault's keeper, it opens an epoch only at a strike and premium signed by the
agent, only while the quote's feed round is still the latest round, and only before the quote
expires. A person (the operator) still sends the transaction and decides whether to open. The
operator cannot choose the price, and the vault's own floors still apply.

```
git clone --depth 1 https://github.com/foundry-rs/forge-std contracts/lib/forge-std
cd contracts
FORK_TESTS=1 forge test -vv
```

`forge-std` is not vendored here; the first line fetches it. Without `FORK_TESTS=1` the tests do
nothing and pass.

- `test_deployedVaultOpensEpochFromLiveAgentQuote` forks Base at the block of a quote saved from the
  live endpoint (`test/fixtures/live_quote.json`, signed by the live key) and opens an epoch on the
  **deployed** vault with it. It also shows that an edited quote, an expired quote, a quote from an
  older feed round, a reused quote and a stranger are all refused.
- `test_latestBlock_openFromSelfSignedQuote` does the same at the latest block with a test key, so
  it still runs when a public RPC no longer serves the fixture's block.

On the fork the vault's owner is impersonated to point the keeper at the reference contract and to
lift the deposit cap. Nothing touches mainnet. The stock is a mock placed at the real TSLAc address,
because Coinbase tokenized stocks are precompiles a local fork cannot execute.

To refresh the fixture: `curl -s <live>/api/quote > contracts/test/fixtures/live_quote.json` while
the status is `QUOTE_OK`.

## Limits, stated plainly

- It is a model value, not a market price. Plain Black-Scholes on realized volatility knows nothing
  about earnings dates, skew, jumps or what listed options trade at.
- The vault is closed (deposit cap 0) and has never opened an epoch. No money has moved on a quote.
- The signing key is a hot key held as a Cloudflare Worker secret. It controls nothing on chain.
  If the reference keeper were ever deployed, that key would set prices inside the vault's floors,
  and it would need the custody that role deserves first.
- The feed pauses when US markets are closed, and the vault only sells while the price is under
  4 hours old.
- Not audited. Coinbase tokenized stocks are not available to US persons and nothing here is offered
  to US persons.

## Layout

```
src/index.ts      cron + HTTP handler        src/quote.ts   the pricing rule and the payload
src/reads.ts      Multicall3 reads on Base   src/fixed.ts   integer math (ln, exp, sqrt, normal CDF)
src/sign.ts       EIP-191 and EIP-712        src/page.ts    the explainer page
scripts/verify.py independent verifier       contracts/     reference keeper + fork tests
```

## Operate

- Deploy: `npx wrangler deploy` (Worker `kerne-stock-quote`, cron `*/15 * * * *`, KV namespace
  `STOCK_QUOTE_KV` bound as `QUOTE_KV`).
- Secret: `QUOTE_SIGNING_KEY` (write only). `EXPECTED_SIGNER` in `wrangler.toml` must match it.
  The key is not in this repository and never was: `.gitignore` refuses key files, and
  `scripts/genkey.ts` writes a new key to paths outside the tree and prints only its address.
- `wrangler.toml` here is the live configuration with the Cloudflare account id removed and the KV
  namespace id replaced by a placeholder. To run your own copy, create a KV namespace, generate your
  own key and set `EXPECTED_SIGNER` to its address.
- Local dry run with a throwaway key: `node scripts/local-cycle.ts out.json`.
- Cost: $0 on the Workers free tier (96 runs and about 200 KV writes a day).

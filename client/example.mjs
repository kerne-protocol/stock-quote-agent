import { getKerneQuote } from './kerne-quote.mjs'

const q = await getKerneQuote()
if (!q.ok) console.log(`no quote right now: ${q.status} (${q.reason})`)
else console.log(`${q.symbol}: spot $${q.spot}, ${q.premiumBps} bps for the $${q.strike} call to ${q.expiry}, ` +
  `quote ${q.ageSeconds}s old${q.expired ? ' (past validUntil)' : ''}, vault ${q.vaultOpen ? 'open' : 'closed'}`)

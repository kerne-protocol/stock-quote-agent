// The explainer page served at "/". Plain HTML, no external assets. __SIGNER__ is replaced at serve time.
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kerne stock quote agent</title>
<meta name="description" content="A pricing agent for covered calls on Coinbase tokenized stocks on Base. It publishes a signed reference quote every 15 minutes. Nothing executes from it.">
<style>
:root{--bg:#f6f5f1;--card:#fff;--ink:#16181c;--mute:#5d646f;--line:#dcd9d0;--accent:#0b57d0;--ok:#0a7a3d;--warn:#a15c00;--codebg:#efede6}
@media (prefers-color-scheme:dark){:root{--bg:#0f1114;--card:#171a1f;--ink:#e9eaec;--mute:#9aa2ad;--line:#2a2f37;--accent:#7fb0ff;--ok:#56c98a;--warn:#e4a64a;--codebg:#1e2228}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 16px 64px}
h1{font-size:28px;line-height:1.2;margin:0 0 6px}
h2{font-size:19px;margin:36px 0 10px}
p{margin:10px 0}
a{color:var(--accent)}
.sub{color:var(--mute);margin:0 0 18px}
.banner{border:1px solid var(--warn);color:var(--warn);border-radius:8px;padding:10px 14px;font-size:14.5px;margin:16px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px 18px;margin-top:6px}
.k{font-size:12.5px;color:var(--mute);text-transform:uppercase;letter-spacing:.04em}
.v{font:600 20px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.s{font-size:13px;color:var(--mute)}
.status{display:inline-block;font:600 13px ui-monospace,Menlo,Consolas,monospace;padding:3px 8px;border-radius:6px;border:1px solid var(--line)}
.status.ok{color:var(--ok);border-color:var(--ok)}
.status.no{color:var(--warn);border-color:var(--warn)}
.checks{margin:14px 0 0;padding:0;list-style:none;font-size:14px}
.checks li{padding:3px 0;overflow-wrap:anywhere}
pre{background:var(--codebg);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;margin:10px 0}
code{font:13.5px ui-monospace,Menlo,Consolas,monospace;background:var(--codebg);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
ol,ul{padding-left:22px}
li{margin:5px 0}
footer{margin-top:44px;color:var(--mute);font-size:13.5px;border-top:1px solid var(--line);padding-top:14px}
</style>
</head>
<body>
<main>
<h1>Kerne stock quote agent</h1>
<p class="sub">A pricing agent for covered calls on Coinbase tokenized stocks on Base. First market: TSLAc.</p>

<div class="banner"><b>Reference quote only.</b> Not an offer, not investment advice, not for US persons. Nothing executes from this quote automatically. The agent holds no funds and sends no transactions.</div>

<div class="card" id="live">
  <div><span class="status" id="status">loading</span> <span class="s" id="when"></span></div>
  <div class="grid" id="grid"></div>
  <ul class="checks" id="checks"></ul>
</div>

<h2>What it does</h2>
<p>Every 15 minutes a Cloudflare Worker reads the Chainlink TSLA feed on Base, measures how much the price has moved over the last 14 days, and prices next week's covered call for the <a href="https://kerne.fi/stocks">Kerne covered call vault</a>. It signs the result and publishes it here with every input it used. The vault's weakest point was that its keeper chose the premium by hand. This is the answer to "who sets the price": a published rule, run on a schedule, that anyone can recompute.</p>
<ol>
  <li><b>Read.</b> One block on Base: the feed's latest round, up to 500 earlier rounds, and the vault's own limits (minimum distance out of the money, minimum premium, duration limits).</li>
  <li><b>Measure.</b> Realized volatility is the sum of squared log returns between consecutive feed rounds over 14 days, annualized over calendar time.</li>
  <li><b>Price.</b> Strike is the 20 delta call for the next Friday 16:00 UTC expiry at least 3 days out, never closer than the vault's floor plus 1%, rounded up to a whole dollar. Premium is Black-Scholes at 1.10 times realized volatility with zero rate, in basis points of notional, paid in the stock.</li>
  <li><b>Sign.</b> Two signatures from one dedicated key: one over the whole document, and one EIP-712 signature over the compact quote that a contract can check. The quote is tied to the feed round it was priced on and expires after 15 minutes. Expiry sits inside the US session on purpose: the vault settles on the first feed round at or after expiry, and the feed is often silent from the Friday close until Monday.</li>
</ol>

<h2>Check it yourself</h2>
<p>Signer (the trust root): <code>__SIGNER__</code>. This key signs quotes and nothing else. It is not the vault's keeper or owner and has never sent a transaction.</p>
<pre>curl -s https://kerne-stock-quote.r4woutreach.workers.dev/api/quote?verify=1

# independent check: re-reads the feed on another RPC and recomputes everything
curl -sO https://kerne-stock-quote.r4woutreach.workers.dev/verify.py
pip install eth-account
python -I verify.py</pre>
<p>The verifier shares no code with the Worker. It checks both signatures, re-reads the same feed rounds and vault limits at the signed block from a different RPC, and recomputes the volatility, strike and premium with its own integer math. All pricing math is integer fixed point, so the numbers match to the last digit.</p>
<p>Endpoints: <a href="/api/quote">/api/quote</a>, <a href="/api/quote?verify=1">/api/quote?verify=1</a>, <a href="/api/quote/history?limit=24">/api/quote/history</a>, <a href="/api/signer">/api/signer</a>, <a href="/healthz">/healthz</a>, <a href="/verify.py">/verify.py</a>.</p>

<h2>From quote to epoch</h2>
<p><a href="/KerneQuoteKeeper.sol">KerneQuoteKeeper.sol</a> is a small reference contract. Set as the vault's keeper, it opens an epoch only at a strike and premium signed by this agent, only while the quote's feed round is still the latest round, and only before the quote expires. A person still sends the transaction and can decide whether to open, but cannot choose the price. A fork test runs this against the deployed vault on Base with a quote signed by the live key. The contract is not deployed and the vault's keeper today is still the owner's hardware wallet.</p>

<h2>What it is not</h2>
<ul>
  <li>Not a market price. It is a plain Black-Scholes value from realized volatility. It knows nothing about earnings dates, skew, jumps or what option markets charge.</li>
  <li>Not live trading. The vault is deployed on Base but closed (deposit cap 0), and no epoch has been opened.</li>
  <li>Not audited, and not for US persons. Coinbase tokenized stocks are not available to US persons.</li>
  <li>Quiet on weekends. The feed pauses when US markets are closed. The vault sells only while the price is under 4 hours old, and each quote says whether that holds. Once the last price is older than the vault accepts for opening an epoch (25 hours), the agent publishes a signed "no quote" with the reason.</li>
</ul>

<footer>
Vault <a href="https://basescan.org/address/0xc6180E9af7Cb4c6D47A230a6c5047fA615Bd0956">0xc6180E9a...0956</a> on Base. Feed <a href="https://basescan.org/address/0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4">Chainlink Coinbase TSLA</a>. Built by <a href="https://kerne.fi">Kerne</a> for Base Stocks Maxxing Season, Agentic Stock Finance track.
</footer>
</main>
<script>
(function(){
  function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e}
  function cell(k,v,s){var d=el('div');d.appendChild(el('div','k',k));d.appendChild(el('div','v',v));if(s)d.appendChild(el('div','s',s));return d}
  function line(ok,t){var li=el('li','',(ok?'PASS  ':'FAIL  ')+t);li.style.color=ok?'var(--ok)':'var(--warn)';return li}
  function hex(buf){return '0x'+Array.prototype.map.call(new Uint8Array(buf),function(b){return ('0'+b.toString(16)).slice(-2)}).join('')}
  fetch('/api/quote?verify=1').then(function(r){return r.json()}).then(function(d){
    var st=document.getElementById('status'),g=document.getElementById('grid'),c=document.getElementById('checks');
    st.textContent=d.status||'no quote yet';st.className='status '+(d.status==='QUOTE_OK'?'ok':'no');
    if(!d.status){return}
    document.getElementById('when').textContent='signed '+d.timestamp+', sequence '+d.sequence+(d._meta.is_fresh?'':' (stale)');
    if(d.spot){g.appendChild(cell('Spot (Chainlink)','$'+Number(d.spot.price).toFixed(2),Math.round(d.spot.age_seconds/60)+' min old, block '+d.chain.block_number))}
    if(d.realized_vol){g.appendChild(cell('Realized vol, 14d',d.realized_vol.annualized_vol_pct+'%',d.realized_vol.returns+' feed returns'))}
    if(d.quote){
      g.appendChild(cell('Strike','$'+Number(d.quote.strike).toFixed(2),(d.quote.strike_otm_bps/100).toFixed(2)+'% above spot'));
      g.appendChild(cell('Premium',d.quote.premium_bps+' bps',d.quote.premium_per_1_stock+' TSLAc per 1 TSLAc'));
      g.appendChild(cell('Expiry',d.quote.expiry_time.slice(0,10),'16:00 UTC, '+(d.quote.tenor_seconds/86400).toFixed(1)+' days'));
      g.appendChild(cell('Priced vol',d.quote.priced_vol_pct+'%','realized times 1.10'));
      g.appendChild(cell('Valid until',d.quote.valid_until_time.slice(11,16)+' UTC',d._meta.quote_expired?'expired, next quote due':(d.quote.sellable_now?'vault could sell at this price age':'price too old for the vault to sell now')));
    }else{g.appendChild(cell('No quote',' ',d.status_reason||''))}
    if(d.vault_bounds){g.appendChild(cell('Vault',d.vault_bounds.could_open_now?'could open':'cannot open',(d.vault_bounds.open_blockers||[]).join('; ')||'no blockers'))}
    c.appendChild(line(d._meta.verified===true,'both signatures recover to '+d._meta.expected_signer+' (checked at the edge)'));
    if(window.crypto&&crypto.subtle){crypto.subtle.digest('SHA-256',new TextEncoder().encode(d.signed_payload_canonical)).then(function(h){
      c.appendChild(line(hex(h)===d.attestation_hash,'sha256 of the signed document, computed in your browser, equals '+d.attestation_hash.slice(0,18)+'...'))})}
  }).catch(function(e){document.getElementById('status').textContent='could not load the quote: '+e})
})();
</script>
</body>
</html>`;

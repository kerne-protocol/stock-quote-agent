// Public Base JSON-RPC only. No API keys. Every contract read goes through Multicall3
// aggregate3 pinned to ONE block, so a cycle costs three plain requests (block, state, rounds)
// and never sends a JSON-RPC batch (public tiers reject batches from Cloudflare egress).

export const BASE_RPCS = [
  'https://base-rpc.publicnode.com',
  'https://base.drpc.org',
  'https://mainnet.base.org',
  'https://1rpc.io/base',
  'https://base.llamarpc.com',
  'https://gateway.tenderly.co/public/base',
  'https://base.meowrpc.com',
];

export const MARKET = {
  symbol: 'TSLAc',
  stockToken: '0xb2000000000000000000001e800a7f5189430cD0',
  feed: '0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4',
  feedDescription: 'Coinbase TSLA',
  vault: '0xc6180E9af7Cb4c6D47A230a6c5047fA615Bd0956',
} as const;

export const MAX_ROUNDS = 500;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const SEL = {
  latestRoundData: '0xfeaf968c',
  getRoundData: '0x9a6fc8f5',
  decimals: '0x313ce567',
  description: '0x7284e416',
  minOtmBps: '0x90787d8e',
  minPremiumBps: '0xd8fcb368',
  minDuration: '0x56715761',
  maxDuration: '0x6db5c8fd',
  maxStaleness: '0x87cf4696',
  epochLive: '0x17627ce9',
  salesPaused: '0xb6b97664',
  currentEpoch: '0x76671808',
  depositCap: '0xdbd5edc7',
  totalAssets: '0x01e1d114',
  lastSettledAt: '0x20456ad8',
  idleWindow: '0x18479a84',
  keeper: '0xaced1661',
  feed: '0x37a7b7d8',
  asset: '0x38d52e0f',
  buyMaxStaleness: '0x606d66ef',
};

const pad32 = (hexNo0x: string) => hexNo0x.toLowerCase().padStart(64, '0');

async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const o = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (o.error) throw new Error(`rpc error: ${o.error.message}`.slice(0, 120));
  if (o.result === undefined || o.result === null) throw new Error('null result');
  return o.result;
}

// aggregate3((address target, bool allowFailure, bytes callData)[]) with allowFailure = true:
// a failing sub-call comes back as (false, ...) and the caller decides what is fatal.
function encodeAggregate3(calls: Array<{ to: string; data: string }>): string {
  const elems = calls.map((c) => {
    const d = c.data.slice(2);
    return pad32(c.to.slice(2)) + pad32('1') + pad32('60') + pad32((d.length / 2).toString(16)) + d.padEnd(Math.ceil(d.length / 64) * 64, '0');
  });
  let offset = calls.length * 32;
  const offsets: string[] = [];
  for (const e of elems) { offsets.push(pad32(offset.toString(16))); offset += e.length / 2; }
  return '0x82ad56cb' + pad32('20') + pad32(calls.length.toString(16)) + offsets.join('') + elems.join('');
}

function decodeAggregate3(hex: string, n: number): Array<{ ok: boolean; data: string }> {
  const h = hex.slice(2);
  const w = (byteOff: number) => Number(BigInt('0x' + h.slice(byteOff * 2, byteOff * 2 + 64)));
  const arr = w(0);
  if (w(arr) !== n) throw new Error('multicall length mismatch');
  const base = arr + 32;
  const out: Array<{ ok: boolean; data: string }> = [];
  for (let i = 0; i < n; i++) {
    const el = base + w(base + i * 32);
    const dataOff = el + w(el + 32);
    const len = w(dataOff);
    out.push({ ok: w(el) === 1, data: h.slice((dataOff + 32) * 2, (dataOff + 32 + len) * 2) });
  }
  return out;
}

const wordAt = (data: string, i: number): bigint => BigInt('0x' + data.slice(i * 64, i * 64 + 64));

export interface Round { id: bigint; answer: bigint; updatedAt: number }

export interface VaultRead {
  minOtmBps: number;
  minPremiumBps: number;
  minDuration: number;
  maxDuration: number;
  maxStaleness: number;
  epochLive: boolean;
  salesPaused: boolean;
  currentEpoch: number;
  depositCap: bigint;
  totalAssets: bigint | null; // null if the stock precompile could not be read on this RPC
  lastSettledAt: number;
  idleWindow: number;
  keeper: string;
  buyMaxStaleness: number; // the vault only sells while the feed price is at most this old
}

export interface ChainRead {
  rpcHost: string;
  blockNumber: number;
  blockHash: string;
  blockTimestamp: number;
  feedDecimals: number;
  latest: Round;
  rounds: Round[]; // ascending by id, the last one is `latest`
  roundsReachPhaseStart: boolean;
  vault: VaultRead;
}

async function readOnce(url: string): Promise<ChainRead> {
  const blk = await rpc(url, 'eth_getBlockByNumber', ['latest', false]);
  if (!blk?.number || !blk.hash) throw new Error('no block');
  const V = MARKET.vault;
  const F = MARKET.feed;
  const stateCalls = [
    { to: F, data: SEL.latestRoundData }, // 0
    { to: F, data: SEL.decimals }, // 1
    { to: F, data: SEL.description }, // 2
    { to: V, data: SEL.feed }, // 3
    { to: V, data: SEL.asset }, // 4
    { to: V, data: SEL.minOtmBps }, // 5
    { to: V, data: SEL.minPremiumBps }, // 6
    { to: V, data: SEL.minDuration }, // 7
    { to: V, data: SEL.maxDuration }, // 8
    { to: V, data: SEL.maxStaleness }, // 9
    { to: V, data: SEL.epochLive }, // 10
    { to: V, data: SEL.salesPaused }, // 11
    { to: V, data: SEL.currentEpoch }, // 12
    { to: V, data: SEL.depositCap }, // 13
    { to: V, data: SEL.lastSettledAt }, // 14
    { to: V, data: SEL.idleWindow }, // 15
    { to: V, data: SEL.keeper }, // 16
    { to: V, data: SEL.buyMaxStaleness }, // 17
    { to: V, data: SEL.totalAssets }, // 18, the only one allowed to fail
  ];
  const s = decodeAggregate3(String(await rpc(url, 'eth_call', [{ to: MULTICALL3, data: encodeAggregate3(stateCalls) }, blk.number])), stateCalls.length);
  for (let i = 0; i < 18; i++) if (!s[i]!.ok || s[i]!.data.length < 64) throw new Error(`state call ${i} failed`);

  const desc = s[2]!.data;
  const descLen = Number(wordAt(desc, 1));
  let description = '';
  for (let i = 0; i < descLen; i++) description += String.fromCharCode(parseInt(desc.slice(128 + i * 2, 130 + i * 2), 16));
  if (description !== MARKET.feedDescription) throw new Error(`feed description is "${description}"`);
  const addr = (d: string) => '0x' + d.slice(24, 64);
  if (addr(s[3]!.data) !== MARKET.feed.toLowerCase()) throw new Error('vault.feed() is not the expected feed');
  if (addr(s[4]!.data) !== MARKET.stockToken.toLowerCase()) throw new Error('vault.asset() is not the expected stock');

  const lr = s[0]!.data;
  const latestId = wordAt(lr, 0);
  const latest: Round = { id: latestId, answer: BigInt.asIntN(256, wordAt(lr, 1)), updatedAt: Number(wordAt(lr, 3)) };
  const aggRound = latestId & ((1n << 64n) - 1n);
  const n = aggRound < BigInt(MAX_ROUNDS) ? Number(aggRound) : MAX_ROUNDS;
  const ids: bigint[] = [];
  for (let i = n - 1; i >= 0; i--) ids.push(latestId - BigInt(i));
  const roundCalls = ids.map((id) => ({ to: F, data: SEL.getRoundData + pad32(id.toString(16)) }));
  const r = decodeAggregate3(String(await rpc(url, 'eth_call', [{ to: MULTICALL3, data: encodeAggregate3(roundCalls) }, blk.number])), roundCalls.length);
  const rounds: Round[] = ids.map((id, i) => {
    const x = r[i]!;
    if (!x.ok || x.data.length < 320) throw new Error(`getRoundData(${id}) failed`);
    return { id, answer: BigInt.asIntN(256, wordAt(x.data, 1)), updatedAt: Number(wordAt(x.data, 3)) };
  });
  const last = rounds[rounds.length - 1]!;
  if (last.answer !== latest.answer || last.updatedAt !== latest.updatedAt) throw new Error('latest round mismatch between the two reads');

  const num = (i: number) => Number(wordAt(s[i]!.data, 0));
  return {
    rpcHost: new URL(url).host,
    blockNumber: Number(BigInt(blk.number)),
    blockHash: blk.hash,
    blockTimestamp: Number(BigInt(blk.timestamp)),
    feedDecimals: Number(wordAt(s[1]!.data, 0)),
    latest,
    rounds,
    roundsReachPhaseStart: aggRound <= BigInt(MAX_ROUNDS),
    vault: {
      minOtmBps: num(5), minPremiumBps: num(6), minDuration: num(7), maxDuration: num(8), maxStaleness: num(9),
      epochLive: num(10) === 1, salesPaused: num(11) === 1, currentEpoch: num(12),
      depositCap: wordAt(s[13]!.data, 0),
      totalAssets: s[18]!.ok && s[18]!.data.length >= 64 ? wordAt(s[18]!.data, 0) : null,
      lastSettledAt: num(14), idleWindow: num(15), keeper: addr(s[16]!.data), buyMaxStaleness: num(17),
    },
  };
}

/// Error text from a public RPC can hold anything (HTML, newlines, non-ASCII). The signed payload is
/// printable ASCII only, so everything else becomes '?'.
export const asciiOnly = (s: string): string => s.replace(/[^\x20-\x7e]/g, '?');

export async function readChain(): Promise<{ ok: true; data: ChainRead } | { ok: false; errors: string[] }> {
  const errors: string[] = [];
  for (let pass = 0; pass < 2; pass++) {
    for (const url of BASE_RPCS) {
      try {
        return { ok: true, data: await readOnce(url) };
      } catch (e) {
        errors.push(asciiOnly(`${new URL(url).host}: ${(e as Error).message}`).slice(0, 160));
      }
    }
    if (pass === 0) await new Promise((res) => setTimeout(res, 3000));
  }
  return { ok: false, errors };
}

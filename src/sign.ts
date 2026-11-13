// Two signatures per quote, both from the same dedicated key:
//  1. EIP-191 personal_sign over the 32 bytes of sha256(canonical JSON). Checks the whole
//     published document. `cast wallet verify --address <signer> <hash> <sig>` verifies it.
//  2. EIP-712 typed-data signature over the compact Quote struct. This is the form a
//     contract can check with ecrecover (see contracts/src/KerneQuoteKeeper.sol).

import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from '@noble/hashes/utils';

export const strip0x = (h: string): string => (h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h);
const word = (v: bigint): Uint8Array => hexToBytes(v.toString(16).padStart(64, '0'));
const addrWord = (a: string): Uint8Array => hexToBytes(strip0x(a).toLowerCase().padStart(64, '0'));

export function toChecksumAddress(addrHex: string): string {
  const a = strip0x(addrHex).toLowerCase();
  const h = bytesToHex(keccak_256(utf8ToBytes(a)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i]!, 16) >= 8 ? a[i]!.toUpperCase() : a[i];
  return out;
}

export function addressFromPrivateKey(privHex: string): string {
  const pub = secp256k1.getPublicKey(hexToBytes(strip0x(privHex)), false);
  return toChecksumAddress(bytesToHex(keccak_256(pub.slice(1)).slice(12)));
}

function signDigest(digest: Uint8Array, privHex: string): string {
  const sig = secp256k1.sign(digest, hexToBytes(strip0x(privHex)), { lowS: true });
  return '0x' + sig.r.toString(16).padStart(64, '0') + sig.s.toString(16).padStart(64, '0') + (27 + sig.recovery).toString(16).padStart(2, '0');
}

function recoverDigest(digest: Uint8Array, signature: string): string {
  const raw = strip0x(signature);
  if (raw.length !== 130) throw new Error('signature must be 65 bytes');
  let v = parseInt(raw.slice(128, 130), 16);
  if (v >= 27) v -= 27;
  const sig = new secp256k1.Signature(BigInt('0x' + raw.slice(0, 64)), BigInt('0x' + raw.slice(64, 128))).addRecoveryBit(v);
  return toChecksumAddress(bytesToHex(keccak_256(sig.recoverPublicKey(digest).toRawBytes(false).slice(1)).slice(12)));
}

const eip191 = (msg: Uint8Array): Uint8Array =>
  keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), msg));

export const signHash = (hashHex: string, privHex: string): string => signDigest(eip191(hexToBytes(strip0x(hashHex))), privHex);
export const recoverHash = (hashHex: string, sig: string): string => recoverDigest(eip191(hexToBytes(strip0x(hashHex))), sig);

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return '0x' + bytesToHex(new Uint8Array(buf));
}

// ---------------------------------------------------------------- EIP-712

export const EIP712_DOMAIN = { name: 'KerneStockQuote', version: '1', chainId: 8453 } as const;
export const QUOTE_TYPE =
  'Quote(address vault,address feed,uint80 roundId,uint256 spot,uint256 strike,uint32 premiumBps,uint64 saleWindow,uint64 expiry,uint64 validUntil)';

export interface OnchainQuote {
  vault: string;
  feed: string;
  roundId: bigint;
  spot: bigint;
  strike: bigint;
  premiumBps: bigint;
  saleWindow: bigint;
  expiry: bigint;
  validUntil: bigint;
}

export function domainSeparator(): Uint8Array {
  return keccak_256(concatBytes(
    keccak_256(utf8ToBytes('EIP712Domain(string name,string version,uint256 chainId)')),
    keccak_256(utf8ToBytes(EIP712_DOMAIN.name)),
    keccak_256(utf8ToBytes(EIP712_DOMAIN.version)),
    word(BigInt(EIP712_DOMAIN.chainId)),
  ));
}

export function quoteDigest(q: OnchainQuote): Uint8Array {
  const structHash = keccak_256(concatBytes(
    keccak_256(utf8ToBytes(QUOTE_TYPE)),
    addrWord(q.vault), addrWord(q.feed), word(q.roundId), word(q.spot), word(q.strike),
    word(q.premiumBps), word(q.saleWindow), word(q.expiry), word(q.validUntil),
  ));
  return keccak_256(concatBytes(hexToBytes('1901'), domainSeparator(), structHash));
}

export const signQuote = (q: OnchainQuote, privHex: string): { digest: string; signature: string } => {
  const d = quoteDigest(q);
  return { digest: '0x' + bytesToHex(d), signature: signDigest(d, privHex) };
};
export const recoverQuote = (q: OnchainQuote, sig: string): string => recoverDigest(quoteDigest(q), sig);

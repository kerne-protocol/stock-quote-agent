// Canonical JSON for the signed preimage: keys sorted, no whitespace, ASCII only, integers
// only (every quantity that is not a small integer is a decimal STRING). The output is
// byte-identical to Python's json.dumps(obj, sort_keys=True, separators=(",", ":")).

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function str(s: string): string {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7e || c < 0x20) throw new Error(`non-ASCII in canonical string at ${i}`);
  }
  return JSON.stringify(s);
}

export function canonicalize(v: Json): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`integers only in the canonical payload, got ${v}`);
    return String(v);
  }
  if (typeof v === 'string') return str(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => str(k) + ':' + canonicalize(v[k] as Json)).join(',') + '}';
}

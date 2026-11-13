// Generates the agent's dedicated signing key ONCE. Writes it to the two custody paths given
// as argv[2] and argv[3], refuses to overwrite, and prints only the address. Never prints the key.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { addressFromPrivateKey } from '../src/sign.ts';

const paths = process.argv.slice(2);
if (paths.length !== 2) throw new Error('usage: genkey.ts <primary path> <backup path>');
for (const p of paths) if (existsSync(p)) throw new Error(`refusing to overwrite ${p}`);
let key: Buffer;
do { key = randomBytes(32); } while (!secp256k1.utils.isValidPrivateKey(key));
const line = '0x' + key.toString('hex') + '\n';
for (const p of paths) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, line, { flag: 'wx', mode: 0o600 });
}
const a = addressFromPrivateKey(readFileSync(paths[0]!, 'utf8').trim());
const b = addressFromPrivateKey(readFileSync(paths[1]!, 'utf8').trim());
if (a !== b) throw new Error('the two copies derive different addresses');
console.log(a);

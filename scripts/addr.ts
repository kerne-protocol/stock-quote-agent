// Prints the address for the key file given as argv[2]. Never prints the key.
import { readFileSync } from 'node:fs';
import { addressFromPrivateKey } from '../src/sign.ts';
console.log(addressFromPrivateKey(readFileSync(process.argv[2]!, 'utf8').trim()));

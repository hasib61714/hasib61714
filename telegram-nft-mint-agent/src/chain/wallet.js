import { ethers } from 'ethers';
import { config } from '../config.js';
import { pool } from './provider.js';

export const wallet = new ethers.Wallet(config.wallet.privateKey || ethers.ZeroHash);
export const address = wallet.address;

/**
 * Nonce cache. Mint এর মুহূর্তে RPC কে nonce জিজ্ঞেস করলে ৫০-৩০০ms নষ্ট হয়,
 * তাই আগে থেকে নিয়ে রাখি এবং প্রতি tx এর পর নিজেরাই বাড়াই।
 */
let cachedNonce = null;

export async function refreshNonce() {
  cachedNonce = await pool.race((p) => p.getTransactionCount(address, 'pending'));
  return cachedNonce;
}

export function peekNonce() {
  return cachedNonce;
}

export function takeNonce() {
  if (cachedNonce === null) throw new Error('nonce এখনো warm হয়নি — আগে refreshNonce() করো');
  return cachedNonce++;
}

export function rollbackNonce() {
  if (cachedNonce !== null) cachedNonce--;
}

export async function getBalance() {
  return pool.race((p) => p.getBalance(address));
}

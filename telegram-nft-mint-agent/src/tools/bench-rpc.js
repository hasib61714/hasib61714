import 'dotenv/config';
import { ethers } from 'ethers';
import { config } from '../config.js';

/**
 * কোন RPC সবচেয়ে দ্রুত সেটা মেপে দেখো — mint war এ এই কয়েক ms ই পার্থক্য গড়ে।
 * চালাও: npm run bench
 */
const ROUNDS = 5;

for (const url of config.chain.rpcUrls) {
  const p = new ethers.JsonRpcProvider(url, config.chain.chainId, { staticNetwork: true });
  const times = [];
  for (let i = 0; i < ROUNDS; i++) {
    const t = Date.now();
    try {
      await p.getBlockNumber();
      times.push(Date.now() - t);
    } catch (e) {
      times.push(NaN);
    }
  }
  const ok = times.filter((t) => !Number.isNaN(t));
  const avg = ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null;
  console.log(`${String(avg ?? 'FAIL').padStart(5)} ms avg  ${new URL(url).host}  [${times.join(', ')}]`);
  await p.destroy();
}
process.exit(0);

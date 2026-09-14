import { ethers } from 'ethers';
import { config } from '../config.js';
import { log } from '../logger.js';
import { pool } from '../chain/provider.js';
import { refreshNonce } from '../chain/wallet.js';
import { refreshFees } from '../chain/gas.js';
import { simulate, prepare, fire, assertAffordable, waitForReceipt } from '../chain/mint.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * সব task এর common অংশ:
 *  1. warm-up  — nonce + fee + (সম্ভব হলে) pre-signed tx আগেই তৈরি
 *  2. trigger  — কখন ফায়ার করব (FCFS = sale খোলার মুহূর্ত, GTD = নির্দিষ্ট সময়)
 *  3. fire     — শুধু broadcast
 *  4. confirm  — receipt
 */
export async function executeWhen(task, shouldFire, { onEvent }) {
  const spec = task.spec;
  let prepared = null;

  const warm = async () => {
    try {
      await Promise.all([refreshNonce(), refreshFees()]);
      // gasLimit আগে থেকে জানা থাকলে পুরো tx আগেই sign করে রাখা যায় —
      // তখন ফায়ারের সময় শূন্য নেটওয়ার্ক কল লাগে, এটাই সবচেয়ে দ্রুত পথ।
      if (spec.gasLimit) prepared = await prepare(spec);
    } catch (e) {
      log.warn(`[${task.id}] warm-up ব্যর্থ:`, e.message);
    }
  };

  await warm();
  const warmTimer = setInterval(warm, 12000); // ~প্রতি block এ fee/nonce refresh

  try {
    while (!task.cancelled) {
      const verdict = await shouldFire();
      if (verdict.fire) break;
      if (verdict.abort) {
        task.status = 'aborted';
        onEvent?.(`⛔️ ${task.id} বন্ধ: ${verdict.reason}`);
        return task;
      }
      await sleep(verdict.waitMs ?? config.safety.pollIntervalMs);
    }
  } finally {
    clearInterval(warmTimer);
  }

  if (task.cancelled) {
    task.status = 'cancelled';
    return task;
  }

  const tFire = Date.now();
  task.status = 'firing';
  onEvent?.(`🚀 ${task.id}: ফায়ার করছি...`);

  if (!prepared) prepared = await prepare(spec);
  await assertAffordable(prepared);

  const res = await fire(prepared);
  task.txHash = res.hash;
  task.fireLatencyMs = Date.now() - tFire;
  task.status = res.dryRun ? 'dry-run' : 'sent';

  onEvent?.(
    [
      res.dryRun ? '🧪 DRY RUN (কিছু পাঠানো হয়নি)' : '✅ tx পাঠানো হয়েছে',
      `hash: ${res.hash}`,
      `node: ${res.winner} · broadcast ${res.elapsedMs}ms · total ${task.fireLatencyMs}ms`,
      `max cost: ${prepared.maxCostEth} ETH`,
    ].join('\n')
  );

  if (res.dryRun) return task;

  try {
    const receipt = await waitForReceipt(res.hash);
    task.status = receipt.status === 1 ? 'success' : 'reverted';
    task.blockNumber = receipt.blockNumber;
    onEvent?.(
      receipt.status === 1
        ? `🎉 ${task.id} MINTED! block ${receipt.blockNumber} · gas used ${receipt.gasUsed}`
        : `💥 ${task.id} on-chain revert হয়েছে (block ${receipt.blockNumber}) — গ্যাস খরচ হয়ে গেছে`
    );
  } catch (e) {
    task.status = 'pending';
    onEvent?.(`⏳ ${task.id} receipt পাওয়া যায়নি: ${e.message}`);
  }

  return task;
}

/**
 * FCFS: sale কখন খুলবে জানা নেই। প্রতি poll এ eth_call দিয়ে mint simulate করি —
 * যতক্ষণ বন্ধ ততক্ষণ revert, খুলে গেলেই success. সেই ফ্লিপেই ফায়ার।
 * (এটা শুধু পড়া — কোনো tx যায় না, তাই গ্যাস খরচ শূন্য।)
 */
export function fcfsTrigger(task, { onEvent }) {
  let checks = 0;
  let lastReason = null;

  return async () => {
    checks++;
    const r = await simulate(task.spec);
    if (r.ok) {
      onEvent?.(`🟢 ${task.id}: mint খুলে গেছে (${checks} বার চেক করার পর)`);
      return { fire: true };
    }
    if (r.reason !== lastReason) {
      lastReason = r.reason;
      log.debug(`[${task.id}] এখনো বন্ধ: ${r.reason}`);
    }
    if (task.deadline && Date.now() > task.deadline) {
      return { abort: true, reason: 'deadline পার হয়ে গেছে' };
    }
    return { fire: false };
  };
}

/**
 * GTD / scheduled: mint টাইম জানা (allowlist window, public sale time)।
 * নির্দিষ্ট সময়ের আগ পর্যন্ত অপেক্ষা, শেষ ২ সেকেন্ডে টাইট লুপ যাতে
 * poll interval এর কারণে দেরি না হয়।
 */
export function gtdTrigger(task) {
  return async () => {
    const left = task.startAt - Date.now();
    if (left <= 0) return { fire: true };
    if (left > 5000) return { fire: false, waitMs: Math.min(left - 2000, 5000) };
    return { fire: false, waitMs: 25 }; // শেষ মুহূর্তে high-resolution
  };
}

/** চেইনের নিজের ঘড়ি ধরে ফায়ার (block.timestamp ভিত্তিক sale এর জন্য বেশি নির্ভুল)। */
export function onChainTimeTrigger(task) {
  return async () => {
    const block = await pool.race((p) => p.getBlock('latest'));
    const now = Number(block.timestamp) * 1000;
    const left = task.startAt - now;
    if (left <= 12000) return { fire: true }; // পরের block-ই sale block
    return { fire: false, waitMs: Math.min(left - 12000, 10000) };
  };
}

export { ethers };

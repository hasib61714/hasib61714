import { ethers } from 'ethers';
import { config } from '../config.js';
import { pool } from './provider.js';
import { log } from '../logger.js';

const gwei = (n) => ethers.parseUnits(String(n), 'gwei');

/** সর্বশেষ block থেকে হিসাব করা fee, প্রতি block এ refresh হয়। */
let cached = { fees: null, at: 0 };

export async function refreshFees() {
  const fee = await pool.race((p) => p.getFeeData());
  const block = await pool.race((p) => p.getBlock('latest'));

  const baseFee = block?.baseFeePerGas ?? fee.gasPrice ?? gwei(10);

  // priority fee: নেটওয়ার্ক যা বলছে তার চেয়ে multiplier গুণ বেশি, অথবা আমাদের floor —
  // যেটা বড়। এটাই mint-war এ block এ ঢোকার মূল লিভার।
  const networkTip = fee.maxPriorityFeePerGas ?? gwei(1);
  const boostedTip = (networkTip * BigInt(Math.round(config.gas.priorityMultiplier * 100))) / 100n;
  const floorTip = gwei(config.gas.priorityFeeGwei);
  const maxPriorityFeePerGas = boostedTip > floorTip ? boostedTip : floorTip;

  // baseFee প্রতি block এ সর্বোচ্চ ১২.৫% বাড়ে; multiplier দিয়ে কয়েক block এর
  // হেডরুম রাখি যাতে tx pending হয়ে আটকে না থাকে।
  let maxFeePerGas =
    baseFee * BigInt(config.gas.baseFeeMultiplier) + maxPriorityFeePerGas;

  const hardCap = gwei(config.gas.maxFeeGwei);
  let capped = false;
  if (maxFeePerGas > hardCap) {
    maxFeePerGas = hardCap;
    capped = true;
  }

  cached = {
    at: Date.now(),
    fees: {
      baseFee,
      maxFeePerGas,
      maxPriorityFeePerGas:
        maxPriorityFeePerGas < maxFeePerGas ? maxPriorityFeePerGas : maxFeePerGas,
      capped,
    },
  };
  return cached.fees;
}

export async function getFees({ maxAgeMs = 6000 } = {}) {
  if (!cached.fees || Date.now() - cached.at > maxAgeMs) {
    try {
      await refreshFees();
    } catch (e) {
      log.warn('fee refresh ব্যর্থ, পুরনো মান ব্যবহার করছি:', e.message);
      if (!cached.fees) throw e;
    }
  }
  return cached.fees;
}

/** ব্যবহারকারী চাইলে নির্দিষ্ট tip override করতে পারে (যেমন /gas tip 25)। */
export function overrideTip(tipGwei) {
  config.gas.priorityFeeGwei = tipGwei;
  cached = { fees: null, at: 0 };
}

export function addBuffer(gasLimit) {
  return (BigInt(gasLimit) * BigInt(100 + config.gas.limitBufferPct)) / 100n;
}

export function formatFees(f) {
  return [
    `base: ${ethers.formatUnits(f.baseFee, 'gwei')} gwei`,
    `maxFee: ${ethers.formatUnits(f.maxFeePerGas, 'gwei')} gwei${f.capped ? ' (capped)' : ''}`,
    `tip: ${ethers.formatUnits(f.maxPriorityFeePerGas, 'gwei')} gwei`,
  ].join('\n');
}

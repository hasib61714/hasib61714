import { ethers } from 'ethers';
import { config } from '../config.js';
import { pool, shortError } from './provider.js';
import { wallet, address, takeNonce, rollbackNonce, refreshNonce, peekNonce, getBalance } from './wallet.js';
import { getFees, addBuffer } from './gas.js';
import { log } from '../logger.js';

/**
 * MintSpec:
 * {
 *   contract:  '0x...'            // NFT contract
 *   fn:        'mint(uint256)'    // human-readable signature (rawData না দিলে লাগবে)
 *   args:      [2]                // fn এর argument
 *   rawData:   '0x...'            // অথবা সরাসরি calldata (Etherscan এর successful mint tx থেকে কপি)
 *   valueEth:  0.02               // মোট কত ETH পাঠাবে (price * quantity)
 *   gasLimit:  250000             // optional; না দিলে estimate হবে
 * }
 */

export function buildCalldata(spec) {
  if (spec.rawData) {
    if (!ethers.isHexString(spec.rawData)) throw new Error('rawData valid hex না');
    return spec.rawData;
  }
  if (!spec.fn) throw new Error('fn অথবা rawData — যেকোনো একটা লাগবেই');
  const iface = new ethers.Interface([`function ${spec.fn.replace(/^function\s+/, '')}`]);
  const fragment = iface.fragments[0];
  return iface.encodeFunctionData(fragment, spec.args ?? []);
}

export function normalizeSpec(spec) {
  if (!ethers.isAddress(spec.contract)) throw new Error(`contract address ভুল: ${spec.contract}`);
  const valueEth = Number(spec.valueEth ?? 0);
  if (!Number.isFinite(valueEth) || valueEth < 0) throw new Error('valueEth ভুল');
  if (valueEth > config.safety.maxSpendEth) {
    throw new Error(
      `value ${valueEth} ETH > MAX_SPEND_ETH ${config.safety.maxSpendEth} ETH — safety limit এ আটকানো হলো`
    );
  }
  return {
    contract: ethers.getAddress(spec.contract),
    fn: spec.fn ?? null,
    args: spec.args ?? [],
    rawData: spec.rawData ?? null,
    valueEth,
    value: ethers.parseEther(String(valueEth)),
    gasLimit: spec.gasLimit ? BigInt(spec.gasLimit) : null,
    label: spec.label ?? spec.contract,
  };
}

/**
 * eth_call দিয়ে dry-run। Mint বন্ধ থাকলে এটা revert করে — এই revert/success
 * ফ্লিপটাই FCFS watcher এর "mint খুলে গেছে" সিগন্যাল।
 */
export async function simulate(spec) {
  const data = buildCalldata(spec);
  const call = { from: address, to: spec.contract, data, value: spec.value };
  try {
    await pool.race((p) => p.call(call));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: decodeRevert(e) };
  }
}

export async function estimate(spec) {
  if (spec.gasLimit) return spec.gasLimit;
  const data = buildCalldata(spec);
  const gas = await pool.race((p) =>
    p.estimateGas({ from: address, to: spec.contract, data, value: spec.value })
  );
  return addBuffer(gas);
}

/**
 * Mint এর আগে সব ভারী কাজ (nonce, fee, gas estimate, calldata, signature)
 * শেষ করে রাখা হয়। ফায়ার করার সময় শুধু broadcast — তাই delay প্রায় শূন্য।
 */
export async function prepare(spec, { nonce } = {}) {
  const t0 = Date.now();
  const data = buildCalldata(spec);
  const [fees, gasLimit] = await Promise.all([getFees(), estimate(spec)]);

  const txNonce = nonce ?? (peekNonce() === null ? await refreshNonce() : takeNonce());

  const tx = {
    type: 2,
    chainId: config.chain.chainId,
    to: spec.contract,
    data,
    value: spec.value,
    nonce: txNonce,
    gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };

  // লোকাল signing — কোনো নেটওয়ার্ক কল নেই, ~1ms
  const rawTx = await wallet.signTransaction(tx);

  const maxCost = spec.value + gasLimit * fees.maxFeePerGas;
  return {
    spec,
    tx,
    rawTx,
    hash: ethers.keccak256(rawTx),
    maxCostEth: ethers.formatEther(maxCost),
    prepMs: Date.now() - t0,
  };
}

export async function assertAffordable(prepared) {
  const balance = await getBalance();
  const need = prepared.tx.value + prepared.tx.gasLimit * prepared.tx.maxFeePerGas;
  if (balance < need) {
    throw new Error(
      `ব্যালেন্স কম: আছে ${ethers.formatEther(balance)} ETH, দরকার ~${ethers.formatEther(need)} ETH`
    );
  }
}

/** শুধু broadcast — এখানেই latency মাপা হয়। */
export async function fire(prepared) {
  if (config.safety.dryRun) {
    log.warn('DRY_RUN=true — tx পাঠানো হয়নি', prepared.hash);
    return { dryRun: true, hash: prepared.hash, winner: 'dry-run', elapsedMs: 0 };
  }
  try {
    const res = await pool.broadcastRaw(prepared.rawTx);
    log.info(`tx sent ${res.hash} via ${res.winner} in ${res.elapsedMs}ms`);
    return res;
  } catch (e) {
    rollbackNonce();
    throw e;
  }
}

export async function waitForReceipt(hash, timeoutMs = 180000) {
  const provider = pool.primary;
  const receipt = await provider.waitForTransaction(hash, 1, timeoutMs);
  if (!receipt) throw new Error(`receipt timeout (${timeoutMs}ms) — tx এখনো pending হতে পারে`);
  return receipt;
}

export function decodeRevert(e) {
  const raw = e?.info?.error?.data ?? e?.data ?? e?.error?.data;
  if (typeof raw === 'string' && raw.startsWith('0x08c379a0')) {
    try {
      const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + raw.slice(10));
      return reason;
    } catch {
      /* ignore */
    }
  }
  return shortError(e);
}

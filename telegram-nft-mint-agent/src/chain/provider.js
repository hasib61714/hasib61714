import { ethers } from 'ethers';
import { config } from '../config.js';
import { log } from '../logger.js';

/**
 * Latency-first provider pool.
 *
 * Reads  -> সব RPC তে একসাথে পাঠানো হয়, যেটা আগে উত্তর দেয় সেটাই নেওয়া হয় (race)।
 * Writes -> raw signed tx সব RPC + private relay এ একসাথে broadcast হয়।
 *           একই signed tx বলে nonce duplicate হয় না; যে node আগে mempool এ
 *           ঢোকাতে পারে সেটাই কার্যকর হয়, বাকিরা "already known" দেয়।
 */
export class ProviderPool {
  constructor(opts = {}) {
    const {
      chainId = config.chain.chainId,
      rpcUrls = config.chain.rpcUrls,
      relayUrls = config.chain.privateRelayUrls,
      wsUrl = config.chain.wsRpcUrl,
    } = opts;
    const network = ethers.Network.from(chainId);

    this.providers = rpcUrls.map((url) => {
      const p = new ethers.JsonRpcProvider(url, network, {
        staticNetwork: network, // chainId detect করার extra round-trip বাদ
        batchMaxCount: 1,       // batching delay বাদ, প্রতি call সাথে সাথে যায়
        polling: true,
        pollingInterval: 1000,
      });
      p._label = new URL(url).host;
      return p;
    });

    this.relays = relayUrls.map((url) => {
      const p = new ethers.JsonRpcProvider(url, network, {
        staticNetwork: network,
        batchMaxCount: 1,
      });
      p._label = `relay:${new URL(url).host}`;
      return p;
    });

    this.ws = null;
    if (wsUrl) {
      try {
        this.ws = new ethers.WebSocketProvider(wsUrl, network);
        this.ws._label = 'ws';
      } catch (e) {
        log.warn('WebSocket provider চালু করা গেল না:', e.message);
      }
    }
  }

  /** প্রথম RPC — nonce/estimate এর মত non-critical call এর জন্য। */
  get primary() {
    return this.providers[0];
  }

  /** সব provider এ একই call, প্রথম success টা return. সবাই fail করলে শেষ error. */
  async race(fn, { includeWs = true } = {}) {
    const targets = [...this.providers];
    if (includeWs && this.ws) targets.unshift(this.ws);

    let lastError;
    let pending = targets.length;

    return new Promise((resolve, reject) => {
      if (!pending) return reject(new Error('কোনো RPC provider configure করা নেই'));
      for (const p of targets) {
        Promise.resolve()
          .then(() => fn(p))
          .then(resolve)
          .catch((e) => {
            lastError = e;
            if (--pending === 0) reject(lastError);
          });
      }
    });
  }

  /** সব RPC + relay তে raw tx ছড়িয়ে দেয়। কে আগে গ্রহণ করল সেটাও রিপোর্ট করে। */
  async broadcastRaw(rawTx) {
    const targets = [...this.providers, ...this.relays];
    const started = Date.now();

    const results = await Promise.allSettled(
      targets.map(async (p) => {
        const hash = await p.send('eth_sendRawTransaction', [rawTx]);
        return { node: p._label, hash, ms: Date.now() - started };
      })
    );

    const accepted = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const errors = results
      .map((r, i) => ({ r, node: targets[i]._label }))
      .filter(({ r }) => r.status === 'rejected')
      .map(({ r, node }) => ({ node, error: shortError(r.reason) }));

    // "already known" / "nonce too low" মানে অন্য node আগেই নিয়ে নিয়েছে — এটা সফলতা।
    const known = errors.filter((e) => /already known|known transaction|nonce too low/i.test(e.error));

    if (!accepted.length && !known.length) {
      throw new Error(`কোনো node tx নেয়নি: ${errors.map((e) => `${e.node}: ${e.error}`).join(' | ')}`);
    }

    return {
      hash: accepted[0]?.hash ?? ethers.keccak256(rawTx),
      winner: accepted[0]?.node ?? 'already-known',
      elapsedMs: Date.now() - started,
      accepted,
      errors,
    };
  }

  async destroy() {
    await Promise.allSettled([
      ...this.providers.map((p) => p.destroy()),
      ...this.relays.map((p) => p.destroy()),
      this.ws?.destroy(),
    ]);
  }
}

export function shortError(e) {
  // ethers RPC error গুলোতে node এর আসল বার্তা ভেতরে থাকে ("already known",
  // "nonce too low", "execution reverted: ..."), বাইরের shortMessage জেনেরিক।
  const msg =
    e?.info?.error?.message ||
    e?.error?.message ||
    e?.shortMessage ||
    e?.message ||
    String(e);
  return String(msg).slice(0, 200);
}

export const pool = new ProviderPool();

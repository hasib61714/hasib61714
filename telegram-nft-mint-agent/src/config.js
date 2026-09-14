import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    allowedChatIds: list(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
  },
  ai: {
    provider: process.env.AI_PROVIDER || 'none',
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
    openaiKey: process.env.OPENAI_API_KEY,
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
  },
  chain: {
    chainId: num(process.env.CHAIN_ID, 1),
    rpcUrls: list(process.env.RPC_URLS),
    wsRpcUrl: process.env.WS_RPC_URL || '',
    privateRelayUrls: list(process.env.PRIVATE_RELAY_URLS),
  },
  wallet: {
    privateKey: process.env.PRIVATE_KEY,
  },
  gas: {
    limitBufferPct: num(process.env.GAS_LIMIT_BUFFER_PCT, 25),
    priorityFeeGwei: num(process.env.PRIORITY_FEE_GWEI, 3),
    priorityMultiplier: num(process.env.PRIORITY_FEE_MULTIPLIER, 1.5),
    baseFeeMultiplier: num(process.env.BASE_FEE_MULTIPLIER, 2),
    maxFeeGwei: num(process.env.MAX_FEE_GWEI, 200),
  },
  safety: {
    dryRun: bool(process.env.DRY_RUN, true),
    maxSpendEth: num(process.env.MAX_SPEND_ETH, 0.2),
    pollIntervalMs: num(process.env.POLL_INTERVAL_MS, 250),
  },
};

export function assertConfig() {
  const missing = [];
  if (!config.telegram.token) missing.push('TELEGRAM_BOT_TOKEN');
  if (!config.telegram.allowedChatIds.length) missing.push('TELEGRAM_ALLOWED_CHAT_IDS');
  if (!config.chain.rpcUrls.length) missing.push('RPC_URLS');
  if (!config.wallet.privateKey) missing.push('PRIVATE_KEY');
  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(', ')} (দেখো .env.example)`);
  }
}

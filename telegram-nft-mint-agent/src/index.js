import { assertConfig, config } from './config.js';
import { log } from './logger.js';
import { createBot } from './bot/index.js';
import { pool } from './chain/provider.js';
import { address, refreshNonce } from './chain/wallet.js';
import { refreshFees, formatFees } from './chain/gas.js';
import { cancelAll } from './store.js';

async function main() {
  assertConfig();

  log.info(`wallet: ${address}`);
  log.info(`chainId: ${config.chain.chainId} · RPCs: ${config.chain.rpcUrls.length} · DRY_RUN: ${config.safety.dryRun}`);

  const [nonce, fees] = await Promise.all([refreshNonce(), refreshFees()]);
  log.info(`nonce: ${nonce}`);
  log.info(formatFees(fees));

  const bot = createBot();
  await bot.launch();
  log.info('Telegram bot চালু হয়েছে');

  const shutdown = async (sig) => {
    log.warn(`${sig} — বন্ধ করছি`);
    cancelAll();
    bot.stop(sig);
    await pool.destroy();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  log.error(e.message);
  process.exit(1);
});

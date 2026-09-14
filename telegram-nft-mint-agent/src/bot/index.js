import { Telegraf } from 'telegraf';
import { ethers } from 'ethers';
import { config } from '../config.js';
import { log } from '../logger.js';
import { parseKeyValues, toSpec, parseWhen } from './args.js';
import { normalizeSpec, simulate, prepare } from '../chain/mint.js';
import { address, getBalance, refreshNonce, peekNonce } from '../chain/wallet.js';
import { getFees, formatFees, overrideTip } from '../chain/gas.js';
import { executeWhen, fcfsTrigger, gtdTrigger, onChainTimeTrigger } from '../strategies/runner.js';
import { createTask, listTasks, activeTasks, cancelTask, cancelAll, formatTask, persist } from '../store.js';
import { parseIntent } from '../ai/agent.js';

const HELP = `🤖 *NFT Mint Agent*

\`/wallet\` — address, balance, nonce
\`/gas\` — এখনকার fee · \`/gas tip 25\` দিয়ে priority fee সেট
\`/dryrun on|off\` — আসল tx পাঠাবে কি না
\`/sim <args>\` — শুধু simulate (গ্যাস খরচ হয় না)
\`/mint <args>\` — এখনই মিন্ট
\`/watch <args>\` — FCFS: sale খোলা মাত্র ফায়ার
\`/schedule at=<ISO> <args>\` — GTD: নির্দিষ্ট সময়ে ফায়ার
\`/tasks\` · \`/cancel <id>\` · \`/panic\` (সব বাতিল)

*args ফরম্যাট:*
\`contract=0xABC fn="mint(uint256)" args=[2] value=0.02 gas=220000\`
অথবা Etherscan এর সফল mint tx থেকে calldata কপি করে:
\`contract=0xABC data=0xa0712d68... value=0.02 gas=220000\`

💡 gas= দিলে tx আগেই sign হয়ে বসে থাকে → ফায়ারের সময় শূন্য RPC কল, সবচেয়ে দ্রুত।
সাধারণ ভাষায় লিখলেও চলবে, AI বুঝে নেবে।`;

export function createBot() {
  const bot = new Telegraf(config.telegram.token);

  bot.use(async (ctx, next) => {
    const id = String(ctx.chat?.id ?? '');
    if (!config.telegram.allowedChatIds.includes(id)) {
      log.warn(`অননুমোদিত chat: ${id}`);
      return;
    }
    return next();
  });

  const reply = (ctx, text) =>
    ctx.replyWithMarkdown(text).catch(() => ctx.reply(text.replace(/[*`_]/g, '')));

  bot.start((ctx) => reply(ctx, HELP));
  bot.help((ctx) => reply(ctx, HELP));

  bot.command('wallet', async (ctx) => {
    const [bal, nonce] = await Promise.all([getBalance(), refreshNonce()]);
    await reply(
      ctx,
      `👛 \`${address}\`\nbalance: *${ethers.formatEther(bal)} ETH*\nnonce: ${nonce}\nchainId: ${config.chain.chainId}\nDRY_RUN: *${config.safety.dryRun}*`
    );
  });

  bot.command('gas', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts[1] === 'tip' && parts[2]) {
      overrideTip(Number(parts[2]));
      await reply(ctx, `⛽️ priority fee floor = ${parts[2]} gwei`);
    }
    const fees = await getFees({ maxAgeMs: 0 });
    await reply(ctx, '```\n' + formatFees(fees) + '\n```');
  });

  bot.command('dryrun', async (ctx) => {
    const v = ctx.message.text.trim().split(/\s+/)[1];
    if (v === 'on' || v === 'off') config.safety.dryRun = v === 'on';
    await reply(
      ctx,
      `🧪 DRY_RUN = *${config.safety.dryRun}*` +
        (config.safety.dryRun ? '' : '\n⚠️ এখন আসল টাকা খরচ হবে।')
    );
  });

  bot.command('sim', async (ctx) => {
    try {
      const spec = normalizeSpec(toSpec(parseKeyValues(ctx.message.text)));
      const r = await simulate(spec);
      if (!r.ok) return reply(ctx, `🔴 এখন মিন্ট করা যাবে না:\n\`${r.reason}\``);
      const p = await prepare(spec);
      await reply(
        ctx,
        `🟢 simulate সফল\ngasLimit: ${p.tx.gasLimit}\nmax cost: *${p.maxCostEth} ETH*\nprep time: ${p.prepMs}ms`
      );
    } catch (e) {
      await reply(ctx, `❌ ${e.message}`);
    }
  });

  bot.command('mint', (ctx) => startTask(ctx, 'mint'));
  bot.command('watch', (ctx) => startTask(ctx, 'fcfs'));
  bot.command('schedule', (ctx) => startTask(ctx, 'gtd'));

  bot.command('tasks', async (ctx) => {
    const all = listTasks();
    if (!all.length) return reply(ctx, 'কোনো task নেই।');
    await reply(ctx, all.slice(-10).map(formatTask).join('\n\n'));
  });

  bot.command('cancel', async (ctx) => {
    const id = ctx.message.text.trim().split(/\s+/)[1];
    const t = cancelTask(id);
    await reply(ctx, t ? `🛑 ${id} বাতিল।` : `${id} খুঁজে পেলাম না।`);
  });

  bot.command('panic', async (ctx) => {
    const c = cancelAll();
    config.safety.dryRun = true;
    await reply(ctx, `🛑 ${c.length} টা task বাতিল, DRY_RUN আবার on করা হলো।`);
  });

  // কমান্ড নয় এমন মেসেজ -> AI
  bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;
    const intent = await parseIntent(text);
    if (!intent) return reply(ctx, 'বুঝলাম না। `/help` দেখো।');

    if (intent.note) await reply(ctx, `🧠 ${intent.note}`);

    const map = { mint_now: 'mint', watch_fcfs: 'fcfs', schedule_gtd: 'gtd' };
    if (intent.action === 'status') return ctx.reply('/tasks দাও');
    if (intent.action === 'gas') {
      if (intent.tipGwei) overrideTip(intent.tipGwei);
      return reply(ctx, '```\n' + formatFees(await getFees({ maxAgeMs: 0 })) + '\n```');
    }
    if (intent.action === 'cancel') {
      const t = intent.taskId ? cancelTask(intent.taskId) : null;
      return reply(ctx, t ? `🛑 ${intent.taskId} বাতিল।` : 'কোন task? `/tasks` দেখো।');
    }
    if (!map[intent.action]) return reply(ctx, HELP);

    try {
      const spec = normalizeSpec({
        contract: intent.contract,
        fn: intent.fn,
        args: intent.args ?? [],
        rawData: intent.rawData,
        valueEth: intent.valueEth ?? 0,
      });
      // AI-পথে সবসময় আগে দেখাই কী হবে — নিশ্চিত করার জন্য
      await runTask(ctx, map[intent.action], spec, intent.startAt ? Date.parse(intent.startAt) : null);
    } catch (e) {
      await reply(ctx, `❌ ${e.message}`);
    }
  });

  async function startTask(ctx, kind) {
    try {
      const kv = parseKeyValues(ctx.message.text);
      const spec = normalizeSpec(toSpec(kv));
      const startAt = kind === 'gtd' ? parseWhen(kv.at) : null;
      if (kind === 'gtd' && !startAt) throw new Error('`at=` (ISO সময়) লাগবে');
      await runTask(ctx, kind, spec, startAt, kv.onchain === 'true');
    } catch (e) {
      await reply(ctx, `❌ ${e.message}`);
    }
  }

  async function runTask(ctx, kind, spec, startAt, useChainClock = false) {
    const task = createTask({
      type: kind,
      spec,
      startAt,
      chatId: ctx.chat.id,
      deadline: null,
    });

    const onEvent = (msg) => {
      persist();
      ctx.reply(msg).catch(() => {});
    };

    await reply(
      ctx,
      `📌 *${task.id}* তৈরি\n${formatTask(task)}\n${config.safety.dryRun ? '🧪 DRY_RUN on — আসল tx যাবে না' : '⚠️ LIVE mode'}`
    );

    const trigger =
      kind === 'mint'
        ? async () => ({ fire: true })
        : kind === 'fcfs'
          ? fcfsTrigger(task, { onEvent })
          : useChainClock
            ? onChainTimeTrigger(task)
            : gtdTrigger(task);

    task.status = kind === 'fcfs' ? 'watching' : 'queued';

    executeWhen(task, trigger, { onEvent })
      .catch((e) => {
        task.status = 'failed';
        task.error = e.message;
        onEvent(`❌ ${task.id} ব্যর্থ: ${e.message}`);
      })
      .finally(persist);
  }

  return bot;
}

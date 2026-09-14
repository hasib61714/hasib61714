import assert from 'node:assert/strict';
import { startFakeChain, startFailingNode } from './fake-chain.mjs';

const PORT = 8611;
const chain = await startFakeChain(PORT);

process.env.PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
process.env.RPC_URLS = `http://127.0.0.1:${PORT}`;
process.env.CHAIN_ID = '1';
process.env.DRY_RUN = 'false';
process.env.POLL_INTERVAL_MS = '50';
process.env.MAX_SPEND_ETH = '0.5';

const { ethers } = await import('ethers');
const { buildCalldata, normalizeSpec, simulate, prepare } = await import('../src/chain/mint.js');
const { parseKeyValues, toSpec, parseWhen } = await import('../src/bot/args.js');
const { addBuffer } = await import('../src/chain/gas.js');
const { executeWhen, fcfsTrigger, gtdTrigger } = await import('../src/strategies/runner.js');
const { createTask } = await import('../src/store.js');
const { pool, ProviderPool } = await import('../src/chain/provider.js');

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
};

const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const mintSpec = (over = {}) =>
  normalizeSpec({ contract: CONTRACT, fn: 'mint(uint256)', args: [2], valueEth: 0.02, gasLimit: 220000, ...over });

console.log('\nargs + calldata');
await test('key=value parse করে', () => {
  const kv = parseKeyValues('/watch contract=0xABC fn="mint(uint256)" args=[2] value=0.02 gas=220000');
  assert.equal(kv.fn, 'mint(uint256)');
  assert.deepEqual(kv.args, [2]);
  assert.equal(kv.value, '0.02');
});
await test('signature থেকে সঠিক calldata বানায়', () => {
  assert.equal(
    buildCalldata(mintSpec()),
    '0xa0712d680000000000000000000000000000000000000000000000000000000000000002'
  );
});
await test('rawData সরাসরি ব্যবহার করে', () => {
  const data = '0xa0712d68' + '0'.repeat(63) + '3';
  assert.equal(buildCalldata(normalizeSpec({ contract: CONTRACT, rawData: data, valueEth: 0 })), data);
});
await test('ISO ও unix দুই সময়ই বোঝে', () => {
  assert.equal(parseWhen('2026-09-20T17:00:00Z'), Date.parse('2026-09-20T17:00:00Z'));
  assert.equal(parseWhen('1789000000'), 1789000000000);
});

console.log('\nsafety');
await test('MAX_SPEND_ETH এর উপরে গেলে আটকায়', () => {
  assert.throws(() => mintSpec({ valueEth: 5 }), /MAX_SPEND_ETH/);
});
await test('ভুল contract address আটকায়', () => {
  assert.throws(() => normalizeSpec({ contract: '0xnope', valueEth: 0 }), /contract address ভুল/);
});
await test('gas buffer ঠিকমতো যোগ হয়', () => {
  assert.equal(addBuffer(200000n), 250000n); // default 25%
});

console.log('\nsimulate + prepare');
await test('sale বন্ধ থাকলে simulate revert reason দেয়', async () => {
  chain.state.open = false;
  const r = await simulate(mintSpec());
  assert.equal(r.ok, false);
  assert.match(r.reason, /sale not active/);
});
await test('sale খোলা থাকলে simulate সফল', async () => {
  chain.state.open = true;
  assert.equal((await simulate(mintSpec())).ok, true);
});
await test('prepare লোকালি সই করা valid tx দেয়', async () => {
  const p = await prepare(mintSpec());
  const parsed = ethers.Transaction.from(p.rawTx);
  assert.equal(parsed.to, CONTRACT);
  assert.equal(parsed.type, 2);
  assert.equal(parsed.value, ethers.parseEther('0.02'));
  assert.ok(parsed.maxPriorityFeePerGas <= parsed.maxFeePerGas);
});

console.log('\nbroadcast');
await test('সব node "already known" দিলেও সফল ধরে', async () => {
  const a = await startFailingNode(8612, 'already known');
  const b = await startFailingNode(8613, 'nonce too low');
  const p = new ProviderPool({ rpcUrls: ['http://127.0.0.1:8612', 'http://127.0.0.1:8613'] });
  const res = await p.broadcastRaw('0x02f8' + '00'.repeat(40));
  assert.equal(res.winner, 'already-known');
  assert.equal(res.errors.length, 2);
  // প্রতিটা error ঠিক তার নিজের node এর সাথে মিলে যায় কিনা
  assert.deepEqual(
    res.errors.map((e) => `${e.node}|${e.error}`),
    ['127.0.0.1:8612|already known', '127.0.0.1:8613|nonce too low']
  );
  await p.destroy();
  a.close();
  b.close();
});
await test('race: একটা node fail করলেও অন্যটা থেকে উত্তর আসে', async () => {
  const bad = await startFailingNode(8615, 'boom');
  const p = new ProviderPool({ rpcUrls: ['http://127.0.0.1:8615', `http://127.0.0.1:${PORT}`] });
  assert.equal(await p.race((x) => x.getBlockNumber()), 100);
  await p.destroy();
  bad.close();
});
await test('কোনো node না নিলে error দেয়', async () => {
  const a = await startFailingNode(8614, 'insufficient funds for gas');
  const p = new ProviderPool({ rpcUrls: ['http://127.0.0.1:8614'] });
  await assert.rejects(() => p.broadcastRaw('0x02f8' + '00'.repeat(40)), /কোনো node tx নেয়নি/);
  await p.destroy();
  a.close();
});

console.log('\nFCFS end-to-end');
await test('sale খোলার মুহূর্তে ফায়ার করে mint সফল হয়', async () => {
  chain.state.open = false;
  chain.state.sentRaw = null;
  const task = createTask({ type: 'fcfs', spec: mintSpec(), chatId: 1 });
  setTimeout(() => (chain.state.open = true), 300);

  const done = await executeWhen(task, fcfsTrigger(task, {}), {});
  assert.equal(done.status, 'success');
  assert.ok(chain.state.sentRaw, 'raw tx broadcast হয়নি');
  assert.ok(done.fireLatencyMs < 250, `ফায়ার latency বেশি: ${done.fireLatencyMs}ms`);
  assert.ok(chain.state.calls > 1, 'sale বন্ধ থাকাকালীন poll হয়নি');
});

console.log('\nGTD end-to-end');
await test('নির্ধারিত সময়ের পরেই ফায়ার করে', async () => {
  chain.state.open = true;
  chain.state.sentRaw = null;
  const startAt = Date.now() + 400;
  const task = createTask({ type: 'gtd', spec: mintSpec(), startAt, chatId: 1 });
  const done = await executeWhen(task, gtdTrigger(task), {});
  assert.equal(done.status, 'success');
  assert.ok(Date.now() >= startAt, 'সময়ের আগেই ফায়ার করেছে');
  assert.ok(Date.now() - startAt < 300, 'সময়ের অনেক পরে ফায়ার করেছে');
});

console.log('\nDRY_RUN');
await test('DRY_RUN on থাকলে কোনো tx যায় না', async () => {
  const { config } = await import('../src/config.js');
  config.safety.dryRun = true;
  chain.state.sentRaw = null;
  const task = createTask({ type: 'gtd', spec: mintSpec(), startAt: Date.now(), chatId: 1 });
  const done = await executeWhen(task, gtdTrigger(task), {});
  assert.equal(done.status, 'dry-run');
  assert.equal(chain.state.sentRaw, null);
  config.safety.dryRun = false;
});

console.log(`\n${passed} টেস্ট পাস${process.exitCode ? ' (কিছু ফেল করেছে)' : ''}\n`);
await pool.destroy();
chain.close();
process.exit(process.exitCode ?? 0);

import http from 'node:http';

const hex = (n) => '0x' + BigInt(Math.floor(Number(n))).toString(16);

/**
 * ছোট একটা নকল JSON-RPC node — টেস্টের জন্য।
 * state.open = false থাকলে eth_call revert করে (sale বন্ধ), true হলে সফল।
 */
export async function startFakeChain(port) {
  const state = { open: false, sentRaw: null, calls: 0 };
  const txHash = '0x' + 'ab'.repeat(32);

  const block = () => ({
    number: hex(100),
    hash: '0x' + '22'.repeat(32),
    parentHash: '0x' + '33'.repeat(32),
    timestamp: hex(Math.floor(Date.now() / 1000)),
    baseFeePerGas: hex(20e9),
    gasLimit: hex(30000000),
    gasUsed: hex(15000000),
    miner: '0x' + '00'.repeat(20),
    extraData: '0x',
    transactions: [],
    difficulty: '0x0',
    nonce: '0x0000000000000000',
  });

  const handlers = {
    eth_chainId: () => hex(1),
    eth_blockNumber: () => hex(100),
    eth_getBlockByNumber: () => block(),
    eth_gasPrice: () => hex(25e9),
    eth_maxPriorityFeePerGas: () => hex(2e9),
    eth_getTransactionCount: () => hex(7),
    eth_getBalance: () => hex(1e18),
    eth_estimateGas: () => hex(180000),
    eth_call: () => {
      state.calls++;
      if (!state.open) throw { code: -32000, message: 'execution reverted: sale not active' };
      return '0x';
    },
    eth_sendRawTransaction: (params) => {
      state.sentRaw = params[0];
      return txHash;
    },
    eth_getTransactionReceipt: () =>
      state.sentRaw
        ? {
            transactionHash: txHash,
            blockNumber: hex(100),
            blockHash: '0x' + '44'.repeat(32),
            transactionIndex: '0x0',
            from: '0x' + '00'.repeat(20),
            to: '0x' + '00'.repeat(20),
            cumulativeGasUsed: hex(180000),
            gasUsed: hex(175000),
            effectiveGasPrice: hex(25e9),
            status: '0x1',
            logs: [],
            logsBloom: '0x' + '00'.repeat(256),
            type: '0x2',
          }
        : null,
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const rpc = JSON.parse(body);
      let out;
      try {
        out = { result: handlers[rpc.method] ? handlers[rpc.method](rpc.params) : null };
      } catch (e) {
        out = { error: { code: e.code ?? -32000, message: e.message } };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, ...out }));
    });
  });

  await new Promise((r) => server.listen(port, r));
  return { state, txHash, close: () => server.close() };
}

/** নির্দিষ্ট error দেয় এমন নকল node (broadcast fallback টেস্টের জন্য)। */
export async function startFailingNode(port, message) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const rpc = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message } }));
    });
  });
  await new Promise((r) => server.listen(port, r));
  return { close: () => server.close() };
}

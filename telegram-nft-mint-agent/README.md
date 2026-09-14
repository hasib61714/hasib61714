# 🤖 Telegram NFT Mint Agent

Telegram থেকে কন্ট্রোল করা একটা AI agent, যেটা EVM চেইনে **FCFS** (sale খোলা মাত্র) আর
**GTD / scheduled** (নির্দিষ্ট সময়ে) NFT mint ফায়ার করে — সর্বনিম্ন delay দিয়ে।

> ⚠️ এটা শেখার/নিজের ওয়ালেটে ব্যবহারের জন্য। আসল টাকা যাচ্ছে — প্রথমে টেস্টনেটে
> আর `DRY_RUN=true` রেখে চালাও। Mint মানেই লাভ না; hyped project এ gas war এ হারলে
> শুধু গ্যাসটাই চলে যায়।

---

## কেন সাধারণ স্ক্রিপ্টে delay হয়

একটা সাধারণ `contract.mint()` কল করলে ethers/web3 পর্দার আড়ালে এগুলো করে —
প্রতিটাই একটা করে RPC round-trip, প্রতিটায় ৫০–৩০০ms:

| ধাপ | সাধারণ স্ক্রিপ্ট | এই agent |
|---|---|---|
| chainId জানা | প্রতিবার জিজ্ঞেস করে | `staticNetwork` — একবারও না |
| nonce আনা | mint এর সময় | আগেই cache, লোকালি বাড়ে |
| gas fee আনা | mint এর সময় | প্রতি ~12s এ ব্যাকগ্রাউন্ডে refresh |
| gas estimate | mint এর সময় | `gas=` দিলে আগেই জানা |
| tx sign | mint এর সময় | **আগেই sign করা থাকে** |
| broadcast | ১টা RPC | সব RPC + private relay একসাথে |

ফলে ফায়ার করার মুহূর্তে কাজ বাকি থাকে মাত্র একটাই — `eth_sendRawTransaction`।
টেস্টে মাপা ফায়ার latency **~5ms** (nonce/fee/sign সব আগেই সারা)।

**Sale কখন খুলল সেটা বোঝার ট্রিক:** প্রতি poll এ `eth_call` দিয়ে mint কে
*simulate* করা হয়। বন্ধ থাকলে revert করে (`sale not active`), খোলা মাত্র সফল হয়।
এই revert → success ফ্লিপটাই ট্রিগার। `eth_call` পড়া মাত্র, তাই **গ্যাস খরচ শূন্য**।

---

## সেটআপ

```bash
cd telegram-nft-mint-agent
npm install
cp .env.example .env
```

`.env` এ যা লাগবে:

1. **`TELEGRAM_BOT_TOKEN`** — Telegram এ [@BotFather](https://t.me/BotFather) → `/newbot`
2. **`TELEGRAM_ALLOWED_CHAT_IDS`** — [@userinfobot](https://t.me/userinfobot) কে মেসেজ দিলে
   তোমার id বলবে। এই লিস্টের বাইরে কেউ বটকে কমান্ড দিতে পারবে না।
3. **`PRIVATE_KEY`** — **অবশ্যই burner wallet**। মেইন ওয়ালেটের key কখনো না।
   যতটুকু mint এ লাগবে ততটুকু ETH রেখো।
4. **`RPC_URLS`** — একাধিক দাও। পাবলিক RPC ধীর; mint war জিততে চাইলে
   Alchemy / QuickNode / Chainstack এর প্রাইভেট endpoint নাও, আর
   `WS_RPC_URL` দিলে block latency আরও কমে।

কোন RPC তোমার লোকেশন থেকে দ্রুত, মেপে নাও:

```bash
npm run bench
#   41 ms avg  eth-mainnet.g.alchemy.com   [43, 39, 42, 40, 41]
#  180 ms avg  rpc.ankr.com                [210, 175, 178, 169, 168]
```

চালাও:

```bash
npm start
```

সব ঠিক আছে কিনা দেখো:

```bash
npm test     # নকল চেইনের বিপরীতে ১৬টা টেস্ট
```

---

## ব্যবহার

Telegram এ বটকে:

```
/wallet                     # address, balance, nonce
/gas                        # এখনকার fee · /gas tip 25 দিয়ে priority fee সেট
/dryrun off                 # আসল tx পাঠানো চালু (ডিফল্ট on)
/tasks                      # চলমান সব task
/cancel fcfs-001            # একটা বাতিল
/panic                      # সব বাতিল + DRY_RUN আবার on
```

### ১. প্রথমে সবসময় simulate

```
/sim contract=0xABC... fn="mint(uint256)" args=[2] value=0.02
```

> 🟢 simulate সফল · gasLimit: 187432 · max cost: 0.0271 ETH

revert হলে কারণটা হুবহু দেখাবে (`sale not active`, `exceeds max per wallet`, ...)।

### ২. FCFS — sale খোলা মাত্র ফায়ার

```
/watch contract=0xABC... fn="mint(uint256)" args=[2] value=0.02 gas=220000
```

বট চুপচাপ poll করতে থাকবে, খোলা মাত্র:

> 🟢 fcfs-001: mint খুলে গেছে (1,482 বার চেক করার পর)
> 🚀 ফায়ার করছি...
> ✅ tx পাঠানো হয়েছে · node: eth-mainnet.g.alchemy.com · broadcast 38ms · total 41ms
> 🎉 fcfs-001 MINTED! block 20913442 · gas used 176,204

### ৩. GTD — নির্দিষ্ট সময়ে

```
/schedule at=2026-09-20T17:00:00Z contract=0xABC... fn="mint(uint256)" args=[1] value=0.01 gas=200000
```

`onchain=true` যোগ করলে সিস্টেম ঘড়ির বদলে `block.timestamp` ধরে ফায়ার করবে —
কন্ট্রাক্টের sale টাইম block timestamp ভিত্তিক হলে এটাই নির্ভুল।

### ৪. ফাংশন সিগনেচার না জানলে

Etherscan এ ওই কন্ট্রাক্টের একটা **সফল mint tx** খোলো → *Input Data* → *View as Raw*
→ পুরো hex কপি করে দাও:

```
/watch contract=0xABC... data=0xa0712d68...0002 value=0.02 gas=220000
```

এতে quantity/proof সহ সব আর্গুমেন্ট হুবহু থাকে।

### ৫. সাধারণ ভাষায়

`AI_PROVIDER` সেট থাকলে কমান্ড ফরম্যাট মনে রাখতে হবে না:

> **তুমি:** 0xABC... এই কন্ট্রাক্টে sale খুললেই ২টা মিন্ট করো, দাম 0.01 করে
> **বট:** 🧠 FCFS watch — 0xABC... এ mint(uint256) with [2], মোট 0.02 ETH
> **বট:** 📌 fcfs-002 তৈরি...

AI শুধু তোমার কথা বুঝে JSON কমান্ড বানায় — চেইনে কিছু পাঠায় না। পাঠানোর
সিদ্ধান্ত আর সব safety check কোডেই।

---

## `gas=` কেন গুরুত্বপূর্ণ

`gas=` **দিলে** → tx আগেই পুরো sign হয়ে বসে থাকে, ফায়ারে শূন্য RPC কল (সবচেয়ে দ্রুত)।
`gas=` **না দিলে** → ফায়ারের সময় একবার `estimateGas` করতে হয়, ৫০–২০০ms যোগ হয়।

মান বের করো `/sim` থেকে — যা দেখাবে তার চেয়ে ২০-৩০% বেশি দাও।
কম দিলে `out of gas` হয়ে revert করবে, আর **গ্যাসটা তবুও কেটে যাবে**।

---

## Safety

| সেটিং | কাজ |
|---|---|
| `DRY_RUN=true` | সব হবে, শুধু tx পাঠানো হবে না। **ডিফল্ট।** |
| `MAX_SPEND_ETH` | এক টাস্কে এর বেশি value হলে শুরুতেই আটকে দেয় |
| `MAX_FEE_GWEI` | gas war এ ওয়ালেট খালি হওয়ার হার্ড সিলিং |
| `TELEGRAM_ALLOWED_CHAT_IDS` | অন্য কেউ বটকে কমান্ড দিতে পারবে না |
| `/panic` | সব task বাতিল + DRY_RUN আবার on |

ফায়ারের আগে ব্যালেন্স চেক হয়, আর `.env` / `data/` git এ যায় না।

---

## যা এটা করে না

- **সাইট-ভিত্তিক mint** (OpenSea Drops এর মত) — ওখানে signature/allowlist proof
  ওদের API থেকে আসে। সেটা লাগলে ওই proof টা `data=` হিসেবে নিজে বসাতে হবে।
- **Sybil / multi-wallet farming** — এক ওয়ালেট, এক টাস্ক। এটা ইচ্ছাকৃত।
- **কোনো anti-bot বা rate limit বাইপাস** — শুধু পাবলিক কন্ট্রাক্টে সাধারণ tx।
- **লাভের গ্যারান্টি** — hyped mint এ প্রফেশনাল bot গুলো colocated node ব্যবহার করে।
  তোমার এজ হলো প্রস্তুতি, gas সেটিং আর ভালো RPC — জাদু না।

---

## গঠন

```
src/
  config.js              env লোড + ভ্যালিডেশন
  chain/provider.js      multi-RPC race + parallel broadcast
  chain/wallet.js        nonce cache (mint এর সময় RPC কল বাঁচায়)
  chain/gas.js           EIP-1559 fee policy + hard cap
  chain/mint.js          calldata · simulate · pre-sign · fire · receipt
  strategies/runner.js   warm-up → trigger → fire → confirm
  ai/agent.js            স্বাভাবিক ভাষা → JSON কমান্ড
  bot/index.js           Telegram কমান্ড
  tools/bench-rpc.js     RPC latency মাপার টুল
test/                    নকল চেইনের বিপরীতে ইন্টিগ্রেশন টেস্ট
```

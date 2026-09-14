import { config } from '../config.js';
import { log } from '../logger.js';

/**
 * বাংলা/ইংরেজি স্বাভাবিক ভাষার মেসেজ -> কাঠামোবদ্ধ কমান্ড।
 * AI শুধু "কী করতে চায়" বুঝে JSON দেয় — চেইনে কিছু পাঠায় না।
 * পাঠানোর সিদ্ধান্ত ও সব safety check কোডেই থাকে।
 */
const SYSTEM_PROMPT = `You translate a user's chat message into ONE JSON command for an NFT minting bot.

Reply with ONLY a JSON object, no markdown fence, no commentary.

Schema:
{
  "action": "mint_now" | "watch_fcfs" | "schedule_gtd" | "status" | "cancel" | "gas" | "help" | "unknown",
  "contract": "0x... or null",
  "fn": "mint(uint256) style signature, or null",
  "args": [],
  "rawData": "0x... calldata, or null",
  "valueEth": number or null,
  "startAt": "ISO-8601 UTC timestamp, or null",
  "taskId": "string or null",
  "tipGwei": number or null,
  "note": "one short line in the user's language explaining what you understood"
}

Rules:
- "মিন্ট হলেই ধরবে" / "sale খুললেই" / FCFS / snipe -> watch_fcfs
- a specific time or date -> schedule_gtd with startAt
- "এখনই মিন্ট করো" -> mint_now
- Never invent a contract address. If it is missing, use action "unknown" and say what is missing in "note".
- valueEth is the TOTAL ETH to send (price x quantity).`;

export async function parseIntent(text) {
  if (config.ai.provider === 'none') return null;
  try {
    const raw =
      config.ai.provider === 'openai' ? await callOpenAI(text) : await callAnthropic(text);
    const json = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    return JSON.parse(json);
  } catch (e) {
    log.warn('AI parse ব্যর্থ:', e.message);
    return null;
  }
}

async function callAnthropic(text) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.ai.anthropicKey });
  const res = await client.messages.create({
    model: config.ai.anthropicModel,
    max_tokens: 700,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: text }],
  });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function callOpenAI(text) {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: config.ai.openaiKey });
  const res = await client.chat.completions.create({
    model: config.ai.openaiModel,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
  });
  return res.choices[0].message.content;
}

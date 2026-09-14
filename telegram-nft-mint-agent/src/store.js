import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const FILE = path.join(DATA_DIR, 'tasks.json');

/** @type {Map<string, any>} */
const tasks = new Map();
let counter = 0;

export function createTask({ type, spec, startAt = null, deadline = null, chatId }) {
  const id = `${type}-${String(++counter).padStart(3, '0')}`;
  const task = {
    id,
    type,
    spec,
    startAt,
    deadline,
    chatId,
    status: 'queued',
    cancelled: false,
    createdAt: Date.now(),
  };
  tasks.set(id, task);
  persist();
  return task;
}

export const getTask = (id) => tasks.get(id);
export const listTasks = () => [...tasks.values()];
export const activeTasks = () =>
  listTasks().filter((t) => ['queued', 'watching', 'firing', 'sent', 'pending'].includes(t.status));

export function cancelTask(id) {
  const t = tasks.get(id);
  if (!t) return null;
  t.cancelled = true;
  if (['queued', 'watching'].includes(t.status)) t.status = 'cancelled';
  persist();
  return t;
}

export function cancelAll() {
  const cancelled = activeTasks().map((t) => cancelTask(t.id));
  return cancelled.filter(Boolean);
}

export function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const safe = listTasks().map(({ chatId, ...t }) => t); // chatId ফাইলে রাখি না
    fs.writeFileSync(FILE, JSON.stringify(safe, null, 2));
  } catch {
    /* persistence best-effort */
  }
}

export function formatTask(t) {
  const lines = [
    `*${t.id}* — ${t.status}`,
    `contract: \`${t.spec.contract}\``,
    `call: ${t.spec.fn ?? 'rawData'} ${t.spec.args?.length ? JSON.stringify(t.spec.args) : ''}`.trim(),
    `value: ${t.spec.valueEth} ETH`,
  ];
  if (t.startAt) lines.push(`start: ${new Date(t.startAt).toISOString()}`);
  if (t.txHash) lines.push(`tx: \`${t.txHash}\``);
  if (t.fireLatencyMs !== undefined) lines.push(`fire latency: ${t.fireLatencyMs}ms`);
  return lines.join('\n');
}

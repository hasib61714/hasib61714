/**
 * `contract=0x.. fn="mint(uint256)" args=[2] value=0.02` -> object
 * quote করা মান, JSON array — দুটোই বোঝে।
 */
export function parseKeyValues(input) {
  const out = {};
  const re = /(\w+)\s*=\s*("([^"]*)"|'([^']*)'|\[[^\]]*\]|\S+)/g;
  let m;
  while ((m = re.exec(input))) {
    let value = m[3] ?? m[4] ?? m[2];
    if (typeof value === 'string' && value.startsWith('[')) {
      try {
        value = JSON.parse(value);
      } catch {
        throw new Error(`args ভুল JSON: ${value}`);
      }
    }
    out[m[1].toLowerCase()] = value;
  }
  return out;
}

/** key=value গুলো থেকে MintSpec বানায়। */
export function toSpec(kv) {
  if (!kv.contract) throw new Error('contract= লাগবে');
  return {
    contract: kv.contract,
    fn: kv.fn ?? null,
    args: kv.args ?? [],
    rawData: kv.data ?? kv.rawdata ?? null,
    valueEth: kv.value !== undefined ? Number(kv.value) : 0,
    gasLimit: kv.gas ? Number(kv.gas) : null,
    label: kv.label ?? kv.contract,
  };
}

export function parseWhen(value) {
  if (!value) return null;
  // unix seconds বা ISO — দুটোই
  if (/^\d{10}$/.test(value)) return Number(value) * 1000;
  if (/^\d{13}$/.test(value)) return Number(value);
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`সময় বুঝলাম না: ${value} (ISO দাও, যেমন 2026-09-20T17:00:00Z)`);
  return t;
}

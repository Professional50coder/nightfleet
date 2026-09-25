// Tagged JSON codec for private state: bigint and Uint8Array survive a
// localStorage round-trip, everything else passes through JSON.

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));

export function encodeState(value) {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === 'bigint') return { $bigint: v.toString() };
    if (v instanceof Uint8Array) return { $bytes: toHex(v) };
    return v;
  });
}

export function decodeState(text) {
  if (text == null) return null;
  return JSON.parse(text, (_key, v) => {
    if (v && typeof v === 'object') {
      if (typeof v.$bigint === 'string') return BigInt(v.$bigint);
      if (typeof v.$bytes === 'string') return fromHex(v.$bytes);
    }
    return v;
  });
}

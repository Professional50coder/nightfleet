// @nightfleet/wallet - redaction.
//
// docs/15-SECURITY-AND-PRIVACY.md: wallet material never reaches the repo, the
// backend, or a log. This module is the single place that decides what a raw
// address turns into before anyone outside the connector sees it.

/** Anything that smells like key material and must never be echoed. */
const SECRET_KEY_PATTERN =
  /(seed|mnemonic|passphrase|privateKey|private_key|secretKey|secret_key|secret|password|token|signingKey|xprv)/i;

/** Default redaction window: enough to recognise, useless to reconstruct. */
export const REDACTION = Object.freeze({ lead: 10, tail: 6, ellipsis: '…' });

/**
 * Turn a raw bech32m address into a display string.
 * Short inputs are redacted wholesale rather than partially revealed.
 *
 * @param {unknown} address
 * @param {{ lead?: number, tail?: number, ellipsis?: string }} [opts]
 * @returns {string}
 */
export function redactAddress(address, opts = {}) {
  const { lead = REDACTION.lead, tail = REDACTION.tail, ellipsis = REDACTION.ellipsis } = opts;
  if (typeof address !== 'string' || address.length === 0) return '';
  // Never reveal so much that the whole value is recoverable from the display.
  if (address.length <= lead + tail + 2) return ellipsis;
  return `${address.slice(0, lead)}${ellipsis}${address.slice(-tail)}`;
}

/** Redact a transaction/hash blob the same way, for status UI. */
export function redactHash(hash, opts = {}) {
  return redactAddress(hash, { lead: 8, tail: 6, ...opts });
}

/**
 * Scrub an arbitrary value before it is handed to a logger.
 * Drops secret-looking keys entirely and redacts address-shaped strings.
 * Used for every event this package emits to a host-supplied logger.
 *
 * @param {unknown} value
 * @param {number} [depth]
 */
export function scrubForLog(value, depth = 0) {
  if (depth > 4) return '[depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return '[fn]';
  if (typeof value === 'string') return scrubString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrubForLog(v, depth + 1));
  if (value instanceof Error) return { name: value.name, code: value.code, message: value.message };

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(k)) { out[k] = '[redacted]'; continue; }
    out[k] = scrubForLog(v, depth + 1);
  }
  return out;
}

/**
 * Redact anything that looks like a Midnight address/key inside free text.
 * Bech32m payloads on Midnight are long; anything long and base32-ish goes.
 */
function scrubString(s) {
  // Two shapes: a Midnight human-readable prefix (mn_addr_test1...,
  // mn_shield-addr_test1..., which contain '-' and '_') followed by a bech32m
  // payload, or a bare long bech32m/hex blob with no prefix at all.
  return s.replace(
    /\b(mn_[a-z0-9_-]*1[02-9ac-hj-np-z]{20,}|[02-9ac-hj-np-z]{40,})\b/gi,
    (m) => redactAddress(m),
  );
}

/** True if this string would survive `scrubString` unchanged. */
export function isRedacted(s) {
  return typeof s === 'string' && scrubString(s) === s;
}

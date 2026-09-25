// Squad links: a shareable URL that names one on-chain game.
//
// The link carries the contract address and nothing else - the fleet, salt
// and secret key never leave each player's browser, and the game state is
// read back from the indexer, not from the URL.

export const SQUAD_HASH_PREFIX = '#/game/';
const ADDRESS_RE = /^[0-9a-f]{64}$/;

/**
 * @param {string} contractAddress 64-char hex contract address
 * @param {string} [base] page origin+path the link should open (defaults to the current page)
 * @returns {string} shareable squad link
 */
export function squadLinkFor(contractAddress, base) {
  if (!ADDRESS_RE.test(contractAddress)) {
    throw new Error(`not a contract address: ${contractAddress}`);
  }
  const origin = base ?? `${globalThis.location?.origin ?? ''}${globalThis.location?.pathname ?? ''}`;
  return `${origin}${SQUAD_HASH_PREFIX}${contractAddress}`;
}

/**
 * Parse a squad link or raw hash back into a contract address.
 * @param {string} linkOrHash full URL, bare hash, or bare address
 * @returns {string|null} the contract address, or null when the input names no game
 */
export function parseSquadLink(linkOrHash) {
  if (!linkOrHash) return null;
  const text = String(linkOrHash).trim();
  const at = text.indexOf(SQUAD_HASH_PREFIX);
  const candidate = at >= 0 ? text.slice(at + SQUAD_HASH_PREFIX.length) : text;
  const cleaned = candidate.split(/[?&#/]/)[0].toLowerCase();
  return ADDRESS_RE.test(cleaned) ? cleaned : null;
}

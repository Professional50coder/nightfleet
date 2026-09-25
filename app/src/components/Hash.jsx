/**
 * Shared presentation for commitment hashes (mono for every
 * hash/address; plus generative fingerprint tiles). Used by the
 * HUD and the proof inspector so the treatment never drifts between surfaces.
 */

/** Truncated mono hash, the perfekt signature treatment for anything ID-shaped. */
export function Hash({ value }) {
  if (!value) return <span className="mono dim">not committed</span>;
  return <span className="mono" title={value}>{value.slice(0, 8)}…{value.slice(-6)}</span>;
}

/**
 * Generative fingerprint tile for a commitment hash: a
 * 5x5 mirrored grid derived from the hash, so each commitment is visibly
 * distinct at a glance. Deterministic - same hash, same tile. The cells
 * carry a stagger index so the tile cascades in when it is revealed.
 */
export function Identicon({ value, label }) {
  if (!value) return null;
  const hex = value.toLowerCase().replace(/[^0-9a-f]/g, '');
  const nibble = (i) => {
    const h = parseInt(hex[i] ?? '', 16);
    return Number.isNaN(h) ? value.charCodeAt(i % value.length) % 16 : h;
  };
  const cells = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      cells.push(nibble(r * 3 + Math.min(c, 4 - c)));
    }
  }
  return (
    <span className="identicon" role="img" aria-label={`${label} commitment fingerprint`} title={value}>
      {cells.map((n, i) => (
        <i key={i} className={n % 2 ? 'on' : ''} style={{ '--v': (n / 15).toFixed(2), '--i': i }} />
      ))}
    </span>
  );
}

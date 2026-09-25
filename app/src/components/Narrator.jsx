/**
 * The referee's voice.
 *
 * Lines come from `ai/narrator.js`, which is template-driven and needs no API
 * key. That module accepts only whitelisted public events (commit / fire /
 * report / win) and throws on anything else, so a fleet layout cannot reach it
 * even by accident - the driver assembles the event from public fields only.
 */
export function Narrator({ lines = [], enabled = true, onToggle }) {
  const latest = lines.length > 0 ? lines[lines.length - 1] : null;
  const earlier = lines.slice(Math.max(0, lines.length - 4), lines.length - 1).reverse();

  return (
    <section className="panel narrator" aria-label="Referee narration">
      <header className="panel__head panel__head--tight">
        <h3>Referee</h3>
        <label className="toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle?.(e.target.checked)}
          />
          <span>narration</span>
        </label>
      </header>

      {!enabled ? (
        <p className="muted small">Narration off.</p>
      ) : latest ? (
        <>
          <p className="narrator__line" role="status" aria-live="polite">{latest.line}</p>
          {earlier.length > 0 ? (
            <ul className="narrator__history">
              {earlier.map((l) => <li key={l.seq}>{l.line}</li>)}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="muted small">The referee speaks once the first fleet is committed.</p>
      )}
    </section>
  );
}

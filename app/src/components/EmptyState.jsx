/**
 * Empty state: one calm treatment for every
 * "nothing here yet" surface - a glyph, a title, and a one-line hint of what
 * will appear. The glyph is decorative; the section around the empty state
 * owns the accessible name.
 */
export function EmptyState({ glyph = '\u25cc', title, hint }) {
  return (
    <div className="empty-state">
      <span className="empty-state__glyph" aria-hidden="true">{glyph}</span>
      <p className="empty-state__title">{title}</p>
      {hint ? <p className="empty-state__hint muted small">{hint}</p> : null}
    </div>
  );
}

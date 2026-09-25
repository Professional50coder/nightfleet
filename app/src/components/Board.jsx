import { useCallback, useRef } from 'react';
import { GRID_SIZE, GRID_CELLS, MARK, coordinateToIndex, indexToCoordinate, formatCoordinate } from '../game/protocol.js';

const COLUMNS = Array.from({ length: GRID_SIZE }, (_, i) => String.fromCharCode(65 + i));

/** Mark + ship -> a class, a glyph and a spoken description. */
function describeCell({ mark, ship, revealedShip }) {
  if (mark === MARK.HIT) return { cls: 'cell--hit', glyph: '✕', text: 'hit' };
  if (mark === MARK.MISS) return { cls: 'cell--miss', glyph: '•', text: 'miss' };
  if (ship) return { cls: 'cell--ship', glyph: '', text: 'your ship' };
  if (revealedShip) return { cls: 'cell--revealed', glyph: '', text: 'revealed ship' };
  return { cls: 'cell--fog', glyph: '', text: 'unknown' };
}

/**
 * The 8x8 board.
 *
 * `fleet` is only ever passed for a seat whose layout the viewer is entitled to
 * see - your own board, or a board released by revealFleets() after the game.
 * The enemy board during play receives `fleet={null}` and renders `marks`
 * alone, which is the fog rule made visible.
 *
 * @param {{
 *   mode?: 'editable'|'mine'|'enemy',
 *   fleet?: Array<0|1>|null,
 *   marks?: number[],
 *   preview?: number[],
 *   previewInvalid?: boolean,
 *   settledCells?: number[], // just-placed cells - settle spring (docs/18 section 1)
 *   disabled?: boolean,
 *   caption?: string,
 *   onCellActivate?: (index: number, coord: {x:number,y:number}) => void,
 *   onCellHover?: (index: number|null, coord: {x:number,y:number}|null) => void,
 *   freshIndex?: number|null,  // cell that just changed - pulses once (docs/18 section 2)
 *   rippleIndex?: number|null, // cell just fired at - ripples until the answer lands (docs/18 section 2)
 *   active?: boolean,          // this board is where the current turn happens
 * }} props
 */
export function Board({
  mode = 'mine',
  fleet = null,
  marks = Array(GRID_CELLS).fill(MARK.UNKNOWN),
  preview = [],
  previewInvalid = false,
  settledCells = [],
  disabled = false,
  caption,
  onCellActivate,
  onCellHover,
  freshIndex = null,
  rippleIndex = null,
  active = false,
}) {
  const gridRef = useRef(null);
  const previewSet = new Set(preview);
  const settledSet = new Set(settledCells);
  const interactive = Boolean(onCellActivate) && !disabled;

  const focusCell = useCallback((index) => {
    const node = gridRef.current?.querySelector(`[data-index="${index}"]`);
    if (node) node.focus();
  }, []);

  const onKeyDown = useCallback((event, index) => {
    const deltas = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    const { x, y } = indexToCoordinate(index);
    const nx = Math.min(GRID_SIZE - 1, Math.max(0, x + delta[0]));
    const ny = Math.min(GRID_SIZE - 1, Math.max(0, y + delta[1]));
    focusCell(coordinateToIndex({ x: nx, y: ny }));
  }, [focusCell]);

  return (
    <figure className={`board board--${mode}${active ? ' board--active' : ''}`}>
      <div className="board__frame">
        <div className="board__corner" aria-hidden="true" />
        <div className="board__cols" aria-hidden="true">
          {COLUMNS.map((c) => <span key={c} className="board__label">{c}</span>)}
        </div>
        <div className="board__rows" aria-hidden="true">
          {COLUMNS.map((_, i) => <span key={i} className="board__label">{i + 1}</span>)}
        </div>
        <div
          className="board__grid"
          role="grid"
          aria-label={caption ?? `${mode} board`}
          ref={gridRef}
        >
          {Array.from({ length: GRID_CELLS }, (_, index) => {
            const coord = indexToCoordinate(index);
            const name = formatCoordinate(coord);
            const mark = marks[index] ?? MARK.UNKNOWN;
            const ship = mode !== 'enemy' && fleet?.[index] === 1;
            const revealedShip = mode === 'enemy' && fleet?.[index] === 1;
            const { cls, glyph, text } = describeCell({ mark, ship, revealedShip });
            const inPreview = previewSet.has(index);
            return (
              <button
                key={index}
                type="button"
                data-index={index}
                data-testid={`cell-${mode}-${name}`}
                className={[
                  'cell', cls,
                  inPreview ? (previewInvalid ? 'cell--preview-bad' : 'cell--preview') : '',
                  interactive ? 'cell--live' : '',
                  index === freshIndex ? 'cell--fresh' : '',
                  settledSet.has(index) ? 'cell--settled' : '',
                ].filter(Boolean).join(' ')}
                role="gridcell"
                aria-label={`${name}, ${text}`}
                disabled={!interactive}
                onClick={() => onCellActivate?.(index, coord)}
                onMouseEnter={() => onCellHover?.(index, coord)}
                onMouseLeave={() => onCellHover?.(null, null)}
                onFocus={() => onCellHover?.(index, coord)}
                onKeyDown={(e) => onKeyDown(e, index)}
              >
                <span aria-hidden="true" className="cell__glyph">{glyph}</span>
                {index === rippleIndex ? (
                  <span className="cell__ripple" data-testid="fire-ripple" aria-hidden="true" />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      {caption ? <figcaption className="board__caption">{caption}</figcaption> : null}
    </figure>
  );
}

// Stylesheet performance audit : "60fps target: animate
// transform/opacity only; avoid layout thrash." These tests make the rule
// permanent - they fail if anyone adds a transition:all shortcut, a
// transition on a layout property, or a keyframe that animates layout.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const sheets = readdirSync('src/styles')
  .filter((f) => f.endsWith('.css'))
  .map((f) => [f, readFileSync(`src/styles/${f}`, 'utf8')]);

const LAYOUT_PROPS = ['width', 'height', 'top', 'right', 'bottom', 'left', 'margin', 'padding'];
const isLayoutProp = (prop) =>
  LAYOUT_PROPS.some((lp) => prop === lp || prop.startsWith(`${lp}-`));

/** Yield { name, body } for every @keyframes block via brace matching. */
function keyframeBlocks(css) {
  const blocks = [];
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = re.lastIndex;
    while (depth && i < css.length) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    blocks.push({ name: m[1], body: css.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return blocks;
}

describe('performance audit ', () => {
  it('has no transition:all shortcuts in any stylesheet', () => {
    expect(sheets.length).toBeGreaterThan(0);
    for (const [name, css] of sheets) {
      expect(/transition:\s*all\b/.test(css), `${name} uses transition:all`).toBe(false);
    }
  });

  it('never transitions layout properties', () => {
    for (const [name, css] of sheets) {
      for (const m of css.matchAll(/transition:\s*([^;]+);/g)) {
        const props = m[1].split(',').map((seg) => seg.trim().split(/\s+/)[0]);
        for (const prop of props) {
          expect(isLayoutProp(prop), `${name} transitions layout property "${prop}"`).toBe(false);
        }
      }
    }
  });

  it('animates no layout properties in any @keyframes', () => {
    for (const [name, css] of sheets) {
      for (const block of keyframeBlocks(css)) {
        const hits = block.body.match(/\b(?:width|height|top|right|bottom|left|margin|padding)[\w-]*\s*:/g);
        expect(hits, `@keyframes ${block.name} in ${name} animates layout: ${hits}`).toBeNull();
      }
    }
  });
});

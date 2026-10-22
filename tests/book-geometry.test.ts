import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BOOK, createLeafShape, hingeHeight, leafShape, stackHeights, turnAngle, visibleFaces
} from '../src/book-geometry.ts';
import { chooseMode, DESIGN_PAGE_H, frame } from '../src/camera.ts';

const LEAVES = 5;
const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

describe('leaf shape', () => {
  const shape = createLeafShape(BOOK.segments);

  it('keeps the sheet’s length, so page content is never stretched', () => {
    for (let theta = 0; theta <= Math.PI; theta += Math.PI / 40) {
      leafShape(theta, BOOK.bend, BOOK.pageW, shape);
      let length = 0;
      for (let i = 0; i < BOOK.segments; i += 1) length += Math.hypot(shape.x[i + 1] - shape.x[i], shape.z[i + 1] - shape.z[i]);
      assert.ok(close(length, BOOK.pageW, 1e-9), `length ${length} at ${theta}`);
    }
  });

  it('lies flat at rest on either side', () => {
    leafShape(0, BOOK.bend, BOOK.pageW, shape);
    assert.ok(close(shape.x[BOOK.segments], BOOK.pageW) && close(shape.z[BOOK.segments], 0));
    leafShape(Math.PI, BOOK.bend, BOOK.pageW, shape);
    assert.ok(close(shape.x[BOOK.segments], -BOOK.pageW, 1e-9) && close(shape.z[BOOK.segments], 0, 1e-9));
  });

  it('only rises from its hinge (angles within [0, π])', () => {
    for (let theta = 0; theta <= Math.PI; theta += Math.PI / 60) {
      leafShape(theta, BOOK.bend, BOOK.pageW, shape);
      shape.angle.forEach((angle) => assert.ok(angle >= 0 && angle <= Math.PI + 1e-12));
      for (let i = 1; i <= BOOK.segments; i += 1) assert.ok(shape.z[i] >= shape.z[i - 1] - 1e-12);
    }
  });

  it('turn angle is eased and reversible', () => {
    assert.equal(turnAngle(0), 0);
    assert.ok(close(turnAngle(1), Math.PI));
    assert.ok(close(turnAngle(0.5), Math.PI / 2));
    assert.ok(close(turnAngle(0.3) + turnAngle(0.7), Math.PI));
  });
});

describe('page stacks', () => {
  it('moves the block from right to left one leaf at a time', () => {
    for (let spread = 0; spread <= LEAVES; spread += 1) {
      const leaves = Array.from({ length: LEAVES }, (_, leaf) => (leaf < spread ? 1 : 0));
      const heights = stackHeights(leaves);
      assert.ok(close(heights.left + heights.right, BOOK.block, 1e-12));
      const paperTurned = Math.max(spread - 1, 0);
      assert.ok(close(heights.left, (BOOK.block * paperTurned) / (LEAVES - 1), 1e-12));
    }
  });

  it('keeps a turning sheet above both stacks where it lies over them', () => {
    const shape = createLeafShape(BOOK.segments);
    for (let leaf = 1; leaf < LEAVES; leaf += 1) {
      for (let p = 0; p <= 1.0001; p += 0.01) {
        const leaves = Array.from({ length: LEAVES }, (_, i) => (i < leaf ? 1 : i === leaf ? Math.min(p, 1) : 0));
        const heights = stackHeights(leaves);
        const hinge = hingeHeight(leaf, leaves[leaf], heights, LEAVES);
        leafShape(turnAngle(leaves[leaf]), BOOK.bend, BOOK.pageW, shape);
        for (let i = 0; i <= BOOK.segments; i += 1) {
          const x = shape.x[i];
          const z = hinge + shape.z[i];
          // Within a hair of the spine the sheet may graze the block edge it is bound to.
          if (Math.abs(x) < 0.02) continue;
          const top = x > 0 ? heights.right : heights.left;
          assert.ok(z >= top - 1e-9, `leaf ${leaf} p=${p.toFixed(2)} point ${i}: z ${z.toFixed(4)} < stack ${top.toFixed(4)}`);
        }
      }
    }
  });

  it('rests leaves on their stack and lands the cover on the table', () => {
    const heights = { right: 0.05, left: 0.02 };
    assert.equal(hingeHeight(2, 0, heights, LEAVES), 0.05);
    assert.equal(hingeHeight(2, 1, heights, LEAVES), 0.02);
    assert.equal(hingeHeight(0, 0, heights, LEAVES), BOOK.block);
    assert.equal(hingeHeight(0, 1, heights, LEAVES), 0);
  });
});

describe('visible faces', () => {
  it('shows the cover when closed and the right pair of pages per spread', () => {
    assert.deepEqual(visibleFaces([0, 0, 0, 0, 0]), { left: -1, right: 0, turning: -1 });
    assert.deepEqual(visibleFaces([1, 0, 0, 0, 0]), { left: 1, right: 2, turning: -1 });
    assert.deepEqual(visibleFaces([1, 1, 0.4, 0, 0]), { left: 3, right: 6, turning: 2 });
    assert.deepEqual(visibleFaces([1, 1, 1, 1, 1]), { left: 9, right: 10, turning: -1 });
  });
});

describe('framing', () => {
  const view = (width: number, height: number) => ({ width, height, top: 64, bottom: 60 });

  it('picks a layout that keeps text readable', () => {
    assert.equal(chooseMode(view(1440, 900), false), 'spread');
    assert.equal(chooseMode(view(1366, 768), false), 'spread');
    assert.equal(chooseMode(view(820, 1180), false), 'page');
    assert.equal(chooseMode(view(820, 1180), true), 'flow');
    assert.equal(chooseMode(view(390, 844), false), 'flow');
  });

  it('fits the open book between the top and bottom bars', () => {
    for (const [w, h] of [[1440, 900], [1280, 720], [1920, 1080], [1024, 768]]) {
      const v = view(w, h);
      const result = frame(v, 'spread', LEAVES, false);
      const bookH = (BOOK.pageH + 2 * BOOK.overhang) * result.ppu;
      const bookW = 2 * (BOOK.pageW + BOOK.overhang) * result.ppu;
      assert.ok(bookH <= h - v.top - v.bottom, `${w}x${h}: book ${bookH}px tall`);
      assert.ok(bookW <= w, `${w}x${h}: book ${bookW}px wide`);
      assert.ok(result.pageScale > 0.7 && result.pageScale <= 1.3);
      assert.ok(close(result.pageScale, (result.ppu * BOOK.pageH) / DESIGN_PAGE_H));
    }
  });
});

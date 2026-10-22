// Physical model of the book, in book-local coordinates (pure math, no Three.js).
//
//   x: across the spread, 0 at the spine, +x towards the right-hand fore-edge
//   y: up the page
//   z: out of the page, towards the reader (0 = inner surface of the back board)
//
// Every leaf (front cover board and paper leaves) turns about a hinge line at the
// spine. A leaf's shape is a chain of flat segments; segment i is rotated by
// angle[i] about the y axis, so a point (x, 0, 0) on it maps to (x·cos a, 0, x·sin a).

import { smoothstep } from './timeline.ts';

export const BOOK = {
  pageW: 1,
  pageH: 1.38,
  /** Board overhang beyond the paper on the top, bottom and fore-edge. */
  overhang: 0.035,
  board: 0.028,
  /** Thickness of the whole paper block. */
  block: 0.075,
  /** Lift of a page face above the surface it lies on, so faces never z-fight. */
  faceGap: 0.0012,
  /** Flat segments per paper leaf while it turns. */
  segments: 12,
  /** How far (radians) the free edge of a paper leaf leads the hinge mid-turn (0 = rigid). */
  bend: 1.25
} as const;

export interface StackHeights {
  right: number;
  left: number;
}

/**
 * Paper block heights. Leaf 0 is the front cover; the paper leaves (1..n) carry
 * the block's thickness from right to left. The right stack drops as the leaf
 * lifts off and the left stack rises only once the leaf has nearly landed, so the
 * page on either side stays visible until the turning leaf covers it.
 */
export function stackHeights(leaves: ArrayLike<number>, out: StackHeights = { right: 0, left: 0 }): StackHeights {
  const paper = leaves.length - 1;
  let gone = 0;
  let arrived = 0;
  for (let leaf = 1; leaf < leaves.length; leaf += 1) {
    gone += smoothstep(0.02, 0.3, leaves[leaf]);
    arrived += smoothstep(0.8, 0.98, leaves[leaf]);
  }
  out.right = BOOK.block * (1 - gone / paper);
  out.left = BOOK.block * (arrived / paper);
  return out;
}

/** Height of a leaf's hinge line. Resting leaves sit on their stack; a turning leaf travels between stacks. */
export function hingeHeight(leaf: number, progress: number, heights: StackHeights, leafCount: number): number {
  const travel = smoothstep(0.3, 0.7, progress);
  // The cover lies on top of the block when closed and on the table when open.
  if (leaf === 0) return BOOK.block * (1 - travel);
  if (progress <= 0) return heights.right;
  if (progress >= 1) return heights.left;
  const paper = leafCount - 1;
  const from = BOOK.block * (1 - (leaf - 1) / paper);
  const to = BOOK.block * (leaf / paper);
  return from + (to - from) * travel;
}

export interface VisibleFaces {
  /** Face on top of the left stack, or -1 when the book is closed. */
  left: number;
  /** Face on top of the right stack (the front cover while closed). */
  right: number;
  /** Leaf between the stacks, or -1. */
  turning: number;
}

/**
 * Which page faces can be seen. Faces are numbered in reading order: leaf L has
 * its front (recto) at 2L and its back (verso) at 2L + 1; the inside of the back
 * board comes last at 2 × leafCount.
 */
export function visibleFaces(leaves: ArrayLike<number>, out: VisibleFaces = { left: -1, right: -1, turning: -1 }): VisibleFaces {
  out.left = -1;
  out.right = -1;
  out.turning = -1;
  for (let leaf = 0; leaf < leaves.length; leaf += 1) {
    const progress = leaves[leaf];
    if (progress >= 1) out.left = 2 * leaf + 1;
    else if (progress <= 0) {
      if (out.right < 0) out.right = 2 * leaf;
    } else out.turning = leaf;
  }
  if (out.right < 0) out.right = 2 * leaves.length;
  return out;
}

/** Hinge rotation for a turn progress: eased so the page lifts and settles gently. */
export const turnAngle = (progress: number): number => Math.PI * smoothstep(0, 1, progress);

export interface LeafShape {
  /** Segment boundary points, from the hinge (index 0) to the free edge (index n). */
  x: Float64Array;
  z: Float64Array;
  /** Rotation of each segment about the hinge axis. */
  angle: Float64Array;
}

export function createLeafShape(segments: number): LeafShape {
  return { x: new Float64Array(segments + 1), z: new Float64Array(segments + 1), angle: new Float64Array(segments) };
}

/**
 * Shape of a leaf of `width` turned by `theta`. Paper bends so its free edge leads
 * the hinge, curling over the spine; the bend is zero at rest and greatest
 * mid-turn. Segment angles are kept within [0, π], so the sheet only ever rises
 * from its hinge and never dips into either stack, and the arc length always
 * equals `width`, so the page content is never stretched.
 */
export function leafShape(theta: number, bend: number, width: number, out: LeafShape): LeafShape {
  const segments = out.angle.length;
  const step = width / segments;
  const lead = bend * Math.sin(theta);
  out.x[0] = 0;
  out.z[0] = 0;
  for (let i = 0; i < segments; i += 1) {
    const along = (i + 0.5) / segments;
    const angle = Math.min(theta + lead * along ** 1.25, Math.PI);
    out.angle[i] = angle;
    out.x[i + 1] = out.x[i] + step * Math.cos(angle);
    out.z[i + 1] = out.z[i] + step * Math.sin(angle);
  }
  return out;
}

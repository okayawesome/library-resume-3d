// Scroll timeline: maps one number (scroll progress, in "units" of one viewport
// height) to the state of the book. Everything here is pure so the mapping is
// deterministic, reversible and testable without a browser.

export type LayoutMode = 'spread' | 'page';

export interface Segment {
  kind: 'dwell' | 'turn';
  /** Spread index for a dwell (0 = closed cover), leaf index for a turn (0 = front cover). */
  index: number;
  start: number;
  length: number;
}

export interface Timeline {
  mode: LayoutMode;
  /** Open spreads after the cover. The book has the same number of turnable leaves. */
  spreads: number;
  segments: Segment[];
  total: number;
}

export interface BookState {
  /** Turn progress per leaf: 0 = resting on the right, 1 = turned onto the left. */
  leaves: number[];
  /** Leaf currently between stacks, or -1 when the book is at rest. */
  turning: number;
  /** Continuous spread position: 0 = closed, n = spread n fully open. */
  spread: number;
  /** Spread the reader is looking at (for navigation and labels). */
  activeSpread: number;
  /** Camera focus across the spread: -1 = left page, 0 = centre, 1 = right page. */
  focus: number;
  /** Poses to blend between (pose 0 = closed cover, pose n = spread n) and the eased weight. */
  poseFrom: number;
  poseTo: number;
  poseMix: number;
}

// Segment lengths in viewport heights. Dwells are where the reader stops and reads;
// turns are kept shorter so most resting scroll positions land on an open spread.
const LENGTHS: Record<LayoutMode, { cover: number; open: number; dwell: number; turn: number; last: number }> = {
  spread: { cover: 0.55, open: 1.1, dwell: 0.9, turn: 0.75, last: 1.0 },
  // One page is framed at a time, so each dwell also holds a pan from left to right page.
  page: { cover: 0.55, open: 1.1, dwell: 1.5, turn: 0.8, last: 1.5 }
};

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp01((v - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function buildTimeline(spreads: number, mode: LayoutMode): Timeline {
  const lengths = LENGTHS[mode];
  const segments: Segment[] = [];
  let at = 0;
  const push = (kind: Segment['kind'], index: number, length: number): void => {
    segments.push({ kind, index, start: at, length });
    at += length;
  };
  push('dwell', 0, lengths.cover);
  for (let spread = 1; spread <= spreads; spread += 1) {
    push('turn', spread - 1, spread === 1 ? lengths.open : lengths.turn);
    push('dwell', spread, spread === spreads ? lengths.last : lengths.dwell);
  }
  return { mode, spreads, segments, total: at };
}

export function segmentAt(timeline: Timeline, units: number): { segment: Segment; local: number } {
  const { segments } = timeline;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (units < segment.start + segment.length || i === segments.length - 1) {
      return { segment, local: clamp01((units - segment.start) / segment.length) };
    }
  }
  throw new Error('Timeline has no segments');
}

/** Book state at a scroll position. `out` is reused to avoid per-frame allocation. */
export function sample(timeline: Timeline, units: number, out?: BookState): BookState {
  const state: BookState = out ?? {
    leaves: new Array<number>(timeline.spreads).fill(0),
    turning: -1, spread: 0, activeSpread: 0, focus: 0, poseFrom: 0, poseTo: 0, poseMix: 0
  };
  const { segment, local } = segmentAt(timeline, Math.min(Math.max(units, 0), timeline.total));
  const pageMode = timeline.mode === 'page';

  if (segment.kind === 'dwell') {
    const spread = segment.index;
    for (let leaf = 0; leaf < timeline.spreads; leaf += 1) state.leaves[leaf] = leaf < spread ? 1 : 0;
    state.turning = -1;
    state.spread = spread;
    state.activeSpread = spread;
    state.poseFrom = spread;
    state.poseTo = spread;
    state.poseMix = 0;
    // The closed book sits over the right-hand half; open spreads pan left page → right page.
    state.focus = !pageMode ? 0 : spread === 0 ? 1 : -1 + 2 * smoothstep(0.38, 0.62, local);
  } else {
    const leaf = segment.index;
    for (let i = 0; i < timeline.spreads; i += 1) state.leaves[i] = i < leaf ? 1 : i === leaf ? local : 0;
    const eased = smoothstep(0, 1, local);
    state.turning = local > 0 && local < 1 ? leaf : -1;
    state.spread = leaf + eased;
    state.activeSpread = local < 0.5 ? leaf : leaf + 1;
    state.poseFrom = leaf;
    state.poseTo = leaf + 1;
    state.poseMix = eased;
    // In page mode the camera follows the turning leaf from the right page to the left one.
    state.focus = pageMode ? 1 - 2 * eased : 0;
  }
  return state;
}

/** Scroll position (units) where a spread is comfortably readable. */
export function unitsForSpread(timeline: Timeline, spread: number, side: 'left' | 'right' | 'centre' = 'centre'): number {
  const segment = timeline.segments.find((item) => item.kind === 'dwell' && item.index === spread);
  if (!segment) throw new Error(`No dwell for spread ${spread}`);
  if (timeline.mode === 'page' && spread > 0 && side !== 'centre') {
    return segment.start + segment.length * (side === 'left' ? 0.2 : 0.8);
  }
  return spread === 0 ? segment.start : segment.start + segment.length * 0.5;
}

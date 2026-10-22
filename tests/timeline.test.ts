import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTimeline, sample, segmentAt, unitsForSpread, type LayoutMode } from '../src/timeline.ts';

const SPREADS = 5;
const modes: LayoutMode[] = ['spread', 'page'];

describe('timeline', () => {
  for (const mode of modes) {
    describe(`${mode} mode`, () => {
      const timeline = buildTimeline(SPREADS, mode);

      it('lays segments end to end, alternating dwell and turn', () => {
        let at = 0;
        timeline.segments.forEach((segment, i) => {
          assert.equal(segment.start, at);
          assert.equal(segment.kind, i % 2 === 0 ? 'dwell' : 'turn');
          at += segment.length;
        });
        assert.equal(timeline.total, at);
        assert.equal(timeline.segments.filter((s) => s.kind === 'turn').length, SPREADS);
      });

      it('never has more than one leaf in the air, and leaves stay in order', () => {
        for (let units = -0.5; units <= timeline.total + 0.5; units += 0.01) {
          const state = sample(timeline, units);
          const inAir = state.leaves.filter((p) => p > 0 && p < 1).length;
          assert.ok(inAir <= 1, `at ${units}: ${state.leaves}`);
          for (let leaf = 1; leaf < state.leaves.length; leaf += 1) {
            assert.ok(state.leaves[leaf - 1] >= state.leaves[leaf], `leaf ${leaf} ahead of leaf ${leaf - 1} at ${units}`);
          }
        }
      });

      it('is continuous: small scroll steps never jump a page', () => {
        const step = 0.002;
        let previous = sample(timeline, 0);
        for (let units = step; units <= timeline.total; units += step) {
          const state = sample(timeline, units);
          const { segment } = segmentAt(timeline, units);
          const limit = step / Math.min(segment.length, 0.5) + 1e-9;
          state.leaves.forEach((p, leaf) => assert.ok(Math.abs(p - previous.leaves[leaf]) <= limit, `jump on leaf ${leaf} at ${units}`));
          assert.ok(Math.abs(state.spread - previous.spread) < 0.02, `spread jump at ${units}`);
          assert.ok(Math.abs(state.focus - previous.focus) < 0.05, `focus jump at ${units}`);
          previous = { ...state, leaves: [...state.leaves] };
        }
      });

      it('is a pure function of scroll position (reversible, order-independent)', () => {
        const probe = [0.3, 2.2, 4.1, 6.66, 8.1];
        const forward = probe.map((u) => JSON.stringify(sample(timeline, u)));
        // Visit positions in a scrambled order, reusing one output object as the app does.
        const reused = sample(timeline, timeline.total);
        const scrambled = [...probe].reverse().map((u) => [u, JSON.stringify(sample(timeline, u, reused))] as const);
        for (const [u, json] of scrambled) assert.equal(json, forward[probe.indexOf(u)]);
      });

      it('clamps outside the timeline', () => {
        assert.deepEqual(sample(timeline, -3).leaves, [0, 0, 0, 0, 0]);
        assert.deepEqual(sample(timeline, timeline.total + 3).leaves, [1, 1, 1, 1, 1]);
      });

      it('reading positions land on a resting, open spread', () => {
        for (let spread = 0; spread <= SPREADS; spread += 1) {
          for (const side of ['left', 'right', 'centre'] as const) {
            const state = sample(timeline, unitsForSpread(timeline, spread, side));
            assert.equal(state.turning, -1);
            assert.equal(state.activeSpread, spread);
            assert.deepEqual(state.leaves, state.leaves.map((_, leaf) => (leaf < spread ? 1 : 0)));
            if (mode === 'page' && spread > 0 && side !== 'centre') assert.equal(state.focus, side === 'left' ? -1 : 1);
          }
        }
      });
    });
  }

  it('starts on the closed cover', () => {
    const state = sample(buildTimeline(SPREADS, 'spread'), 0);
    assert.equal(state.activeSpread, 0);
    assert.equal(unitsForSpread(buildTimeline(SPREADS, 'spread'), 0), 0);
  });
});

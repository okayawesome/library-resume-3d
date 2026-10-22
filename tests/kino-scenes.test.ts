import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MARGIN_FRAMES, SCENE_FRAMES, SCENES, renderFrame, renderMarginFrame, sceneRatio } from '../src/kino-scenes.ts';

const names = Object.keys(SCENES);

describe('kineograph scenes', () => {
  it('has a drawing for every figure used in the book', () => {
    const used = ['bottleneck', 'gears', 'loadtest', 'savings', 'qualify', 'interface', 'network', 'neural', 'platformer', 'stamps', 'plane'];
    assert.deepEqual([...names].sort(), [...used].sort());
  });

  for (const name of names) {
    it(`${name}: every frame is valid SVG with finite coordinates`, () => {
      for (let frame = 0; frame < SCENE_FRAMES; frame += 1) {
        const svg = renderFrame(name, frame);
        assert.match(svg, /^<svg viewBox="0 0 320 \d+"/);
        assert.ok(svg.endsWith('</svg>'));
        assert.ok(!/NaN|Infinity|undefined/.test(svg), `${name} frame ${frame} has invalid numbers`);
        assert.equal((svg.match(/<g /g) ?? []).length, (svg.match(/<\/g>/g) ?? []).length);
        assert.ok(svg.includes(`${String(frame + 1).padStart(2, '0')}/${SCENE_FRAMES}`), 'shows its flip-book page number');
      }
    });

    it(`${name}: deterministic, and every frame differs (the drawing moves or boils)`, () => {
      const frames = Array.from({ length: SCENE_FRAMES }, (_, frame) => renderFrame(name, frame));
      assert.equal(renderFrame(name, 5), frames[5]);
      assert.equal(new Set(frames).size, SCENE_FRAMES);
    });
  }

  it('reports each scene’s aspect ratio', () => {
    for (const name of names) assert.ok(sceneRatio(name) > 2 && sceneRatio(name) < 5);
  });

  it('draws a runner for the page corners', () => {
    const frames = Array.from({ length: MARGIN_FRAMES }, (_, frame) => renderMarginFrame(frame));
    assert.equal(new Set(frames).size, MARGIN_FRAMES);
    frames.forEach((svg) => assert.ok(!/NaN/.test(svg)));
  });
});

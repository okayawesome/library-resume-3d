import { MARGIN_FRAMES, SCENE_FRAMES, renderFrame, renderMarginFrame, sceneRatio } from './kino-scenes.ts';
import type { Timeline } from './timeline.ts';
import { spreadOfFace } from './ui.ts';

// Kineograph controller. Each page's drawing is a reel of frames; the frame
// shown is chosen by how far the reader has flipped, never by a clock. Scrolling
// forward flicks the frames on, scrolling back runs them backwards, and stopping
// holds the frame, exactly like a flip-book. Each drawing finishes by the
// position where its page is read, so a resting page shows the complete picture.
// The runner in the corner of the right-hand pages flicks continuously as you flip.

interface Reel {
  stage: HTMLElement;
  face: number;
  frames: number;
  frame: number;
  /** Scroll window (timeline units) over which the reel plays. */
  start: number;
  span: number;
}

function buildReel(stage: HTMLElement, frames: string[]): void {
  stage.style.setProperty('--n', String(frames.length));
  stage.innerHTML = `<div class="kino-reel">${frames.join('')}</div>`;
}

export class Kineograph {
  private readonly reels: Reel[] = [];
  private readonly runners: Reel[] = [];

  constructor(faces: HTMLElement[]) {
    const marginFrames = Array.from({ length: MARGIN_FRAMES }, (_, frame) => renderMarginFrame(frame));
    faces.forEach((face, index) => {
      face.querySelectorAll<HTMLElement>('.kino[data-kino]').forEach((figure) => {
        const name = figure.dataset.kino ?? '';
        const stage = figure.querySelector<HTMLElement>('.kino-stage');
        if (!stage) return;
        stage.style.setProperty('--ratio', String(sceneRatio(name)));
        buildReel(stage, Array.from({ length: SCENE_FRAMES }, (_, frame) => renderFrame(name, frame)));
        this.reels.push({ stage, face: index, frames: SCENE_FRAMES, frame: -1, start: 0, span: 1 });
      });
      face.querySelectorAll<HTMLElement>('.margin-flip').forEach((stage) => {
        buildReel(stage, marginFrames);
        this.runners.push({ stage, face: index, frames: MARGIN_FRAMES, frame: -1, start: 0, span: 1 });
      });
    });
  }

  /** Book layouts: work out when each page is revealed and read. */
  setTimeline(timeline: Timeline): void {
    for (const reel of this.reels) {
      const { spread, side } = spreadOfFace(reel.face);
      const dwell = timeline.segments.find((segment) => segment.kind === 'dwell' && segment.index === spread);
      if (!dwell) continue;
      // Page mode reads the left page at 20% of the dwell and the right at 80%.
      if (timeline.mode === 'page') {
        reel.start = dwell.start + (side === 'right' ? 0.5 : 0) * dwell.length;
        reel.span = (side === 'right' ? 0.28 : 0.18) * dwell.length;
      } else {
        reel.start = dwell.start;
        reel.span = 0.42 * dwell.length;
      }
    }
  }

  showBook(units: number, reduced: boolean): void {
    for (const reel of this.reels) this.show(reel, reduced ? 1 : (units - reel.start) / reel.span);
    const step = reduced ? 0 : Math.floor(units * 7) % MARGIN_FRAMES;
    for (const runner of this.runners) this.set(runner, step);
  }

  /** Flow layout: each drawing plays as it scrolls up into view. Reads layout, so call once per frame at most. */
  showFlow(viewportHeight: number, reduced: boolean): void {
    for (const reel of this.reels) {
      const top = reel.stage.getBoundingClientRect().top;
      this.show(reel, reduced ? 1 : (viewportHeight * 0.92 - top) / (viewportHeight * 0.45));
    }
    const step = reduced ? 0 : Math.floor(window.scrollY / 70) % MARGIN_FRAMES;
    for (const runner of this.runners) this.set(runner, step);
  }

  /**
   * Page-curl strips are static copies of a page. A leaf in the air is either
   * leaving (its drawings already finished) or arriving (not yet started), so each
   * copy keeps just that one frame, which also keeps the copies light.
   */
  freeze(clone: HTMLElement, which: 'first' | 'last'): void {
    clone.querySelectorAll<HTMLElement>('.kino-stage, .margin-flip').forEach((stage) => {
      const frames = Array.from(stage.querySelectorAll('.kino-reel > svg'));
      const keep = stage.classList.contains('margin-flip') || which === 'first' ? frames[0] : frames[frames.length - 1];
      frames.forEach((svg) => { if (svg !== keep) svg.remove(); });
      stage.style.setProperty('--n', '1');
      stage.style.setProperty('--frame', '0');
    });
  }

  private show(reel: Reel, progress: number): void {
    const clamped = progress < 0 ? 0 : progress > 1 ? 1 : progress;
    this.set(reel, Math.round(clamped * (reel.frames - 1)));
  }

  private set(reel: Reel, frame: number): void {
    if (frame === reel.frame) return;
    reel.frame = frame;
    reel.stage.style.setProperty('--frame', String(frame));
  }
}

import './style.css';
import { BOOK } from './book-geometry.ts';
import { blendPose, chooseMode, frame, type Framing, type Pose, type Viewport } from './camera.ts';
import type { FaceProjector } from './faces.ts';
import { Kineograph } from './kino.ts';
import { QualityController } from './quality.ts';
import type { BookScene } from './scene.ts';
import { ScrollController } from './scroll.ts';
import { buildTimeline, sample, smoothstep, unitsForSpread, type BookState, type LayoutMode, type Timeline } from './timeline.ts';
import { ReaderUI, describeSpreads, spreadOfFace } from './ui.ts';

// Entry point. One scroll position drives everything:
//   scroll (scroll.ts) → book state (timeline.ts) → pose (camera.ts)
//   → WebGL book (scene.ts) + HTML pages (faces.ts) + reader UI (ui.ts)
// in a single requestAnimationFrame loop that stops when nothing is moving.
// Three.js is loaded on demand, so phones and fallbacks never download it.

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: #${id}`);
  return element as T;
};

const root = document.documentElement;
const bookLayer = byId<HTMLElement>('book');
const sceneHost = byId<HTMLElement>('bookScene');
const topbar = document.querySelector<HTMLElement>('.topbar');
const readerBar = document.querySelector<HTMLElement>('.reader-bar');
const faces = Array.from(bookLayer.querySelectorAll<HTMLElement>(':scope > .face'));
// Faces: cover outside, then two per leaf, then the inside of the back board.
const LEAVES = (faces.length - 1) / 2;
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const bootTime = performance.now();

let mode: LayoutMode | 'flow' = 'flow';
let timeline: Timeline | null = null;
let framing: Framing | null = null;
let book: BookScene | null = null;
let projector: FaceProjector | null = null;
let webglUnavailable = false;
let loading = false;
let state: BookState | undefined;
const pose: Pose = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, tx: 0, ty: 0, d: 1 };

const scroll = new ScrollController(byId('scrollTrack'));
const quality = new QualityController((next) => {
  book?.setQuality(next);
  invalidate();
});
// `?motion=reduce` previews the reduced-motion reading mode without changing OS settings.
const forceReducedMotion = new URLSearchParams(window.location.search).get('motion') === 'reduce';
const reducedMotion = (): boolean => forceReducedMotion || motionQuery.matches;

// Flip-book drawings are built before anything copies the pages for page curls.
const kino = new Kineograph(faces);

const ui = new ReaderUI({
  faces,
  intro: document.querySelector<HTMLElement>('.intro') as HTMLElement,
  rail: byId<HTMLOListElement>('chapterRail'),
  railFill: byId('railFill'),
  chapterName: byId('chapterName'),
  pageCount: byId('pageCount'),
  prev: byId<HTMLButtonElement>('prevSpread'),
  next: byId<HTMLButtonElement>('nextSpread')
}, describeSpreads(faces, LEAVES), {
  scrollToUnits: (units, smooth) => scroll.scrollToUnits(units, smooth),
  currentUnits: () => scroll.target,
  isFaceVisible: (face) => projector?.isVisible(face) ?? true,
  reducedMotion
});

function measureViewport(): Viewport {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    top: topbar?.offsetHeight ?? 64,
    bottom: readerBar?.offsetHeight ?? 56
  };
}

/** Loads Three.js and builds the book the first time a 3D layout is wanted. */
function loadBook(): void {
  if (book || loading || webglUnavailable) return;
  loading = true;
  Promise.all([import('./scene.ts'), import('./faces.ts')]).then(([{ BookScene }, { FaceProjector }]) => {
    const created = new BookScene(sceneHost, LEAVES, quality.quality);
    book = created;
    // A strip's front is the page leaving (drawing finished); its back is arriving (not started).
    projector = new FaceProjector(bookLayer, faces, (clone, side) => kino.freeze(clone, side === 'front' ? 'last' : 'first'));
    created.renderer.domElement.addEventListener('webglcontextlost', (event) => {
      // Fall back to the readable layout rather than leaving a blank book.
      event.preventDefault();
      webglUnavailable = true;
      requestLayout();
    });
    // Build the page-curl strips while idle so the first page turn does not stall.
    const idle = window.requestIdleCallback ?? ((callback: () => void) => window.setTimeout(callback, 200));
    idle(() => projector?.prewarm(LEAVES));
    document.fonts?.ready.then(() => {
      book?.refreshLabels();
      invalidate();
    });
  }).catch((error: unknown) => {
    console.warn('The 3D book is unavailable; showing the résumé as plain pages.', error);
    webglUnavailable = true;
  }).finally(() => {
    loading = false;
    requestLayout();
  });
}

/** Where the reader is, so a layout change can return them to the same page. */
function readingPosition(): { spread: number; side: 'left' | 'right' | 'centre' } | null {
  if (!timeline || !state) return null;
  const side = timeline.mode === 'page' && state.activeSpread > 0 ? (state.focus < 0 ? 'left' : 'right') : 'centre';
  return { spread: state.activeSpread, side };
}

function applyLayout(): void {
  const view = measureViewport();
  const reduced = reducedMotion();
  const nextMode = webglUnavailable ? 'flow' : chooseMode(view, reduced);
  if (nextMode !== 'flow') loadBook();
  const position = readingPosition();
  const previousUnits = scroll.target;
  const pending = ui.pendingUnits();
  const modeChanged = nextMode !== mode;
  mode = nextMode;

  if (mode === 'flow') {
    root.classList.remove('is-book');
    root.classList.add('is-flow');
    projector?.reset();
    if (webglUnavailable && book) {
      book.dispose();
      book = null;
      projector = null;
    }
    timeline = null;
    framing = null;
    ui.setFlow();
    kino.showFlow(view.height, reduced);
    if (modeChanged && position) ui.goToFace(position.spread === 0 ? 0 : position.side === 'left' ? 2 * position.spread - 1 : 2 * position.spread, false);
    return;
  }

  root.classList.add('is-book');
  root.classList.remove('is-flow');
  const sameTimeline = timeline?.mode === mode;
  if (!sameTimeline) timeline = buildTimeline(LEAVES, mode);
  const activeTimeline = timeline as Timeline;
  framing = frame(view, mode, LEAVES, reduced);
  scroll.layout(activeTimeline.total, view.height);
  projector?.setScale(framing.ppu, framing.pageScale, view.width, view.height);
  book?.setSize(view.width, view.height);
  ui.setTimeline(activeTimeline);
  kino.setTimeline(activeTimeline);

  // Keep the reader on the same page: same units within a timeline, same page across modes.
  let units = previousUnits;
  if (!sameTimeline && position) units = unitsForSpread(activeTimeline, position.spread, position.side);
  if (modeChanged || !sameTimeline || Math.abs(window.scrollY - units * view.height) > 1) scroll.scrollToUnits(units, false);
  scroll.read();
  scroll.jump();
  // A resize mid-navigation (e.g. a chapter jump) carries on to its destination.
  if (sameTimeline && !modeChanged && pending !== null) scroll.scrollToUnits(pending, !reduced);
}

function renderBook(moving: boolean): void {
  if (!book || !projector || !timeline || !framing) return;
  state = sample(timeline, scroll.current, state);
  const reduced = reducedMotion();
  let fade = 1;
  if (reduced && state.turning >= 0) {
    // Reduced motion: no turning or camera travel. The spread fades out and the
    // next one fades in at the midpoint of the same scroll distance.
    const progress = state.leaves[state.turning];
    fade = smoothstep(0.08, 0.7, Math.abs(progress * 2 - 1));
    const after = progress >= 0.5;
    state.leaves[state.turning] = after ? 1 : 0;
    state.poseMix = after ? 1 : 0;
    state.spread = state.poseFrom + (after ? 1 : 0);
    state.turning = -1;
  }
  blendPose(framing.poses[state.poseFrom], framing.poses[state.poseTo], state.poseMix, pose);
  if (!reduced && state.poseFrom > 0 && state.poseFrom !== state.poseTo) {
    // The camera eases back while a page is in the air, so its arc stays in frame.
    const lift = Math.sin(Math.PI * state.poseMix);
    pose.d *= 1 + 0.08 * lift;
    pose.rx -= 0.02 * lift;
  }
  book.update(state, pose, state.focus, mode === 'page', reduced ? 0 : BOOK.bend);
  projector.update(book, moving);
  book.render();
  root.classList.add('is-ready');
  ui.update(state, scroll.current);
  kino.showBook(scroll.current, reduced);
  const opacity = fade.toFixed(3);
  if (bookLayer.style.opacity !== opacity) bookLayer.style.opacity = sceneHost.style.opacity = opacity;
}

// Frame loop: runs only while something is changing, then renders one settled
// frame (with will-change dropped so the browser re-rasterises text crisply).
let running = false;
let layoutPending = true;
let lastFrame = 0;
let settledFrames = 0;

function tick(now: number): void {
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  if (layoutPending) {
    layoutPending = false;
    applyLayout();
    settledFrames = 0;
  }
  if (mode === 'flow') {
    running = false;
    return;
  }
  const moving = scroll.step(dt, reducedMotion());
  if (moving) {
    settledFrames = 0;
    quality.sample(dt * 1000);
  } else {
    settledFrames += 1;
  }
  renderBook(moving);
  if (settledFrames < 2 && !document.hidden) window.requestAnimationFrame(tick);
  else running = false;
}

function invalidate(): void {
  if (running || document.hidden) return;
  running = true;
  lastFrame = performance.now();
  window.requestAnimationFrame(tick);
}

function requestLayout(): void {
  layoutPending = true;
  invalidate();
}

let flowFrame = 0;
window.addEventListener('scroll', () => {
  if (mode === 'flow' && !flowFrame) {
    flowFrame = window.requestAnimationFrame(() => {
      flowFrame = 0;
      kino.showFlow(window.innerHeight, reducedMotion());
    });
  }
  scroll.read();
  // A restored scroll position on reload should not flick through the book.
  if (performance.now() - bootTime < 600) scroll.jump();
  invalidate();
}, { passive: true });
window.addEventListener('resize', requestLayout, { passive: true });
motionQuery.addEventListener('change', requestLayout);
document.addEventListener('visibilitychange', invalidate);
window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  book?.dispose();
  book = null;
});

// Right-hand (recto) and left-hand (verso) pages put their folio on the outer edge.
faces.forEach((face, index) => {
  face.dataset.side = index % 2 === 0 ? 'recto' : 'verso';
});
document.querySelectorAll('[data-year]').forEach((node) => {
  node.textContent = String(new Date().getFullYear());
});

// Lay out synchronously so the scroll track exists before the browser restores scroll.
layoutPending = false;
applyLayout();
root.classList.remove('is-pending');
window.addEventListener('hashchange', () => {
  const face = faces.findIndex((item) => item.id && `#${item.id}` === window.location.hash);
  if (face >= 0) ui.goToFace(face);
});

// Deep links (#experience…) open the book at that page. The browser scrolls to the
// anchor itself once loaded (to the top, as the pages are fixed), so apply it again then.
const initial = faces.findIndex((face) => face.id && `#${face.id}` === window.location.hash);
if (initial > 0) {
  ui.goToFace(initial, false);
  window.addEventListener('load', () => window.requestAnimationFrame(() => {
    ui.goToFace(initial, false);
    scroll.read();
    scroll.jump();
    invalidate();
  }), { once: true });
}
scroll.read();
scroll.jump();
invalidate();

if (import.meta.env.DEV) {
  // Inspection handle for manual testing in the browser console.
  Object.assign(window, {
    __book: {
      get mode() { return mode; },
      get state() { return state; },
      get units() { return { target: scroll.target, current: scroll.current, total: timeline?.total }; },
      get quality() { return quality.tier; },
      unitsForSpread: (spread: number, side?: 'left' | 'right' | 'centre') => (timeline ? unitsForSpread(timeline, spread, side) : 0),
      spreadOfFace,
      visible: () => (projector ? [...projector.visible] : []),
      get scene() { return book; },
      get projector() { return projector; }
    }
  });
}

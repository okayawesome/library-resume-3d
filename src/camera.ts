// Camera controller maths: framing and the small set of poses the camera moves
// between. Pure numbers only; scene.ts applies them to Three.js objects.

import { BOOK, type StackHeights } from './book-geometry.ts';
import type { LayoutMode } from './timeline.ts';

export const FOV = 30;
/** Page size in CSS pixels that the page typography is designed for (scale 1). */
export const DESIGN_PAGE_H = 662;
const TAN_HALF = Math.tan((FOV * Math.PI) / 360);
const MAX_PAGE_SCALE = 1.3;

export interface Viewport {
  width: number;
  height: number;
  /** Space taken by fixed UI at the top and bottom, in px. */
  top: number;
  bottom: number;
}

/** Book transform (world) plus a camera that looks straight down -z at (tx, ty) from distance d. */
export interface Pose {
  px: number; py: number; pz: number;
  rx: number; ry: number; rz: number;
  tx: number; ty: number; d: number;
}

export interface Framing {
  mode: LayoutMode | 'flow';
  /** Pixels per world unit at the reading distance. */
  ppu: number;
  /** Page typography scale (1 = designed size). */
  pageScale: number;
  /** Pose 0 is the closed cover, pose n is spread n. */
  poses: Pose[];
}

const SPREAD_BOX = { w: 2 * (BOOK.pageW + BOOK.overhang), h: BOOK.pageH + 2 * BOOK.overhang };
const PAGE_BOX = { w: BOOK.pageW + BOOK.overhang, h: BOOK.pageH + 2 * BOOK.overhang };

function fit(view: Viewport, box: { w: number; h: number }): number {
  const marginX = Math.max(20, view.width * 0.035);
  const marginY = Math.max(14, view.height * 0.025);
  const availW = view.width - 2 * marginX;
  const availH = view.height - view.top - view.bottom - 2 * marginY;
  return Math.min(availW / box.w, availH / box.h);
}

const scaleFor = (ppu: number): number => (ppu * BOOK.pageH) / DESIGN_PAGE_H;
const distanceFor = (view: Viewport, ppu: number): number => view.height / (2 * TAN_HALF * ppu);

/**
 * Chooses how the résumé is presented for a viewport. A two-page spread is used
 * when its text stays readable; otherwise one page is framed at a time; below
 * that (phones) the pages are laid out as a normal scrolling document.
 */
export function chooseMode(view: Viewport, reducedMotion: boolean): LayoutMode | 'flow' {
  if (view.width < 600) return 'flow';
  const spread = scaleFor(fit(view, SPREAD_BOX));
  const page = scaleFor(fit(view, PAGE_BOX));
  // On tall screens one page at a time can be far larger than a cramped spread.
  const pageIsMuchBetter = page > spread * 1.3;
  if (spread >= 0.74 && !pageIsMuchBetter) return 'spread';
  // Page-by-page reading needs camera pans, which reduced motion avoids.
  if (!reducedMotion && page >= 0.8) return 'page';
  return 'flow';
}

export function frame(view: Viewport, mode: LayoutMode, spreads: number, reducedMotion: boolean): Framing {
  const box = mode === 'spread' ? SPREAD_BOX : PAGE_BOX;
  // Leave a little air so the per-spread framing can breathe without cropping the book.
  let ppu = fit(view, box) * 0.95;
  ppu = Math.min(ppu, (MAX_PAGE_SCALE * DESIGN_PAGE_H) / BOOK.pageH);
  const d = distanceFor(view, ppu);
  // Shift the camera so the book is centred in the space between the top and bottom bars.
  const ty = (view.top - view.bottom) / 2 / ppu;

  const reading = (rx: number, ry: number, zoom: number): Pose => ({
    px: 0, py: 0, pz: 0, rx, ry, rz: 0, tx: 0, ty, d: d / zoom
  });

  // Establishing shot: the closed book, further away and turned to show its spine
  // and page edges. On wide screens it sits to the right of the introduction.
  // On tall screens the introduction sits above the book instead of beside it.
  const wide = view.width / view.height > 1.25;
  const coverD = d * (wide ? 1.22 : 1.55);
  const coverPpu = view.height / (2 * TAN_HALF * coverD);
  const anchorX = wide ? 0.66 : 0.5;
  const anchorY = wide ? 0.54 : 0.66;
  const cover: Pose = {
    px: ((anchorX - 0.5) * view.width) / coverPpu,
    py: ty - ((anchorY - 0.5) * view.height) / coverPpu,
    pz: 0,
    rx: reducedMotion ? -0.08 : -0.42,
    ry: reducedMotion ? 0 : wide ? 0.5 : 0.36,
    rz: reducedMotion ? 0 : 0.05,
    tx: 0, ty, d: coverD
  };

  const poses: Pose[] = [cover];
  for (let spread = 1; spread <= spreads; spread += 1) {
    if (reducedMotion) {
      poses.push(reading(-0.1, 0, 1));
      continue;
    }
    // A restrained set of variations: each spread gets its own slight angle, the
    // project spread comes a touch closer and the closing spread eases back.
    const last = spread === spreads;
    const featured = spread === spreads - 1;
    const ry = last ? 0.045 : spread % 2 === 0 ? -0.03 : 0.03;
    const rx = featured ? -0.12 : -0.1;
    const zoom = featured ? 1.035 : last ? 0.97 : 1;
    poses.push(reading(rx, ry, zoom));
  }
  return { mode, ppu, pageScale: scaleFor(ppu), poses };
}

/** Centre of the book's bounding volume in book-local space, closed vs open. */
export function pivotFor(coverOpen: number, heights: StackHeights): { x: number; z: number } {
  const closedX = (BOOK.pageW + BOOK.overhang) / 2;
  const closedZ = BOOK.block / 2;
  const openZ = Math.max(heights.left, heights.right) / 2;
  return { x: closedX * (1 - coverOpen), z: closedZ + (openZ - closedZ) * coverOpen };
}

export function blendPose(a: Pose, b: Pose, t: number, out: Pose): Pose {
  const mix = (from: number, to: number): number => from + (to - from) * t;
  out.px = mix(a.px, b.px); out.py = mix(a.py, b.py); out.pz = mix(a.pz, b.pz);
  out.rx = mix(a.rx, b.rx); out.ry = mix(a.ry, b.ry); out.rz = mix(a.rz, b.rz);
  out.tx = mix(a.tx, b.tx); out.ty = mix(a.ty, b.ty); out.d = mix(a.d, b.d);
  return out;
}

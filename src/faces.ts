import * as THREE from 'three';
import { BOOK } from './book-geometry.ts';
import type { BookScene } from './scene.ts';

// Places the HTML page faces onto the 3D book. Each face gets one CSS matrix3d
// that maps its own pixels straight to screen pixels through the same camera
// WebGL uses, so text stays aligned with the geometry while staying real,
// selectable, focusable HTML. Faces are not in a CSS 3D context; their stacking
// is decided here (z-index), which keeps ordering deterministic across browsers.
//
// While a paper leaf turns, its two faces are shown as strips (clones of the
// page, each clipped to one segment of the curl) so the page can bend.

const W = BOOK.pageW;
const H = BOOK.pageH;
const O = BOOK.overhang;
const GAP = BOOK.faceGap;
const SEGMENTS = BOOK.segments;

interface Strip {
  el: HTMLElement;
  matrix: THREE.Matrix4;
  shown: boolean;
}

interface StripSet {
  root: HTMLElement;
  front: Strip[];
  back: Strip[];
  shown: boolean;
}

const flipLeft = new THREE.Matrix4().makeRotationY(-Math.PI);
const tmpFrame = new THREE.Matrix4();
const tmpSegment = new THREE.Matrix4();
const tmpRotation = new THREE.Matrix4();
const tmpPoint = new THREE.Vector4();

export class FaceProjector {
  private readonly layer: HTMLElement;
  private readonly faces: HTMLElement[];
  private readonly matrices: THREE.Matrix4[];
  private readonly shown: boolean[];
  private readonly lifted: boolean[];
  private readonly strips = new Map<number, StripSet>();
  private readonly screen = new THREE.Matrix4();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly local = {
    cover: new THREE.Matrix4(),
    endpaper: new THREE.Matrix4(),
    front: new THREE.Matrix4(),
    back: new THREE.Matrix4(),
    stripFront: new THREE.Matrix4(),
    stripBack: new THREE.Matrix4()
  };
  private ppu = 1;
  /** Faces the reader can currently see (used for focus handling). */
  readonly visible = new Set<number>();

  constructor(layer: HTMLElement, faces: HTMLElement[]) {
    this.layer = layer;
    this.faces = faces;
    this.matrices = faces.map(() => new THREE.Matrix4());
    this.shown = faces.map(() => false);
    this.lifted = faces.map(() => false);
  }

  /** Sizes the faces for the reading distance so text renders at ~1:1 while reading. */
  setScale(ppu: number, pageScale: number, width: number, height: number): void {
    this.ppu = ppu;
    const style = this.layer.style;
    style.setProperty('--page-w', `${W * ppu}px`);
    style.setProperty('--page-h', `${H * ppu}px`);
    style.setProperty('--board-w', `${(W + O) * ppu}px`);
    style.setProperty('--board-h', `${(H + 2 * O) * ppu}px`);
    style.setProperty('--strip-w', `${(W * ppu) / SEGMENTS}px`);
    style.setProperty('--page-font', `${16 * pageScale}px`);
    this.screen.set(
      width / 2, 0, 0, width / 2,
      0, -height / 2, 0, height / 2,
      0, 0, 1, 0,
      0, 0, 0, 1
    );
    // Pixel → face-local maps. Fronts read left to right from the spine; backs are
    // mirrored so they read correctly once the leaf has turned over.
    const s = 1 / ppu;
    const seg = W / SEGMENTS;
    const front = (m: THREE.Matrix4, x0: number, top: number, z: number): THREE.Matrix4 =>
      m.set(s, 0, 0, x0, 0, -s, 0, top, 0, 0, 1, z, 0, 0, 0, 1);
    const back = (m: THREE.Matrix4, x1: number, top: number, z: number): THREE.Matrix4 =>
      m.set(-s, 0, 0, x1, 0, -s, 0, top, 0, 0, -1, z, 0, 0, 0, 1);
    front(this.local.cover, 0, H / 2 + O, BOOK.board + GAP);
    back(this.local.endpaper, W, H / 2, -GAP);
    front(this.local.front, 0, H / 2, GAP);
    back(this.local.back, W, H / 2, -GAP);
    front(this.local.stripFront, 0, H / 2, GAP);
    back(this.local.stripBack, seg, H / 2, -GAP);
  }

  update(book: BookScene, moving: boolean): void {
    const { left, right, turning } = book.faces;
    const leafCount = book.leafFrames.length;
    this.viewProjection.multiplyMatrices(book.camera.projectionMatrix, book.camera.matrixWorldInverse).premultiply(this.screen);
    this.layer.classList.toggle('is-moving', moving);
    this.visible.clear();

    for (let face = 0; face < this.faces.length; face += 1) {
      const leaf = face >> 1;
      let show = face === left || face === right;
      let lifted = false;
      if (leaf === turning) {
        // A turning cover is rigid: both faces move whole. Paper uses strips.
        show = leaf === 0;
        lifted = true;
      }
      if (show) {
        const matrix = this.faceMatrix(book, face, leafCount);
        show = this.isFrontFacing(matrix);
        if (show) this.write(this.faces[face], matrix);
      }
      if (show) this.visible.add(face);
      if (show !== this.shown[face]) {
        this.shown[face] = show;
        this.faces[face].classList.toggle('is-shown', show);
      }
      if (lifted !== this.lifted[face]) {
        this.lifted[face] = lifted;
        this.faces[face].classList.toggle('is-lifted', lifted);
      }
    }

    for (const [leaf, set] of this.strips) if (leaf !== turning && set.shown) this.hideStrips(set);
    if (turning > 0) this.updateStrips(book, turning);
  }

  /** Builds the curl strips for every paper leaf ahead of time (call when idle). */
  prewarm(leafCount: number): void {
    for (let leaf = 1; leaf < leafCount; leaf += 1) this.ensureStrips(leaf);
  }

  isVisible(face: number): boolean {
    return this.visible.has(face);
  }

  /** Clears transforms and strips when leaving book mode. */
  reset(): void {
    for (const face of this.faces) {
      face.style.transform = '';
      face.classList.remove('is-shown', 'is-lifted');
    }
    this.shown.fill(false);
    this.lifted.fill(false);
    for (const set of this.strips.values()) set.root.remove();
    this.strips.clear();
    this.layer.classList.remove('is-moving');
  }

  private faceMatrix(book: BookScene, face: number, leafCount: number): THREE.Matrix4 {
    const out = this.matrices[face];
    if (face === 2 * leafCount) {
      // Inside of the back board.
      return out.multiplyMatrices(this.viewProjection, book.book.matrixWorld).multiply(this.local.front);
    }
    const leaf = face >> 1;
    const isBack = (face & 1) === 1;
    const frame = book.leafFrames[leaf].matrixWorld;
    if (leaf === 0) {
      return out.multiplyMatrices(this.viewProjection, frame).multiply(isBack ? this.local.endpaper : this.local.cover);
    }
    // A resting paper leaf lies flat on one of the stacks.
    tmpFrame.copy(frame);
    if (isBack) tmpFrame.multiply(flipLeft);
    return out.multiplyMatrices(this.viewProjection, tmpFrame).multiply(isBack ? this.local.back : this.local.front);
  }

  private updateStrips(book: BookScene, leaf: number): void {
    const set = this.ensureStrips(leaf);
    if (!set.shown) {
      set.shown = true;
      set.root.hidden = false;
    }
    const shape = book.shapes[leaf];
    const frame = book.leafFrames[leaf].matrixWorld;
    for (let i = 0; i < SEGMENTS; i += 1) {
      tmpRotation.makeRotationY(-shape.angle[i]);
      tmpSegment.makeTranslation(shape.x[i], 0, shape.z[i]).multiply(tmpRotation);
      tmpFrame.multiplyMatrices(frame, tmpSegment);
      this.placeStrip(set.front[i], this.local.stripFront);
      this.placeStrip(set.back[i], this.local.stripBack);
    }
  }

  private placeStrip(strip: Strip, local: THREE.Matrix4): void {
    strip.matrix.multiplyMatrices(this.viewProjection, tmpFrame).multiply(local);
    const facing = this.isFrontFacing(strip.matrix);
    if (facing) this.write(strip.el, strip.matrix);
    if (facing !== strip.shown) {
      strip.shown = facing;
      strip.el.style.visibility = facing ? 'visible' : 'hidden';
    }
  }

  private hideStrips(set: StripSet): void {
    set.shown = false;
    set.root.hidden = true;
  }

  private ensureStrips(leaf: number): StripSet {
    const existing = this.strips.get(leaf);
    if (existing) return existing;
    const root = document.createElement('div');
    root.className = 'leaf-strips';
    root.setAttribute('aria-hidden', 'true');
    root.inert = true;
    const build = (face: HTMLElement, side: 'front' | 'back'): Strip[] => {
      const strips: Strip[] = [];
      for (let i = 0; i < SEGMENTS; i += 1) {
        const el = document.createElement('div');
        el.className = `strip strip--${side}`;
        el.style.setProperty('--i', String(i));
        const clone = face.cloneNode(true) as HTMLElement;
        clone.removeAttribute('id');
        clone.removeAttribute('aria-labelledby');
        clone.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
        clone.classList.add('strip-face');
        clone.classList.remove('is-shown', 'is-lifted');
        clone.removeAttribute('tabindex');
        clone.style.transform = '';
        el.appendChild(clone);
        root.appendChild(el);
        strips.push({ el, matrix: new THREE.Matrix4(), shown: true });
      }
      return strips;
    };
    const set: StripSet = { root, front: build(this.faces[2 * leaf], 'front'), back: build(this.faces[2 * leaf + 1], 'back'), shown: false };
    root.hidden = true;
    this.layer.appendChild(root);
    this.strips.set(leaf, set);
    return set;
  }

  /**
   * True if the element would be drawn unmirrored, i.e. its front faces the camera.
   * Orientation does not depend on the element's size, so no layout is read.
   */
  private isFrontFacing(matrix: THREE.Matrix4): boolean {
    tmpPoint.set(0, 0, 0, 1).applyMatrix4(matrix);
    const w0 = tmpPoint.w;
    const x0 = tmpPoint.x / w0;
    const y0 = tmpPoint.y / w0;
    tmpPoint.set(64, 0, 0, 1).applyMatrix4(matrix);
    const w1 = tmpPoint.w;
    const x1 = tmpPoint.x / w1;
    const y1 = tmpPoint.y / w1;
    tmpPoint.set(0, 64, 0, 1).applyMatrix4(matrix);
    const w2 = tmpPoint.w;
    const x2 = tmpPoint.x / w2;
    const y2 = tmpPoint.y / w2;
    if (w0 <= 0 || w1 <= 0 || w2 <= 0) return false;
    return (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0) > 0;
  }

  private write(el: HTMLElement, matrix: THREE.Matrix4): void {
    const e = matrix.elements;
    let css = 'matrix3d(';
    for (let i = 0; i < 16; i += 1) {
      const value = Math.abs(e[i]) < 1e-10 ? 0 : e[i];
      css += i === 15 ? `${value})` : `${value},`;
    }
    el.style.transform = css;
  }
}

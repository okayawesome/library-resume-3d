// Kineograph (flip-book) drawings. Each scene is a function of its frame number
// that returns one hand-drawn SVG frame. Strokes are re-jittered on every frame
// from a seeded random generator, so even still parts "boil" slightly as the
// frames flick past, like pencil drawings on successive flip-book pages.
// Pure string building: no DOM, deterministic, and testable in Node.

export const SCENE_FRAMES = 12;
export const MARGIN_FRAMES = 8;

type Point = [number, number];
type Rand = () => number;

const f1 = (n: number): string => n.toFixed(1);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Local 0..1 progress of t within [a, b]. */
const span = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));
const ease = (v: number): number => v * v * (3 - 2 * v);

function seeded(seed: number): Rand {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Catmull-Rom spline through the points, as cubic Bézier path data. */
function smooth(points: Point[], closed: boolean): string {
  const n = points.length;
  const at = (i: number): Point => (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  let d = `M${f1(points[0][0])} ${f1(points[0][1])}`;
  for (let i = 0; i < (closed ? n : n - 1); i += 1) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    d += `C${f1(p1[0] + (p2[0] - p0[0]) / 6)} ${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)} ${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])} ${f1(p2[1])}`;
  }
  return closed ? `${d}Z` : d;
}

/**
 * A pen that draws slightly unsteady ink strokes. Strokes of the same style are
 * merged into one SVG path, which keeps each frame to a handful of elements.
 */
class Sketch {
  private readonly parts: string[] = [];
  private readonly strokes = new Map<string, string>();
  private readonly rand: Rand;

  constructor(rand: Rand) {
    this.rand = rand;
  }

  private stroke(cls: string, d: string): void {
    this.strokes.set(cls, (this.strokes.get(cls) ?? '') + d);
  }

  private flush(): void {
    for (const [cls, d] of this.strokes) this.parts.push(`<path class="${cls}" d="${d}"/>`);
    this.strokes.clear();
  }

  jitter(amount: number): number {
    return (this.rand() - 0.5) * 2 * amount;
  }

  line(x1: number, y1: number, x2: number, y2: number, cls = 'k-ink'): void {
    const length = Math.hypot(x2 - x1, y2 - y1) || 1;
    const bow = this.jitter(Math.min(1.4, length * 0.02));
    const ax = x1 + this.jitter(0.5);
    const ay = y1 + this.jitter(0.5);
    const bx = x2 + this.jitter(0.5);
    const by = y2 + this.jitter(0.5);
    const mx = (ax + bx) / 2 - ((y2 - y1) / length) * bow;
    const my = (ay + by) / 2 + ((x2 - x1) / length) * bow;
    this.stroke(cls, `M${f1(ax)} ${f1(ay)}Q${f1(mx)} ${f1(my)} ${f1(bx)} ${f1(by)}`);
  }

  curve(points: Point[], cls = 'k-ink', closed = false, wobble = 0.5): void {
    if (points.length < 2) return;
    const shaken = points.map(([x, y]): Point => [x + this.jitter(wobble), y + this.jitter(wobble)]);
    this.stroke(cls, smooth(shaken, closed));
  }

  polyline(points: Point[], cls = 'k-ink', closed = false): void {
    const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${f1(x + this.jitter(0.4))} ${f1(y + this.jitter(0.4))}`).join('');
    this.stroke(cls, `${d}${closed ? 'Z' : ''}`);
  }

  /** Hand-drawn ellipse: the stroke overshoots its start, as a quick pen circle does. */
  ellipse(cx: number, cy: number, rx: number, ry: number, cls = 'k-ink', sweep = 1): void {
    const start = this.rand() * Math.PI * 2;
    const steps = Math.max(3, Math.round(14 * sweep));
    const total = (Math.PI * 2 + 0.3) * sweep;
    const points: Point[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const a = start + (total * i) / steps;
      const wobble = 1 + this.jitter(0.05);
      points.push([cx + Math.cos(a) * rx * wobble, cy + Math.sin(a) * ry * wobble]);
    }
    this.curve(points, cls, false, 0.2);
  }

  circle(cx: number, cy: number, r: number, cls = 'k-ink', sweep = 1): void {
    this.ellipse(cx, cy, r, r, cls, sweep);
  }

  rect(x: number, y: number, w: number, h: number, cls = 'k-ink'): void {
    // Corners slightly overshoot, like ruled pencil lines.
    const o = 1.2;
    this.line(x - o, y, x + w + o, y, cls);
    this.line(x + w, y - o, x + w, y + h + o, cls);
    this.line(x + w + o, y + h, x - o, y + h, cls);
    this.line(x, y + h + o, x, y - o, cls);
  }

  /** Diagonal shading inside a rectangle. */
  hatch(x: number, y: number, w: number, h: number, gap = 4, cls = 'k-hatch'): void {
    if (w <= 0 || h <= 0) return;
    for (let k = gap; k < w + h; k += gap) {
      const x1 = x + Math.max(0, k - h);
      const y1 = y + Math.min(h, k);
      const x2 = x + Math.min(w, k);
      const y2 = y + Math.max(0, k - w);
      this.line(x1, y1, x2, y2, cls);
    }
  }

  dot(x: number, y: number, r: number, cls = 'k-fill'): void {
    this.parts.push(`<circle class="${cls}" cx="${f1(x + this.jitter(0.3))}" cy="${f1(y + this.jitter(0.3))}" r="${f1(r)}"/>`);
  }

  text(x: number, y: number, value: string, cls = 'k-text', anchor: 'start' | 'middle' | 'end' = 'start'): void {
    const tilt = this.jitter(1.6);
    this.parts.push(`<text class="${cls}" x="${f1(x)}" y="${f1(y)}" text-anchor="${anchor}" transform="rotate(${f1(tilt)} ${f1(x)} ${f1(y)})">${value}</text>`);
  }

  group(transform: string, draw: () => void): void {
    this.flush();
    this.parts.push(`<g transform="${transform}">`);
    draw();
    this.flush();
    this.parts.push('</g>');
  }

  /** Stick figure standing on (x, y); `phase` 0..1 drives the walk cycle. */
  figure(x: number, y: number, size: number, phase: number, cls = 'k-ink'): void {
    const swing = Math.sin(phase * Math.PI * 2) * 0.7;
    const hip: Point = [x, y - 9 * size];
    const neck: Point = [x, y - 17 * size];
    this.circle(x, y - 21 * size, 3.4 * size, cls);
    this.line(neck[0], neck[1], hip[0], hip[1], cls);
    for (const side of [1, -1]) {
      const leg = swing * side;
      this.line(hip[0], hip[1], hip[0] + Math.sin(leg) * 8 * size, hip[1] + Math.cos(leg) * 9 * size, cls);
      const arm = -leg * 0.8;
      this.line(neck[0], neck[1] + 1.5 * size, neck[0] + Math.sin(arm) * 7 * size, neck[1] + 1.5 * size + Math.cos(arm) * 7 * size, cls);
    }
  }

  svg(width: number, height: number): string {
    this.flush();
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">${this.parts.join('')}</svg>`;
  }
}

interface Scene {
  height: number;
  draw: (s: Sketch, t: number, frame: number) => void;
}

const W = 320;

/** "Find the bottleneck": a chart draws itself under a magnifier; the spike gets circled. */
const bottleneck: Scene = {
  height: 88,
  draw(s, t) {
    s.line(16, 82, 306, 82);
    s.line(16, 82, 16, 12);
    for (let i = 1; i < 6; i += 1) s.line(16 + i * 48, 82, 16 + i * 48, 85, 'k-soft');
    const series: Point[] = [];
    for (let i = 0; i < 26; i += 1) {
      const spike = Math.exp(-((i - 18) ** 2) / 2.2);
      series.push([24 + i * 11, 64 + 5 * Math.sin(i * 0.9) + 3 * Math.sin(i * 2.3) - 40 * spike]);
    }
    const shown = 2 + Math.round(ease(span(t, 0, 0.72)) * 24);
    s.curve(series.slice(0, shown), 'k-ink', false, 0.3);
    const [hx, hy] = series[shown - 1];
    if (t < 0.8) {
      // The magnifier follows the pen.
      s.circle(hx + 7, hy - 13, 9);
      s.line(hx + 13, hy - 6, hx + 20, hy + 2);
    }
    const ring = span(t, 0.72, 0.92);
    if (ring > 0) s.ellipse(series[18][0], series[18][1] + 8, 15, 24, 'k-accent', ring);
    if (t > 0.86) {
      s.text(series[18][0] + 22, 22, 'bottleneck!', 'k-text k-text--accent');
      s.line(series[18][0] + 20, 24, series[18][0] + 12, 30, 'k-accent');
    }
    s.text(22, 18, 'response time', 'k-text k-text--soft');
  }
};

function gear(s: Sketch, cx: number, cy: number, r: number, teeth: number, angle: number): void {
  const points: Point[] = [];
  for (let k = 0; k < teeth; k += 1) {
    const a = angle + (k / teeth) * Math.PI * 2;
    const step = (Math.PI * 2) / teeth;
    for (const [offset, radius] of [[0, r - 4], [0.22, r + 3], [0.5, r + 3], [0.72, r - 4]] as const) {
      points.push([cx + Math.cos(a + offset * step) * radius, cy + Math.sin(a + offset * step) * radius]);
    }
  }
  s.polyline(points, 'k-ink', true);
  s.circle(cx, cy, r * 0.32);
}

/** "Skills in motion": meshing gears, while tools drop into a toolbox. */
const gears: Scene = {
  height: 88,
  draw(s, t) {
    const turn = t * Math.PI * 1.4;
    gear(s, 58, 48, 26, 10, turn);
    gear(s, 101, 70, 15, 6, -turn * (10 / 6) + 0.25);
    // Toolbox, with tools dropping onto it in two rows.
    s.rect(178, 60, 118, 26);
    s.hatch(178, 74, 118, 12, 6);
    s.rect(226, 65, 22, 5, 'k-soft');
    const chips: [string, number, number][] = [['LoadRunner', 184, 46], ['Azure', 252, 46], ['Python', 196, 32], ['AI', 248, 32]];
    chips.forEach(([label, x, rest], i) => {
      const drop = ease(span(t, 0.12 + i * 0.17, 0.3 + i * 0.17));
      if (drop <= 0) return;
      const y = rest - (1 - drop) * 44;
      const cls = i === 3 ? 'k-accent' : 'k-ink';
      s.rect(x, y, label.length * 5.2 + 8, 12, cls);
      s.text(x + 4, y + 9, label, i === 3 ? 'k-text k-text--accent' : 'k-text');
    });
  }
};

/** "A load test, frame by frame": virtual users stream into a server; the response line draws. */
const loadtest: Scene = {
  height: 88,
  draw(s, t, frame) {
    s.line(6, 85, 138, 85, 'k-soft');
    for (let k = 0; k < 4; k += 1) {
      const travel = (t * 1.5 + k * 0.25) % 1;
      s.figure(14 + travel * 118, 84, 1, (frame * 0.25 + k * 0.3) % 1);
    }
    s.rect(146, 18, 40, 66);
    for (let r = 0; r < 4; r += 1) {
      s.line(150, 32 + r * 14, 182, 32 + r * 14, 'k-soft');
      if ((frame + r) % 2 === 0) s.dot(177, 26 + r * 14, 1.8, 'k-fill-accent');
    }
    s.line(192, 50, 204, 50, 'k-soft');
    s.line(200, 46, 204, 50, 'k-soft');
    s.line(200, 54, 204, 50, 'k-soft');
    s.line(212, 84, 310, 84);
    s.line(212, 84, 212, 18);
    for (let x = 214; x < 308; x += 9) s.line(x, 40, x + 5, 40, 'k-accent');
    s.text(286, 36, 'SLA', 'k-text k-text--accent');
    const points: Point[] = [];
    const shown = Math.max(2, Math.round(ease(span(t, 0.1, 0.85)) * 14));
    for (let i = 0; i < shown; i += 1) points.push([216 + i * 6.8, 70 - 18 * (1 - Math.exp(-i / 4)) + 3 * Math.sin(i * 1.7)]);
    s.curve(points, 'k-ink', false, 0.3);
    if (t > 0.88) {
      s.line(292, 62, 297, 68, 'k-accent');
      s.line(297, 68, 308, 52, 'k-accent');
    }
  }
};

/** "Watch the cost come down": quarterly bars shrink while savings stack up. */
const savings: Scene = {
  height: 88,
  draw(s, t, frame) {
    const progress = ease(span(t, 0, 0.8));
    const start = [58, 56, 58, 55];
    const end = [58, 44, 30, 19];
    const base = 76;
    s.line(12, base, 150, base);
    start.forEach((h0, i) => {
      const h = h0 + (end[i] - h0) * progress;
      const x = 20 + i * 32;
      s.rect(x, base - h, 22, h);
      s.hatch(x, base - h, 22, h, 5);
      s.text(x + 11, base + 9, `Q${i + 1}`, 'k-text k-text--soft', 'middle');
    });
    if (progress > 0.45) s.curve([[31, 12], [70, 24], [104, 38], [136, 52]], 'k-accent');
    if (progress > 0.6) {
      s.line(136, 52, 128, 50, 'k-accent');
      s.line(136, 52, 133, 44, 'k-accent');
    }
    // Coins stack, one landing every couple of frames.
    const coins = Math.round(ease(span(t, 0.1, 0.85)) * 6);
    for (let c = 0; c < coins; c += 1) {
      s.ellipse(196, base - c * 7, 17, 5);
      s.line(179, base - c * 7, 179, base + 4 - c * 7, 'k-soft');
      s.line(213, base - c * 7, 213, base + 4 - c * 7, 'k-soft');
    }
    if (coins < 6 && t > 0.1) s.ellipse(196, base - coins * 7 - 14 - (frame % 2) * 6, 17, 5, 'k-soft');
    if (t > 0.82) {
      s.group('rotate(-8 268 42)', () => {
        s.rect(232, 26, 74, 30, 'k-accent');
        s.text(269, 40, '−$100k', 'k-text k-text--accent k-text--big', 'middle');
        s.text(269, 51, 'PER QUARTER', 'k-text k-text--accent', 'middle');
      });
    }
  }
};

/** "Qualifying a card": the card goes in, the run completes, the checks tick. */
const qualify: Scene = {
  height: 88,
  draw(s, t, frame) {
    const insert = ease(span(t, 0, 0.3));
    const cx = 18 + insert * 88;
    // Whatever has slid into the reader's slot is hidden behind it.
    const right = Math.min(cx + 36, 120);
    if (right === cx + 36) {
      s.polyline([[cx, 36], [cx + 30, 36], [cx + 36, 42], [cx + 36, 60], [cx, 60]], 'k-ink', true);
      for (let i = 0; i < 4; i += 1) s.line(cx + 4 + i * 6, 54, cx + 4 + i * 6, 58, 'k-soft');
      s.text(cx + 4, 47, 'CFx', 'k-text');
    } else {
      s.polyline([[right, 36], [cx, 36], [cx, 60], [right, 60]]);
    }
    s.rect(120, 28, 56, 40);
    s.line(120, 34, 120, 62, 'k-accent');
    if (t > 0.3 && frame % 2 === 0) s.dot(168, 34, 2, 'k-fill-accent');
    const run = span(t, 0.3, 0.66);
    s.rect(116, 78, 64, 8);
    if (run > 0) s.hatch(116, 78, 64 * run, 8, 3, 'k-ink');
    const checks = ['Full CI', 'Sanity', 'DVT'];
    checks.forEach((label, i) => {
      const y = 26 + i * 22;
      s.rect(206, y - 8, 10, 10);
      s.text(224, y, label, 'k-text');
      if (t > 0.58 + i * 0.12) {
        s.line(207, y - 3, 211, y + 1, 'k-accent');
        s.line(211, y + 1, 219, y - 11, 'k-accent');
      }
    });
  }
};

/** "An interface, assembled": components drop into a browser window; a shield seals it. */
const interfaceScene: Scene = {
  height: 92,
  draw(s, t, frame) {
    s.rect(58, 8, 196, 82);
    s.line(58, 18, 254, 18);
    for (let i = 0; i < 3; i += 1) s.circle(65 + i * 7, 13, 1.8, 'k-soft');
    const drop = (from: number, to: number, y: number): number => {
      const p = span(t, from, to);
      if (p <= 0) return Number.NaN;
      // Falls in, then settles with a small bounce.
      return y - (1 - ease(p)) * 60 + Math.sin(p * Math.PI) * 3;
    };
    const header = drop(0, 0.22, 24);
    if (!Number.isNaN(header)) { s.rect(64, header, 184, 9); s.hatch(64, header, 60, 9, 4); }
    const side = drop(0.18, 0.4, 38);
    if (!Number.isNaN(side)) { s.rect(64, side, 32, 46); for (let i = 0; i < 4; i += 1) s.line(68, side + 8 + i * 9, 90, side + 8 + i * 9, 'k-soft'); }
    [[104, 0.36, 0.56], [178, 0.48, 0.68]].forEach(([x, a, b]) => {
      const y = drop(a, b, 38);
      if (Number.isNaN(y)) return;
      s.rect(x, y, 68, 26);
      s.line(x + 6, y + 8, x + 50, y + 8, 'k-soft');
      s.line(x + 6, y + 15, x + 40, y + 15, 'k-soft');
    });
    if (t > 0.6) { s.rect(104, 70, 142, 14); s.text(110, 80, 'Sign in securely', 'k-text k-text--soft'); }
    // Cursor drifting between components.
    const cx = 120 + Math.sin(frame * 0.9) * 50;
    const cy = 60 + Math.cos(frame * 0.7) * 12;
    s.polyline([[cx, cy], [cx, cy + 11], [cx + 3, cy + 8], [cx + 8, cy + 9]], 'k-ink', true);
    if (t > 0.78) {
      s.curve([[276, 30], [290, 26], [304, 30], [303, 50], [290, 64], [277, 50], [276, 30]], 'k-accent', false, 0.3);
      s.line(283, 44, 289, 50, 'k-accent');
      s.line(289, 50, 298, 38, 'k-accent');
    }
  }
};

function house(s: Sketch, x: number, y: number, label: string): void {
  s.rect(x - 14, y - 20, 28, 20);
  s.line(x - 18, y - 19, x, y - 33);
  s.line(x, y - 33, x + 18, y - 19);
  s.rect(x - 4, y - 10, 8, 10);
  s.text(x, y + 10, label, 'k-text k-text--soft', 'middle');
}

/** "A book on loan, branch to branch": a book travels the network; loan slots fill (max three). */
const network: Scene = {
  height: 96,
  draw(s, t, frame) {
    house(s, 38, 76, 'BRANCH A');
    house(s, 160, 64, 'BRANCH B');
    house(s, 282, 76, 'BRANCH C');
    // Two arcs over the rooftops: A → B → C.
    const path = (u: number): Point => {
      const second = u >= 0.5;
      const v = second ? (u - 0.5) / 0.5 : u / 0.5;
      const [y0, y1] = second ? [26, 38] : [38, 26];
      return [(second ? 160 : 38) + v * 122, y0 + (y1 - y0) * v - Math.sin(v * Math.PI) * 16];
    };
    for (let u = 0.02; u < 1; u += 0.05) {
      const [x1, y1] = path(u);
      const [x2, y2] = path(u + 0.022);
      s.line(x1, y1, x2, y2, 'k-soft');
    }
    const [bx, by] = path(ease(span(t, 0.05, 0.85)));
    const bob = frame % 2 ? -1.5 : 1.5;
    s.rect(bx - 7, by - 6 + bob, 14, 10);
    s.line(bx - 3, by - 6 + bob, bx - 3, by + 4 + bob, 'k-accent');
    s.text(76, 92, 'LOANS', 'k-text k-text--soft');
    const loans = 1 + Math.round(ease(span(t, 0.2, 0.9)) * 2);
    for (let i = 0; i < 3; i += 1) {
      if (i < loans) s.dot(114 + i * 11, 89, 3.2, 'k-fill-accent');
      else s.circle(114 + i * 11, 89, 3.2, 'k-soft');
    }
  }
};

/** "A network learning to fire": activation flows layer by layer; the loss curve drops. */
const neural: Scene = {
  height: 132,
  draw(s, t, frame) {
    const layers = [3, 4, 4, 2];
    const xs = [34, 104, 174, 236];
    const nodes = layers.map((count, l) => Array.from({ length: count }, (_, i): Point => [xs[l], 66 + (i - (count - 1) / 2) * 26]));
    const wave = t * (layers.length + 0.6);
    for (let l = 0; l < layers.length - 1; l += 1) {
      for (const [ax, ay] of nodes[l]) {
        for (const [bx, by] of nodes[l + 1]) {
          s.line(ax + 7, ay, bx - 7, by, 'k-soft');
          const travel = wave - l - 0.3;
          if (travel > 0 && travel < 1) s.dot(ax + 7 + (bx - ax - 14) * travel, ay + (by - ay) * travel, 1.8, 'k-fill-accent');
        }
      }
    }
    nodes.forEach((layer, l) => layer.forEach(([x, y]) => {
      s.circle(x, y, 7);
      if (wave > l + 0.3) s.dot(x, y, 3.6, l === layers.length - 1 ? 'k-fill-accent' : 'k-fill');
    }));
    // Loss curve, falling as it learns.
    s.line(262, 118, 312, 118);
    s.line(262, 118, 262, 78);
    const shown = Math.max(2, Math.round(ease(span(t, 0.2, 0.95)) * 12));
    const loss: Point[] = [];
    for (let i = 0; i < shown; i += 1) loss.push([264 + i * 4.2, 84 + 28 * (1 - Math.exp(-i / 3))]);
    s.curve(loss, 'k-accent', false, 0.3);
    s.text(266, 74, 'loss', 'k-text k-text--soft');
    s.text(14, 126, `learning${'.'.repeat(frame % 4)}`, 'k-text k-text--soft');
  }
};

/** "Level one, in pencil": a little character hops a crate for the coin, clears the spikes, reaches the flag. */
const platformer: Scene = {
  height: 132,
  draw(s, t, frame) {
    const ground = 112;
    s.line(4, ground, 214, ground);
    s.line(250, ground, 316, ground);
    s.hatch(4, ground + 2, 210, 14, 7);
    s.hatch(250, ground + 2, 66, 14, 7);
    // Crate, spike pit and a floating brick row overhead.
    s.rect(120, ground - 22, 22, 22);
    s.line(120, ground - 22, 142, ground);
    s.line(142, ground - 22, 120, ground);
    for (let x = 216; x < 248; x += 8) s.polyline([[x, ground + 14], [x + 4, ground + 4], [x + 8, ground + 14]], 'k-soft');
    s.rect(176, 30, 60, 10);
    s.text(206, 38, '?', 'k-text', 'middle');
    const x = 18 + ease(span(t, 0, 0.92)) * 262;
    const hop = (centre: number, width: number, height: number): number => {
      const v = (x - (centre - width / 2)) / width;
      return v > 0 && v < 1 ? Math.sin(v * Math.PI) * height : 0;
    };
    const lift = Math.max(hop(131, 72, 46), hop(232, 58, 28));
    const y = ground - lift;
    const collected = x > 127;
    if (!collected) s.circle(131, ground - 62, 6, 'k-accent');
    // Character: a pencil box with eyes and running legs.
    s.rect(x - 7, y - 22, 14, 14);
    s.dot(x - 2, y - 17, 1.3);
    s.dot(x + 3, y - 17, 1.3);
    const stride = frame % 2 === 0 ? 4 : -4;
    if (lift > 0) {
      s.line(x - 3, y - 8, x - 6, y - 2);
      s.line(x + 3, y - 8, x + 6, y - 3);
    } else {
      s.line(x - 3, y - 8, x - 3 + stride, y);
      s.line(x + 3, y - 8, x + 3 - stride, y);
    }
    if (t > 0.05 && t < 0.92) for (let i = 0; i < 3; i += 1) s.line(x - 14 - i * 5, y - 18 + i * 4, x - 10 - i * 5, y - 18 + i * 4, 'k-soft');
    if (collected && x < 170) s.text(131, ground - 66 - (x - 127) * 0.4, '+1', 'k-text k-text--accent', 'middle');
    // Goal flag.
    s.line(300, ground, 300, ground - 40);
    const wave = frame % 2 ? 2 : -2;
    s.polyline([[300, ground - 40], [316, ground - 35 + wave], [300, ground - 30]], t > 0.9 ? 'k-accent' : 'k-ink');
    s.text(8, 14, `SCORE ${collected ? 1 : 0}`, 'k-text');
    if (t > 0.92) s.text(250, 70, 'level complete', 'k-text k-text--accent', 'middle');
  }
};

function stamp(s: Sketch, x: number, y: number, label: string, small: string, tilt: number, impact: number): void {
  const scale = 1 + (1 - impact) * 0.6;
  s.group(`translate(${f1(x)} ${f1(y)}) rotate(${tilt}) scale(${f1(scale)})`, () => {
    s.circle(0, 0, 28, 'k-accent');
    s.circle(0, 0, 23, 'k-accent');
    s.text(0, 2, label, 'k-text k-text--accent', 'middle');
    s.text(0, 12, small, 'k-text k-text--accent', 'middle');
  });
  if (impact > 0.5 && impact < 1) {
    for (let a = 0; a < 6; a += 1) {
      const angle = (a / 6) * Math.PI * 2;
      s.line(x + Math.cos(angle) * 33, y + Math.sin(angle) * 33, x + Math.cos(angle) * 39, y + Math.sin(angle) * 39, 'k-soft');
    }
  }
}

/** "Certified, stamp by stamp": a mortarboard, then three stamps thump down. */
const stamps: Scene = {
  height: 74,
  draw(s, t, frame) {
    s.polyline([[40, 22], [70, 34], [40, 46], [10, 34]], 'k-ink', true);
    s.polyline([[22, 40], [22, 54], [58, 54], [58, 40]]);
    const sway = frame % 2 ? 2 : -2;
    s.line(70, 34, 72 + sway, 52, 'k-accent');
    s.text(40, 69, 'DTU · 2018', 'k-text', 'middle');
    const items: [string, string, number][] = [['AZ-900', '2024', -8], ['SAFe 5', '2023', 6], ['ISTQB', 'FL', -4]];
    items.forEach(([label, small, tilt], i) => {
      const appear = span(t, 0.15 + i * 0.22, 0.27 + i * 0.22);
      if (appear > 0) stamp(s, 130 + i * 74, 39, label, small, tilt, appear);
    });
  }
};

/** "Thank you for reading": a paper plane loops across the page, trailing its path. */
const plane: Scene = {
  height: 80,
  draw(s, t) {
    const path = (u: number): Point => [16 + u * 286, 58 - Math.sin(u * Math.PI) * 30 + Math.sin(u * Math.PI * 3) * 8];
    const head = ease(span(t, 0, 0.85));
    for (let u = 0; u < head - 0.03; u += 0.035) {
      const [x1, y1] = path(u);
      const [x2, y2] = path(Math.min(u + 0.018, head));
      s.line(x1, y1, x2, y2, 'k-soft');
    }
    const [px, py] = path(head);
    const [qx, qy] = path(Math.max(0, head - 0.01));
    const angle = (Math.atan2(py - qy, px - qx) * 180) / Math.PI;
    s.group(`translate(${f1(px)} ${f1(py)}) rotate(${f1(head > 0 ? angle : -10)})`, () => {
      s.polyline([[-14, -7], [8, 0], [-14, 7], [-8, 0]], 'k-ink', true);
      s.line(-8, 0, 8, 0, 'k-soft');
    });
    if (t > 0.8) s.text(160, 78, 'thanks for reading ✳', 'k-text k-text--accent', 'middle');
  }
};

export const SCENES: Record<string, Scene> = {
  bottleneck, gears, loadtest, savings, qualify, interface: interfaceScene, network, neural, platformer, stamps, plane
};

export function sceneRatio(name: string): number {
  return W / (SCENES[name]?.height ?? 96);
}

const seedFor = (name: string): number => {
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
};

/** One frame of a scene, with its flip-book page number in the corner. */
export function renderFrame(name: string, frame: number, frames = SCENE_FRAMES): string {
  const scene = SCENES[name];
  if (!scene) throw new Error(`Unknown kineograph scene: ${name}`);
  const s = new Sketch(seeded(seedFor(name) + frame * 7919));
  scene.draw(s, frames > 1 ? frame / (frames - 1) : 1, frame);
  s.text(W - 6, 10, `${String(frame + 1).padStart(2, '0')}/${frames}`, 'k-count', 'end');
  return s.svg(W, scene.height);
}

/** Margin doodle: a little runner in the page corner, one stride per frame. */
export function renderMarginFrame(frame: number, frames = MARGIN_FRAMES): string {
  const s = new Sketch(seeded(4242 + frame * 31));
  const phase = frame / frames;
  const bounce = Math.abs(Math.sin(phase * Math.PI * 2)) * 1.5;
  s.figure(20, 26 - bounce, 0.95, phase);
  s.line(4, 27, 36, 27, 'k-soft');
  return s.svg(40, 30);
}

import { smoothstep, unitsForSpread, type BookState, type Timeline } from './timeline.ts';

// DOM transition controller: reader bar, chapter rail, intro fade and every way
// of navigating (buttons, keys, in-book links, focus). It only ever asks for a
// scroll position; the book follows from the scroll like any other scroll.

type Side = 'left' | 'right' | 'centre';

export interface Spread {
  label: string;
  pages: string;
  left: number;
  right: number;
}

interface Elements {
  faces: HTMLElement[];
  intro: HTMLElement;
  rail: HTMLOListElement;
  railFill: HTMLElement;
  chapterName: HTMLElement;
  pageCount: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
}

export interface ReaderHooks {
  /** Scroll so that `units` is shown. */
  scrollToUnits: (units: number, smooth: boolean) => void;
  /** Current scroll position in timeline units. */
  currentUnits: () => number;
  isFaceVisible: (face: number) => boolean;
  reducedMotion: () => boolean;
}

const KEY_TARGETS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Spread a face belongs to, and on which side. Face 0 is the cover; odd faces are left pages. */
export function spreadOfFace(face: number): { spread: number; side: Side } {
  if (face === 0) return { spread: 0, side: 'centre' };
  return face % 2 === 1 ? { spread: (face + 1) / 2, side: 'left' } : { spread: face / 2, side: 'right' };
}

export function describeSpreads(faces: HTMLElement[], spreadCount: number): Spread[] {
  const spreads: Spread[] = [{ label: 'Cover', pages: 'Closed', left: -1, right: 0 }];
  for (let spread = 1; spread <= spreadCount; spread += 1) {
    const left = 2 * spread - 1;
    const right = 2 * spread;
    const names: string[] = [];
    const folios: string[] = [];
    for (const face of [faces[left], faces[right]]) {
      if (!face) continue;
      const chapter = face.dataset.chapter ?? '';
      if (chapter && chapter !== 'Contents' && !names.includes(chapter)) names.push(chapter);
      if (face.dataset.folio) folios.push(face.dataset.folio);
    }
    const pages = folios.length > 1 ? `pp. ${folios[0]}–${folios[folios.length - 1]}` : folios.length ? `p. ${folios[0]}` : '';
    spreads.push({ label: names.join(' · '), pages, left, right });
  }
  return spreads;
}

export class ReaderUI {
  private readonly el: Elements;
  private readonly hooks: ReaderHooks;
  private readonly spreads: Spread[];
  private readonly railButtons: HTMLButtonElement[] = [];
  private timeline: Timeline | null = null;
  private status = '';
  private active = -1;
  private introOpacity = -1;
  private pending: { units: number; at: number } | null = null;
  private flowObserver: IntersectionObserver | null = null;
  /** Page in view in the flow layout, so switching to the book keeps the reader's place. */
  flowFace = 0;

  constructor(el: Elements, spreads: Spread[], hooks: ReaderHooks) {
    this.el = el;
    this.spreads = spreads;
    this.hooks = hooks;
    el.faces.forEach((face) => face.setAttribute('tabindex', '-1'));
    this.buildRail();
    el.prev.addEventListener('click', () => this.step(-1));
    el.next.addEventListener('click', () => this.step(1));
    document.addEventListener('keydown', (event) => this.onKey(event));
    document.addEventListener('click', (event) => this.onLinkClick(event));
    el.faces.forEach((face, index) => face.addEventListener('focusin', () => this.onFaceFocus(index)));
  }

  /** Book mode: navigation is by scroll position on the timeline. */
  setTimeline(timeline: Timeline): void {
    this.timeline = timeline;
    this.flowObserver?.disconnect();
    this.flowObserver = null;
    this.spreads.forEach((_, spread) => {
      const item = this.railButtons[spread].parentElement as HTMLElement;
      item.style.setProperty('--at', `${(unitsForSpread(timeline, spread) / timeline.total) * 100}%`);
    });
    this.active = -1;
    this.status = '';
  }

  /** Flow mode (phones, no WebGL): pages are ordinary blocks; track the one in view. */
  setFlow(): void {
    this.timeline = null;
    this.el.intro.style.opacity = '';
    this.el.intro.style.transform = '';
    this.el.intro.classList.remove('is-faded');
    this.introOpacity = -1;
    this.active = -1;
    this.status = '';
    this.flowObserver?.disconnect();
    this.flowObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const index = this.el.faces.indexOf(entry.target as HTMLElement);
        this.flowFace = index;
        this.setActive(spreadOfFace(index).spread, index);
      }
    }, { rootMargin: '-45% 0px -50% 0px' });
    this.el.faces.forEach((face) => this.flowObserver?.observe(face));
  }

  /** Per-frame update in book mode. Writes to the DOM only when something changed. */
  update(state: BookState, units: number): void {
    const timeline = this.timeline;
    if (!timeline) return;
    const intro = 1 - smoothstep(0.04, 0.5, state.spread);
    if (Math.abs(intro - this.introOpacity) > 0.002) {
      this.introOpacity = intro;
      this.el.intro.style.opacity = intro.toFixed(3);
      this.el.intro.style.transform = `translate3d(${(-28 * (1 - intro)).toFixed(2)}px, 0, 0)`;
      this.el.intro.classList.toggle('is-faded', intro < 0.05);
    }
    this.el.railFill.style.transform = `scaleX(${(units / timeline.total).toFixed(4)})`;
    const face = timeline.mode === 'page' && state.activeSpread > 0
      ? (state.focus < 0 ? this.spreads[state.activeSpread].left : this.spreads[state.activeSpread].right)
      : -1;
    this.setActive(state.activeSpread, face);
  }

  /** Destination of a smooth navigation still in flight, so a resize can resume it. */
  pendingUnits(): number | null {
    return this.pending && performance.now() - this.pending.at < 1500 ? this.pending.units : null;
  }

  /** Navigate to a face (used by links, the skip link and focus). */
  goToFace(face: number, smooth = !this.hooks.reducedMotion()): void {
    if (!this.timeline) {
      this.el.faces[face]?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
      return;
    }
    const { spread, side } = spreadOfFace(face);
    this.navigate(unitsForSpread(this.timeline, spread, side), smooth);
  }

  private setActive(spread: number, face: number): void {
    const info = this.spreads[spread];
    let status = `${info.label}|${info.pages}`;
    if (face >= 0) {
      const el = this.el.faces[face];
      status = `${el.dataset.chapter === 'Contents' ? 'Contents' : el.dataset.chapter ?? ''}|${el.dataset.folio ? `p. ${el.dataset.folio}` : ''}`;
    }
    if (status !== this.status) {
      this.status = status;
      const [name, pages] = status.split('|');
      this.el.chapterName.textContent = name;
      this.el.pageCount.textContent = pages;
    }
    if (spread !== this.active) {
      this.active = spread;
      this.railButtons.forEach((button, index) => {
        if (index === spread) button.setAttribute('aria-current', 'step');
        else button.removeAttribute('aria-current');
      });
      this.el.prev.disabled = spread === 0 && face <= 0;
      this.el.next.disabled = spread === this.spreads.length - 1 && (face < 0 || face === this.spreads[spread].right);
    }
  }

  private buildRail(): void {
    this.spreads.forEach((spread, index) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rail-stop';
      button.setAttribute('aria-label', index === 0 ? 'Cover' : `${spread.label}, ${spread.pages}`);
      const label = document.createElement('span');
      label.className = 'rail-label';
      label.textContent = spread.label;
      button.appendChild(label);
      button.addEventListener('click', () => {
        if (this.timeline) this.navigate(unitsForSpread(this.timeline, index, 'left'), !this.hooks.reducedMotion());
        else this.goToFace(index === 0 ? 0 : spread.left);
      });
      item.appendChild(button);
      this.el.rail.appendChild(item);
      this.railButtons.push(button);
    });
  }

  /** Reading stops in order: each spread, or each page when one page is framed at a time. */
  private stops(): number[] {
    const timeline = this.timeline;
    if (!timeline) return [];
    const stops = [unitsForSpread(timeline, 0)];
    for (let spread = 1; spread <= timeline.spreads; spread += 1) {
      if (timeline.mode === 'page') stops.push(unitsForSpread(timeline, spread, 'left'), unitsForSpread(timeline, spread, 'right'));
      else stops.push(unitsForSpread(timeline, spread));
    }
    return stops;
  }

  private step(direction: 1 | -1): void {
    if (!this.timeline) {
      const current = this.el.faces.findIndex((face) => face.getBoundingClientRect().bottom > window.innerHeight * 0.5);
      const target = Math.min(Math.max((current < 0 ? this.el.faces.length - 1 : current) + direction, 0), this.el.faces.length - 1);
      this.goToFace(target);
      return;
    }
    // Repeated presses during a smooth scroll continue from where the last one is heading.
    const now = performance.now();
    const from = this.pending && now - this.pending.at < 1200 ? this.pending.units : this.hooks.currentUnits();
    const stops = this.stops();
    const target = direction > 0 ? stops.find((stop) => stop > from + 0.02) : [...stops].reverse().find((stop) => stop < from - 0.02);
    if (target !== undefined) this.navigate(target, !this.hooks.reducedMotion());
  }

  private navigate(units: number, smooth: boolean): void {
    this.pending = { units, at: performance.now() };
    this.hooks.scrollToUnits(units, smooth);
  }

  private onKey(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target && (KEY_TARGETS.has(target.tagName) || target.isContentEditable)) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.step(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.step(-1);
    }
  }

  private onLinkClick(event: MouseEvent): void {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const link = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[href^="#"]');
    if (!link) return;
    const id = decodeURIComponent(link.hash.slice(1));
    const face = this.el.faces.findIndex((item) => item.id === id);
    if (face < 0) return;
    event.preventDefault();
    history.replaceState(null, '', `#${id}`);
    this.goToFace(face);
    // Move keyboard and screen-reader focus with the reader.
    this.el.faces[face].focus({ preventScroll: true });
  }

  private onFaceFocus(face: number): void {
    // Tabbing onto a link on a page that is not open turns the book to that page.
    // Deferred a frame so the browser's own focus scrolling cannot cancel it.
    if (this.timeline && !this.hooks.isFaceVisible(face)) window.requestAnimationFrame(() => this.goToFace(face));
  }
}

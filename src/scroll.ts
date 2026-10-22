// Scroll controller: native document scroll is the single source of truth.
// The scroll track is just tall enough to give every chapter its scroll distance;
// nothing here intercepts wheel or touch input.

const SMOOTHING = 9; // per second; higher follows the scrollbar more tightly

export class ScrollController {
  /** Progress the scrollbar asks for, in timeline units. */
  target = 0;
  /** Smoothed progress the scene renders. */
  current = 0;
  private unitPx = 1;
  private total = 1;
  private readonly track: HTMLElement;

  constructor(track: HTMLElement) {
    this.track = track;
  }

  /** Sizes the scroll track; one unit of the timeline is one viewport height of scrolling. */
  layout(totalUnits: number, viewportHeight: number): void {
    this.total = totalUnits;
    this.unitPx = viewportHeight;
    this.track.style.height = `${Math.round(totalUnits * viewportHeight + viewportHeight)}px`;
  }

  /** Reads the scroll position. Call from the scroll event, not per frame. */
  read(): void {
    this.target = Math.min(Math.max(window.scrollY / this.unitPx, 0), this.total);
  }

  /** Advances smoothing; returns true while the rendered progress is still moving. */
  step(dt: number, immediate: boolean): boolean {
    const gap = this.target - this.current;
    if (immediate || Math.abs(gap) < 0.0004) {
      const moved = gap !== 0;
      this.current = this.target;
      return moved;
    }
    this.current += gap * (1 - Math.exp(-dt * SMOOTHING));
    return true;
  }

  jump(): void {
    this.current = this.target;
  }

  scrollToUnits(units: number, smooth: boolean): void {
    window.scrollTo({ top: Math.round(units * this.unitPx), behavior: smooth ? 'smooth' : 'auto' });
  }
}

import type { Quality } from './scene.ts';

// Performance controller: picks a starting quality from device hints, then
// watches frame times while the book is animating and steps down (never up, to
// avoid oscillating) when frames are slow on average or keep spiking. Only
// animating frames are sampled; an idle book renders nothing.

const TIERS: Quality[] = [
  { pixelRatio: 1, shadows: false, shadowSize: 512 },
  { pixelRatio: 1.5, shadows: true, shadowSize: 1024 },
  { pixelRatio: 2, shadows: true, shadowSize: 2048 }
];
const SLOW_AVERAGE_MS = 22;
const SLOW_STREAK = 45;
const SPIKE_MS = 34;
const SPIKE_WINDOW = 120;
const SPIKE_LIMIT = 6;

export class QualityController {
  tier: number;
  private average = 16;
  private slowFrames = 0;
  private readonly spikes: boolean[] = [];
  private spikeCount = 0;
  private readonly onChange: (quality: Quality) => void;

  constructor(onChange: (quality: Quality) => void) {
    this.onChange = onChange;
    const nav = navigator as Navigator & { deviceMemory?: number };
    const cores = nav.hardwareConcurrency ?? 4;
    const memory = nav.deviceMemory ?? 8;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    this.tier = cores <= 2 || memory <= 2 ? 0 : coarse || cores <= 4 || memory <= 4 ? 1 : 2;
    // `?quality=0|1|2` pins the starting tier, for testing on a given device.
    const forced = new URLSearchParams(window.location.search).get('quality');
    if (forced !== null && /^[0-2]$/.test(forced)) this.tier = Number(forced);
  }

  get quality(): Quality {
    const tier = TIERS[this.tier];
    return { ...tier, pixelRatio: Math.min(window.devicePixelRatio || 1, tier.pixelRatio) };
  }

  /** Feed the duration of an animating frame. */
  sample(frameMs: number): void {
    // Ignore huge gaps (tab switches, debugger pauses).
    if (frameMs > 250 || this.tier === 0) return;
    this.average += (frameMs - this.average) * 0.1;
    this.slowFrames = this.average > SLOW_AVERAGE_MS ? this.slowFrames + 1 : 0;
    const spike = frameMs > SPIKE_MS;
    this.spikes.push(spike);
    if (spike) this.spikeCount += 1;
    if (this.spikes.length > SPIKE_WINDOW && this.spikes.shift()) this.spikeCount -= 1;
    if (this.slowFrames >= SLOW_STREAK || this.spikeCount >= SPIKE_LIMIT) {
      this.tier -= 1;
      this.slowFrames = 0;
      this.average = 16;
      this.spikes.length = 0;
      this.spikeCount = 0;
      this.onChange(this.quality);
    }
  }
}

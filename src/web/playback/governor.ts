/**
 * Adaptive quality: sheds fidelity before playback breaks.
 *
 * The ladder has one rung, and that is deliberate. Interpolation order is the
 * knob the spike confirmed works — `setInterpolation(0)` renders the same
 * passage in 53% of the time — and it is timbre, which is what should go first.
 * Polyphony was to be the second rung, but the worklet API exposes no setter
 * and needs none: fluidsynth already steals voices at its default, which is the
 * behaviour that rung was asking for. So notes are never dropped to save CPU;
 * at worst an older note is cut short by the synth's own stealing.
 *
 * Falls fast and rises slowly. Falling fast protects the audio; rising fast
 * would just fall again, and quality that flickers is worse than quality that
 * is merely lower.
 */
export type GovernorOptions = {
  onChange?: (interpolationOrder: number) => void;
};

/** fluidsynth's interpolation orders, best first. */
const LADDER = [7, 4, 1, 0];
/** How late a pump frame must be to count against the budget. */
const LATE_THRESHOLD_SECONDS = 0.1;
/** Consecutive late frames before stepping down — long enough to ignore one stall. */
const LATE_FRAMES_TO_DEGRADE = 10;
/** Clean frames before stepping back up. Deliberately far larger. */
const CLEAN_FRAMES_TO_RECOVER = 200;

export class Governor {
  private rung = 0;
  private lateFrames = 0;
  private cleanFrames = 0;

  constructor(private readonly options: GovernorOptions = {}) {}

  get interpolation(): number {
    return LADDER[this.rung];
  }

  /** One pump frame's lateness, in seconds. */
  record(lateBySeconds: number): void {
    if (lateBySeconds > LATE_THRESHOLD_SECONDS) {
      this.cleanFrames = 0;
      this.lateFrames += 1;
      if (this.lateFrames >= LATE_FRAMES_TO_DEGRADE) {
        this.lateFrames = 0;
        this.step(1);
      }
      return;
    }
    this.lateFrames = 0;
    this.cleanFrames += 1;
    if (this.cleanFrames >= CLEAN_FRAMES_TO_RECOVER) {
      this.cleanFrames = 0;
      this.step(-1);
    }
  }

  private step(direction: 1 | -1): void {
    const next = Math.min(LADDER.length - 1, Math.max(0, this.rung + direction));
    if (next === this.rung) return;
    this.rung = next;
    this.options.onChange?.(this.interpolation);
  }
}

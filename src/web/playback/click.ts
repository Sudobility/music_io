/**
 * The metronome click, in plain Web Audio.
 *
 * Not routed through the synth, and not through the mixer. A click is a
 * monitoring aid rather than part of the music, so the master headroom trim and
 * the per-track balance have no business changing how loud it is — and it
 * should not consume one of the sixteen MIDI channels a score might need.
 *
 * Unlike notes, clicks are scheduled *ahead* at an exact time: an oscillator
 * started with `start(at)` sounds at that sample whatever the main thread is
 * doing. So the click stays steady even when the pump runs late, which makes it
 * a usable reference rather than a second thing to distrust.
 */
const ACCENT_HZ = 1500;
const BEAT_HZ = 1000;
const CLICK_SECONDS = 0.03;
/** Quiet enough to sit under the music, loud enough to hear over it. */
const CLICK_PEAK = 0.25;

export function scheduleClick(
  context: BaseAudioContext,
  destination: AudioNode,
  atSeconds: number,
  accent: boolean,
): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = accent ? ACCENT_HZ : BEAT_HZ;
  oscillator.connect(gain);
  gain.connect(destination);

  // A short decay rather than a hard stop: a square-edged gate on a sine is an
  // audible tick of its own.
  const end = atSeconds + CLICK_SECONDS;
  gain.gain.setValueAtTime(CLICK_PEAK, atSeconds);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);

  oscillator.start(atSeconds);
  oscillator.stop(end);
  oscillator.onended = () => {
    oscillator.disconnect();
    gain.disconnect();
  };
}

/**
 * How a voice answers velocity: with timbre, or — for the instruments that
 * physically have no dynamics — not at all.
 */
import type { InstrumentHandle } from './handle.js';

// ---- velocity response ------------------------------------------------------

/**
 * Crossfades two voices by velocity, so playing harder changes the *timbre* and
 * not merely the level.
 *
 * Every voice used to answer velocity with amplitude alone, which is not how
 * instruments behave: a trumpet leant on does not just get louder, it gets
 * brighter, and a piano struck hard gains harmonics a soft touch never
 * produces. A mix where the only difference between p and f is a gain change
 * reads as flat and mechanical however correct its levels are.
 *
 * Tone allocates `PolySynth` voices internally, so a per-note filter or
 * oscillator change is not reachable — setting either would alter every note
 * already sounding. Two parallel voices are, because the blend is carried by
 * *each note's own* velocity within each layer: the same trick a sampler plays
 * with velocity layers.
 *
 * The split is equal-power (`cos`/`sin`), so the pair keeps the amplitude the
 * velocity asked for instead of bulging by up to 3dB in the middle of the
 * range where both layers sound at once.
 */
export function withVelocityTimbre(dark: InstrumentHandle, bright: InstrumentHandle): InstrumentHandle {
  const split = (velocity: number): [number, number] => {
    const angle = Math.min(1, Math.max(0, velocity)) * (Math.PI / 2);
    return [velocity * Math.cos(angle), velocity * Math.sin(angle)];
  };
  return {
    triggerAttackRelease(midi, durationSeconds, time, velocity) {
      const [d, b] = split(velocity);
      dark.triggerAttackRelease(midi, durationSeconds, time, d);
      bright.triggerAttackRelease(midi, durationSeconds, time, b);
    },
    triggerAttack(midi, velocity) {
      const [d, b] = split(velocity);
      dark.triggerAttack?.(midi, d);
      bright.triggerAttack?.(midi, b);
    },
    triggerRelease(midi) {
      dark.triggerRelease?.(midi);
      bright.triggerRelease?.(midi);
    },
    connect(node) {
      dark.connect(node);
      bright.connect(node);
    },
    dispose() {
      dark.dispose();
      bright.dispose();
    },
  };
}

/**
 * Sounds every note at one fixed level, whatever velocity it carries.
 *
 * Not a simplification — it is the instrument. A drawbar organ's key is a
 * switch: how hard it is pressed changes nothing, which is exactly why organ
 * parts are played with articulation rather than dynamics. A harpsichord's
 * plectrum plucks with a force the player cannot vary either. Scaling these by
 * velocity gave both an expressive range they do not physically have.
 */
export function withFixedVelocity(handle: InstrumentHandle, level: number): InstrumentHandle {
  return {
    ...handle,
    triggerAttackRelease(midi, durationSeconds, time) {
      handle.triggerAttackRelease(midi, durationSeconds, time, level);
    },
    triggerAttack(midi) {
      handle.triggerAttack?.(midi, level);
    },
  };
}

/** The level a velocity-insensitive voice always sounds at. */
export const FIXED_VELOCITY = 0.85;

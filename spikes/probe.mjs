// Tone.setContext accepts any BaseAudioContext-shaped object. If
// react-native-audio-api's AudioContext satisfies Tone, a PolySynth built on
// it should construct and schedule without throwing.
const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(`OK    ${name}`);
  } catch (e) {
    results.push(`BREAK ${name} -> ${e.constructor.name}: ${String(e.message).slice(0, 160)}`);
  }
};

let Tone;
let AudioContext;

try {
  Tone = await import('tone');
  results.push('OK    import tone');
} catch (e) {
  results.push(`BREAK import tone -> ${e.constructor.name}: ${String(e.message).slice(0, 160)}`);
}

try {
  ({ AudioContext } = await import('react-native-audio-api'));
  results.push(`OK    import react-native-audio-api (AudioContext is ${typeof AudioContext})`);
} catch (e) {
  results.push(
    `BREAK import react-native-audio-api -> ${e.constructor.name}: ${String(e.message).slice(0, 160)}`,
  );
}

if (Tone && typeof AudioContext === 'function') {
  let ctx;
  check('new AudioContext()', () => {
    ctx = new AudioContext();
  });
  if (ctx) {
    check('Tone.setContext(rn ctx)', () => Tone.setContext(ctx));
    check('new Tone.PolySynth(Tone.Synth)', () => new Tone.PolySynth(Tone.Synth));
    check('new Tone.Gain().toDestination()', () => new Tone.Gain(0.5).toDestination());
    check('new Tone.Panner(0)', () => new Tone.Panner(0));
    check('new Tone.Filter(800, "lowpass")', () => new Tone.Filter(800, 'lowpass'));
    check('Transport.scheduleRepeat', () => Tone.getTransport().scheduleRepeat(() => {}, 0.03));
  }
}

console.log(results.join('\n'));

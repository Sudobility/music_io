/**
 * `@breezystack/lamejs` ships no type declarations. This covers exactly the surface the mp3
 * encoder uses — deliberately narrow, so anything else we start calling shows
 * up as a type error rather than silently becoming `any`.
 */
declare module "@breezystack/lamejs" {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
  }
}

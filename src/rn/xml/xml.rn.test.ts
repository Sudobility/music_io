import { describe, expect, it } from 'vitest';
import { XmlParseError } from '@sudobility/music_types';
import { RNXmlParser } from './xml.rn.js';

const MUSICXML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="2">
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration></note>
    </measure>
  </part>
</score-partwise>`;

describe('RNXmlParser', () => {
  it('reads a real MusicXML document, declaration and all', () => {
    const root = new RNXmlParser().parse(MUSICXML);
    expect(root.tagName).toBe('score-partwise');
    expect(root.getAttribute('version')).toBe('4.0');
  });

  it('keeps repeated elements as a list whether there are one or many', () => {
    // The bug this guards: fast-xml-parser collapses a single child to an
    // object and only makes an array once there are two, so a one-measure part
    // and a two-measure part would have different shapes.
    const root = new RNXmlParser().parse(MUSICXML);
    const measures = Array.from(root.getElementsByTagName('measure'));
    expect(measures).toHaveLength(2);
    expect(Array.from(measures[1].getElementsByTagName('note'))).toHaveLength(1);
    expect(measures[0].getAttribute('number')).toBe('1');
  });

  it('reads text content and finds descendants at any depth', () => {
    const root = new RNXmlParser().parse(MUSICXML);
    expect(Array.from(root.getElementsByTagName('step')).map((s) => s.textContent)).toEqual([
      'C',
      'D',
      'E',
    ]);
    expect(Array.from(root.getElementsByTagName('part-name'))[0].textContent).toBe('Piano');
  });

  it('throws XmlParseError on malformed input', () => {
    expect(() => new RNXmlParser().parse('<a><b></a>')).toThrow(XmlParseError);
  });
});

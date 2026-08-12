import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { XmlParseError } from '@sudobility/music_types';
import type { XmlElement, XmlParser } from '@sudobility/music_types';

const ATTR_PREFIX = '@_';
const TEXT_KEY = '#text';

type FxpNode = Record<string, unknown>;

/** An element whose content is only text parses to a bare string, not an object. */
function isElementNode(value: unknown): value is FxpNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Adapts fast-xml-parser's object tree to `XmlElement`.
 *
 * `fast-xml-parser` rather than `@xmldom/xmldom`, which would have been the
 * obvious choice: xmldom ships CommonJS only, and this family is ESM. The cost
 * is this adapter, which is small because `XmlElement` is only five members.
 */
class FxpElement implements XmlElement {
  /** `node` is an object for an element with children or attributes, and a bare scalar for a text-only one. */
  constructor(
    readonly tagName: string,
    private readonly node: unknown,
  ) {}

  get textContent(): string | null {
    if (!isElementNode(this.node)) {
      return this.node === undefined || this.node === null ? null : String(this.node);
    }
    // Own text, then descendants. DOM interleaves the two in document order;
    // `fast-xml-parser` collapses an element's text nodes into one `#text` key
    // and loses where they sat relative to child elements, so `<a>x<b>y</b>z</a>`
    // comes out "xzy" here against DOM's "xyz". MusicXML has no mixed content,
    // and recovering order would mean `preserveOrder: true` and a different node
    // shape throughout this file.
    const parts: string[] = [];
    const text = this.node[TEXT_KEY];
    if (text !== undefined && text !== null) parts.push(String(text));
    for (const child of Array.from(this.children)) {
      if (child.textContent !== null) parts.push(child.textContent);
    }
    return parts.length > 0 ? parts.join('') : null;
  }

  get children(): ArrayLike<XmlElement> {
    // A text-only element parses to a scalar. Iterating one would walk a
    // string's character indices and recurse forever.
    if (!isElementNode(this.node)) return [];

    const out: XmlElement[] = [];
    for (const [key, value] of Object.entries(this.node)) {
      if (key.startsWith(ATTR_PREFIX) || key === TEXT_KEY) continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        out.push(new FxpElement(key, child));
      }
    }
    return out;
  }

  getAttribute(name: string): string | null {
    if (!isElementNode(this.node)) return null;
    const value = this.node[`${ATTR_PREFIX}${name}`];
    return value === undefined || value === null ? null : String(value);
  }

  getElementsByTagName(name: string): ArrayLike<XmlElement> {
    const found: XmlElement[] = [];
    const walk = (element: XmlElement): void => {
      for (const child of Array.from(element.children)) {
        if (child.tagName === name) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

export class RNXmlParser implements XmlParser {
  parse(text: string): XmlElement {
    const valid = XMLValidator.validate(text);
    if (valid !== true) throw new XmlParseError(valid.err.msg);

    const parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: ATTR_PREFIX,
      textNodeName: TEXT_KEY,
      // Elements are always arrays, so a part with one <measure> has the same
      // shape as a part with two -- otherwise every consumer has to normalise,
      // which is exactly the bug class this interface exists to remove. Text
      // nodes are excluded: wrapping those turns a leaf's content into an array
      // and there is nothing to normalise about it.
      isArray: (name, _jpath, _isLeaf, isAttribute) => !isAttribute && name !== TEXT_KEY,
    }).parse(text) as FxpNode;

    const rootName = Object.keys(parsed).find(
      (key) => !key.startsWith(ATTR_PREFIX) && key !== TEXT_KEY && key !== '?xml',
    );
    if (!rootName) throw new XmlParseError('The XML document has no root element.');

    const value = parsed[rootName];
    return new FxpElement(rootName, Array.isArray(value) ? value[0] : value);
  }
}

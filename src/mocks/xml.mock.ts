import { XmlParseError } from '@sudobility/music_types';
import type { XmlElement, XmlParser } from '@sudobility/music_types';

/**
 * A deliberately small XML reader, so the mocks entry needs no DOM and no
 * parser dependency.
 *
 * It handles elements, attributes and text, and skips the XML declaration,
 * comments and DOCTYPE — enough to read real MusicXML in a test, which is what
 * music_lib's importer suite needs. It is deliberately not a general XML parser
 * (no namespaces, entities or CDATA) and is not exported from the package root
 * for that reason: anything real should use the web or React Native parser.
 */
type Node = { tagName: string; attributes: Record<string, string>; children: Node[]; text: string };

const TOKEN = /<\/?([A-Za-z_][\w.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
const ATTR = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(ATTR)) attributes[match[1]] = match[2];
  return attributes;
}

/** Strips the XML declaration, comments and DOCTYPE, none of which carry data. */
function stripPreamble(text: string): string {
  return text
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, '');
}

function parseNodes(rawText: string): Node {
  const text = stripPreamble(rawText);
  const stack: Node[] = [];
  let root: Node | null = null;

  for (const match of text.matchAll(TOKEN)) {
    const [raw, tagName, attributeSource, selfClosing, textRun] = match;

    if (textRun !== undefined) {
      const trimmed = textRun.trim();
      if (trimmed && stack.length > 0) stack[stack.length - 1].text += trimmed;
      continue;
    }

    if (raw.startsWith('</')) {
      const open = stack.pop();
      if (!open || open.tagName !== tagName) {
        throw new XmlParseError(`Unbalanced tag: </${tagName}>`);
      }
      if (stack.length === 0) root = open;
      continue;
    }

    const node: Node = { tagName, attributes: parseAttributes(attributeSource ?? ''), children: [], text: '' };
    if (stack.length > 0) stack[stack.length - 1].children.push(node);

    if (selfClosing === '/') {
      if (stack.length === 0) root = node;
    } else {
      stack.push(node);
    }
  }

  if (stack.length > 0) throw new XmlParseError(`Unclosed tag: <${stack[stack.length - 1].tagName}>`);
  if (!root) throw new XmlParseError('The XML document has no root element.');
  return root;
}

class MockElement implements XmlElement {
  constructor(private readonly node: Node) {}

  get tagName(): string {
    return this.node.tagName;
  }

  get textContent(): string | null {
    const childText = this.node.children
      .map((child) => new MockElement(child).textContent ?? '')
      .join('');
    const text = `${this.node.text}${childText}`;
    return text.length > 0 ? text : null;
  }

  get children(): ArrayLike<XmlElement> {
    return this.node.children.map((child) => new MockElement(child));
  }

  getAttribute(name: string): string | null {
    return this.node.attributes[name] ?? null;
  }

  getElementsByTagName(name: string): ArrayLike<XmlElement> {
    const found: XmlElement[] = [];
    const walk = (node: Node): void => {
      for (const child of node.children) {
        if (child.tagName === name) found.push(new MockElement(child));
        walk(child);
      }
    };
    walk(this.node);
    return found;
  }
}

export class MockXmlParser implements XmlParser {
  parse(text: string): XmlElement {
    return new MockElement(parseNodes(text));
  }
}

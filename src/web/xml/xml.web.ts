import { XmlParseError } from "@sudobility/music_types";
import type { XmlElement, XmlParser } from "@sudobility/music_types";

/**
 * `DOMParser` returns real DOM `Element`s, which satisfy `XmlElement`
 * structurally — so there is no adapter in here, only the error handling
 * `DOMParser` declines to do.
 *
 * (That structural fit is also the live proof of the interface's shape: the
 * return below is `document.documentElement` typed as `XmlElement`, so if a
 * real Element ever stopped satisfying it, this file would not compile.)
 */
export class WebXmlParser implements XmlParser {
  parse(text: string): XmlElement {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    // DOMParser signals failure by *returning* a <parsererror> document rather
    // than throwing, so without this a malformed file becomes a confusing
    // failure much further downstream.
    if (doc.getElementsByTagName("parsererror").length > 0) {
      throw new XmlParseError("The input is not well-formed XML.");
    }
    if (!doc.documentElement)
      throw new XmlParseError("The XML document has no root element.");
    return doc.documentElement;
  }
}

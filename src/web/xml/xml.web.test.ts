// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { XmlParseError } from "@sudobility/music_types";
import { WebXmlParser } from "./xml.web.js";

describe("WebXmlParser", () => {
  it("returns the root element", () => {
    const root = new WebXmlParser().parse(
      '<score-partwise version="4.0"><part id="P1">note</part></score-partwise>',
    );
    expect(root.tagName).toBe("score-partwise");
    expect(root.getAttribute("version")).toBe("4.0");
    expect(root.children.length).toBe(1);
    expect(Array.from(root.children)[0].tagName).toBe("part");
  });

  it("throws XmlParseError on malformed input rather than returning a parsererror document", () => {
    // DOMParser reports failure by *returning* a <parsererror> document rather
    // than throwing, so a naive wrapper hands back a bogus root and the caller
    // fails much later with something confusing.
    expect(() => new WebXmlParser().parse("<a><b></a>")).toThrow(XmlParseError);
  });

  it("finds descendants by tag name at any depth", () => {
    const root = new WebXmlParser().parse(
      "<s><p><n>C</n></p><p><n>D</n></p></s>",
    );
    expect(
      Array.from(root.getElementsByTagName("n")).map((n) => n.textContent),
    ).toEqual(["C", "D"]);
  });
});

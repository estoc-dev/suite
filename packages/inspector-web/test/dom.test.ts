// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { h } from "../src/dom.ts";

describe("an element made by h", () => {
  it("shows a string child as text, and not as markup", () => {
    const element = h("p", null, "<b>bold</b>");
    expect(element.children).toHaveLength(0);
    expect(element.textContent).toBe("<b>bold</b>");
  });

  it("leaves out a false or missing child, and gives the children of an array in turn", () => {
    const element = h("p", null, "a", false, ["b", undefined, ["c", h("i", null, "d")]], "e");
    expect(element.textContent).toBe("abcde");
    expect(element.childNodes).toHaveLength(5);
  });

  it("takes as an array more children than a call takes arguments", () => {
    const texts = Array.from({ length: 130_000 }, (_, index) => `${index} `);
    expect(() => Array.of(...texts)).toThrow(RangeError);
    const element = h("p", null, texts);
    expect(element.childNodes).toHaveLength(130_000);
    expect(element.firstChild?.textContent).toBe("0 ");
    expect(element.lastChild?.textContent).toBe("129999 ");
  });
});

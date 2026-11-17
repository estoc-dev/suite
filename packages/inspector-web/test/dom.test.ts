// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { h, markup } from "../src/dom.ts";

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

  it("has every child of a long array, in turn", () => {
    const texts = Array.from({ length: 130_000 }, (_, index) => `${index} `);
    const element = h("p", null, texts);
    expect(element.childNodes).toHaveLength(130_000);
    expect(element.firstChild?.textContent).toBe("0 ");
    expect(element.lastChild?.textContent).toBe("129999 ");
  });
});

describe("an element made by markup", () => {
  it("reads its HTML as markup", () => {
    const element = markup("div", { class: "rendered" }, "<p>a <b>bold</b> word</p>");
    expect(element.className).toBe("rendered");
    expect(element.querySelector("b")?.textContent).toBe("bold");
  });
});

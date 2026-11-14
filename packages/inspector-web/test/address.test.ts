import { linkOf } from "@estoc/object";
import { describe, expect, it } from "vitest";
import { fragmentOf, linkIn } from "../src/address.ts";

const link = linkOf(Uint8Array.of(1));

describe("the fragment of a link", () => {
  it("names the link", () => {
    expect(linkIn(fragmentOf(link))).toBe(link);
  });
});

describe("the link in a fragment", () => {
  it("is nothing for the empty fragment", () => {
    expect(linkIn("")).toBeUndefined();
    expect(linkIn("#")).toBeUndefined();
  });

  it("is nothing for text that is not a link", () => {
    expect(linkIn("#blobs")).toBeUndefined();
    expect(linkIn(`#${link.toUpperCase()}`)).toBeUndefined();
    expect(linkIn(`#${link}0`)).toBeUndefined();
  });
});

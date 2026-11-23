import { describe, expect, it } from "vitest";
import { fragmentOf, placeIn } from "../src/place.ts";

describe("the fragment of a place", () => {
  it.each([
    [{ list: "Blobs" }, "#list=Blobs"],
    [{ list: "Blobs", from: 350 }, "#list=Blobs&from=350"],
    [{ list: "Held Keys & more", from: 0 }, "#list=Held+Keys+%26+more&from=0"],
  ])("reads back as the place %j", (place, fragment) => {
    expect(fragmentOf(place)).toBe(fragment);
    expect(placeIn(fragment)).toEqual(place);
  });
});

describe("the place in a fragment", () => {
  it.each(["", "#", "#from=3", "#sha256:00"])("is none where %j names no list", (fragment) => {
    expect(placeIn(fragment)).toBeUndefined();
  });

  it.each([
    "#list=Blobs&from=",
    "#list=Blobs&from=+",
    "#list=Blobs&from=-1",
    "#list=Blobs&from=1.5",
    "#list=Blobs&from=soon",
    "#list=Blobs&from=1e2",
    "#list=Blobs&from=0x10",
    "#list=Blobs&from=99999999999999999999",
  ])("is where the list as shown begins where %j does not count rows", (fragment) => {
    expect(placeIn(fragment)).toEqual({ list: "Blobs" });
  });
});

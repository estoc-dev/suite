import { linkOf } from "@estoc/object";
import { describe, expect, it } from "vitest";
import { fragmentOf, placeIn } from "../src/place.ts";

const blob = linkOf(Uint8Array.of(0, 10, 255));
const other = linkOf(Uint8Array.of(1));

describe("the fragment of a place", () => {
  it.each([
    [{ list: "Blobs" }, "#list=Blobs"],
    [{ list: "Blobs", from: 350 }, "#list=Blobs&from=350"],
    [{ list: "Held Keys & more", from: 0 }, "#list=Held+Keys+%26+more&from=0"],
    [{ list: "Links", prefix: [blob] }, `#list=Links&prefix=${encodeURIComponent(blob)}`],
    [
      { list: "Links", prefix: [blob, other], from: 50 },
      `#list=Links&prefix=${encodeURIComponent(blob)}&prefix=${encodeURIComponent(other)}&from=50`,
    ],
    [{ blob }, `#${blob}`],
    [{ actions: "all" } as const, "#actions"],
    [{ action: blob }, `#action=${encodeURIComponent(blob)}`],
    [
      { action: blob, filledField: { name: "sent to", link: other } },
      `#action=${encodeURIComponent(blob)}&field=sent+to&link=${encodeURIComponent(other)}`,
    ],
  ])("reads back as the place %j", (place, fragment) => {
    expect(fragmentOf(place)).toBe(fragment);
    expect(placeIn(fragment)).toEqual(place);
  });
});

describe("the place in a fragment", () => {
  it.each(["", "#", "#from=3", "#sha256:00", `#${blob.toUpperCase()}`, `#blob=${blob}`, "#action=", "#action=Send"])(
    "is none where %j names no list and no action, and is not a link",
    (fragment) => {
      expect(placeIn(fragment)).toBeUndefined();
    },
  );

  it("is none where the prefix of a list holds what is not a link", () => {
    expect(placeIn(`#list=Links&prefix=${encodeURIComponent(blob)}&prefix=somewhere`)).toBeUndefined();
  });

  it.each([
    `#action=${encodeURIComponent(blob)}&field=to`,
    `#action=${encodeURIComponent(blob)}&link=${encodeURIComponent(other)}`,
    `#action=${encodeURIComponent(blob)}&field=to&link=somewhere`,
  ])("is the action with no field filled in where %j does not name a field and a link", (fragment) => {
    expect(placeIn(fragment)).toEqual({ action: blob });
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

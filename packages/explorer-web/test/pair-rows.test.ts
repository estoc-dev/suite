import { heldLinks } from "@estoc/explorer";
import { type Link, LinkValue, linkOf } from "@estoc/object";
import { describe, expect, it, vi } from "vitest";
import { readLinksUnder } from "../src/pair-rows.ts";
import { pairListOf, sourceOf } from "./fixtures.ts";

describe("the links under a link in a list of pairs", () => {
  const target = linkOf(Uint8Array.of(1));
  const sourcesOf = (count: number): Link<unknown>[] =>
    Array.from({ length: count }, (_, at) => linkOf(Uint8Array.of(2, at)));
  const listOver = (sources: readonly Link<unknown>[]) =>
    sourceOf(pairListOf(heldLinks, [linkOf(Uint8Array.of(0)), target], ...sources.map((s) => [target, s] as const)));

  it("are what the rows under it hold in the second field, with how many rows there are", async () => {
    const sources = sourcesOf(3);
    expect(await readLinksUnder(listOver(sources), heldLinks, target)).toEqual({ links: sources, rowCount: 3 });
  });

  it("are those of the first ten rows, read as one page under the link", async () => {
    const sources = sourcesOf(25);
    const source = listOver(sources);
    const page = vi.spyOn(source, "page");
    expect(await readLinksUnder(source, heldLinks, target)).toEqual({ links: sources.slice(0, 10), rowCount: 25 });
    expect(page.mock.calls).toEqual([["Links", [new LinkValue(target)], 0, 10]]);
  });

  it("are none where no row is under it", async () => {
    expect(await readLinksUnder(listOver([]), heldLinks, linkOf(Uint8Array.of(9)))).toEqual({ links: [], rowCount: 0 });
  });
});

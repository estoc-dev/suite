import { linkOf } from "@estoc/object";
import { describe, expect, it, vi } from "vitest";
import { readLinkSetPage } from "../src/link-page.ts";
import { sourceOf, sourceWithLinks } from "./fixtures.ts";

describe("a page of a set of links", () => {
  const target = linkOf(Uint8Array.of(1));
  const schema = linkOf(Uint8Array.of(3));
  const held = Array.from({ length: 120 }, (_, at) => linkOf(Uint8Array.of(2, at)));
  const source = sourceWithLinks(sourceOf(), {
    objects: [[target, schema], ...held.map((object) => [schema, object] as const)],
    links: [[schema, target], ...held.slice(0, 30).map((source) => [target, source] as const)],
  });

  it("holds the first of the objects written to a schema, and where the next page begins", async () => {
    expect(await readLinkSetPage(source, { objectsOf: schema }, undefined)).toEqual({
      links: held.slice(0, 50),
      start: 0,
      linkCount: 120,
      next: 50,
    });
  });

  it("holds the links from where it is read, and where the pages before and after it begin", async () => {
    expect(await readLinkSetPage(source, { objectsOf: schema }, 70)).toEqual({
      links: held.slice(70),
      start: 70,
      linkCount: 120,
      previous: 20,
    });
    expect(await readLinkSetPage(source, { objectsOf: schema }, 30)).toMatchObject({ previous: 0, next: 80 });
  });

  it("holds what links to a blob, read as one page of the runtime", async () => {
    const sourcesOf = vi.spyOn(source, "sourcesOf");
    expect(await readLinkSetPage(source, { sourcesOf: target }, undefined)).toEqual({
      links: held.slice(0, 30),
      start: 0,
      linkCount: 30,
    });
    expect(sourcesOf.mock.calls).toEqual([[target, 0, 50]]);
  });

  it("holds no link where the set has none", async () => {
    expect(await readLinkSetPage(source, { sourcesOf: held[0] ?? target }, undefined)).toEqual({
      links: [],
      start: 0,
      linkCount: 0,
    });
  });
});

import { AbsentBlob, linkOf } from "@estoc/object";
import { describe, expect, it } from "vitest";
import { readListPage, readRowSchema } from "../src/list-page.ts";
import { entriesOf, entrySchema, type GivenList, listOf, sourceOf } from "./fixtures.ts";

async function pageOf(list: GivenList, from?: number) {
  const source = sourceOf(list);
  const { columns, rows, ...rest } = await readListPage(
    source,
    list.description,
    await readRowSchema(source, entrySchema.link),
    from,
  );
  return { counts: rows.map(({ count }) => count), ...rest };
}

const countsFrom = (first: number, last: number) =>
  Array.from({ length: Math.abs(last - first) + 1 }, (_, index) => first + Math.sign(last - first) * index);

describe("the row schema of a list", () => {
  it("names a column for each field of the schema, in the order the schema holds them", async () => {
    const { columns } = await readRowSchema(sourceOf(listOf("Entries", [])), entrySchema.link);
    expect(columns).toEqual([
      { name: "to", field: { type: "link", optional: true } },
      { name: "name", field: { type: "string" } },
      { name: "count", field: { type: "integer" } },
    ]);
  });

  it("is not read where the source gives no blob for it", async () => {
    const absent = linkOf(new Uint8Array([1]));
    await expect(readRowSchema(sourceOf(), absent)).rejects.toThrow(new AbsentBlob(absent));
  });
});

describe("a page of a list that keeps the order its rows were written in", () => {
  it("holds the rows written last, newest first, where it reads from no place", async () => {
    expect(await pageOf(listOf("Entries", entriesOf(120)))).toEqual({
      counts: countsFrom(119, 70),
      start: 70,
      rowCount: 120,
      next: { list: "Entries", from: 70 },
    });
  });

  it("holds the rows before the place it reads from, between the pages beside it", async () => {
    expect(await pageOf(listOf("Entries", entriesOf(200)), 120)).toEqual({
      counts: countsFrom(119, 70),
      start: 70,
      rowCount: 200,
      previous: { list: "Entries", from: 170 },
      next: { list: "Entries", from: 70 },
    });
  });

  it("comes after the page that reads from no place where fewer rows than a page were written after it", async () => {
    expect(await pageOf(listOf("Entries", entriesOf(120)), 90)).toMatchObject({
      counts: countsFrom(89, 40),
      previous: { list: "Entries" },
    });
  });

  it("holds the rows left at the front of the list, with no page after it", async () => {
    expect(await pageOf(listOf("Entries", entriesOf(120)), 20)).toEqual({
      counts: countsFrom(19, 0),
      start: 0,
      rowCount: 120,
      previous: { list: "Entries", from: 70 },
    });
  });

  it("holds the same rows once more are written", async () => {
    const list = listOf("Entries", entriesOf(120));
    const before = await pageOf(list, 70);
    list.rows.push({ name: "written later", count: 120 });
    expect((await pageOf(list, 70)).counts).toEqual(before.counts);
    expect((await pageOf(list)).counts).toEqual(countsFrom(120, 71));
  });

  it("holds no rows and stands beside no page where the list has none", async () => {
    expect(await pageOf(listOf("Entries", []))).toEqual({ counts: [], start: 0, rowCount: 0 });
  });
});

describe("a page of a list sorted by its fields", () => {
  const sortedList = (count: number) => listOf("Entries", entriesOf(count), ["count"]);

  it("holds the rows at the front, in the order of the list, where it reads from no place", async () => {
    expect(await pageOf(sortedList(120))).toEqual({
      counts: countsFrom(0, 49),
      start: 0,
      rowCount: 120,
      next: { list: "Entries", from: 50 },
    });
  });

  it("holds the rows after the place it reads from, between the pages beside it", async () => {
    expect(await pageOf(sortedList(200), 100)).toEqual({
      counts: countsFrom(100, 149),
      start: 100,
      rowCount: 200,
      previous: { list: "Entries", from: 50 },
      next: { list: "Entries", from: 150 },
    });
  });

  it("comes after the page that reads from no place where it reads from within a page of the front", async () => {
    expect(await pageOf(sortedList(120), 50)).toMatchObject({ previous: { list: "Entries" } });
  });

  it("holds the rows left at the end of the list, with no page after it", async () => {
    expect(await pageOf(sortedList(120), 100)).toEqual({
      counts: countsFrom(100, 119),
      start: 100,
      rowCount: 120,
      previous: { list: "Entries", from: 50 },
    });
  });
});

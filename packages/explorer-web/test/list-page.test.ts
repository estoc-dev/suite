import { AbsentBlob, type Link, LinkValue, linkOf } from "@estoc/object";
import { describe, expect, it } from "vitest";
import { readListPage, readRowSchema } from "../src/list-page.ts";
import { entriesOf, entrySchema, type GivenList, listOf, sourceOf } from "./fixtures.ts";

async function pageOf(list: GivenList, from?: number, prefix: readonly Link<unknown>[] = []) {
  const source = sourceOf(list);
  const { columns, rows, ...rest } = await readListPage(
    source,
    list.description,
    await readRowSchema(source, list.rowSchema.link),
    prefix,
    from,
  );
  return { counts: rows.map((row) => row[columns.findIndex(({ name }) => name === "count")]), ...rest };
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

describe("a row of a page", () => {
  it("holds a value for each column, and none where the row leaves the field out", async () => {
    const target = linkOf(new Uint8Array([1]));
    const list = listOf("Entries", [
      { name: "alone", count: 1 },
      { name: "linked", count: 2, to: new LinkValue(target) },
    ]);
    const source = sourceOf(list);
    const rowSchema = await readRowSchema(source, entrySchema.link);
    const { rows } = await readListPage(source, list.description, rowSchema, [], undefined);
    expect(rows).toEqual([
      [new LinkValue(target), "linked", 2],
      [undefined, "alone", 1],
    ]);
  });
});

describe("a page of a list sorted by no field", () => {
  it("holds the rows at the end, the last first, where it reads from no place", async () => {
    expect(await pageOf(listOf("Entries", entriesOf(120)))).toEqual({
      counts: countsFrom(119, 70),
      start: 70,
      rowCount: 120,
      next: 70,
    });
  });

  it("holds the rows before the place it reads from, between the pages beside it", async () => {
    expect(await pageOf(listOf("Entries", entriesOf(200)), 120)).toEqual({
      counts: countsFrom(119, 70),
      start: 70,
      rowCount: 200,
      previous: 170,
      next: 70,
    });
  });

  it("comes after a page that reads from the end of the list where fewer rows than a page come after it", async () => {
    expect(await pageOf(listOf("Entries", entriesOf(120)), 90)).toMatchObject({
      counts: countsFrom(89, 40),
      previous: 120,
    });
  });

  it("comes after the same page once more rows are added at the end", async () => {
    const list = listOf("Entries", entriesOf(120));
    const { previous } = await pageOf(list, 70);
    list.rows.push(...entriesOf(180).slice(120));
    expect(await pageOf(list, previous)).toMatchObject({ counts: countsFrom(119, 70), previous: 170, next: 70 });
  });

  it("holds the rows left at the front of the list, with no page after it", async () => {
    expect(await pageOf(listOf("Entries", entriesOf(120)), 20)).toEqual({
      counts: countsFrom(19, 0),
      start: 0,
      rowCount: 120,
      previous: 70,
    });
  });

  it("holds the same rows once more are added at the end", async () => {
    const list = listOf("Entries", entriesOf(120));
    const before = await pageOf(list, 70);
    list.rows.push({ name: "written later", count: 120 });
    expect((await pageOf(list, 70)).counts).toEqual(before.counts);
    expect((await pageOf(list)).counts).toEqual(countsFrom(120, 71));
  });

  it("holds no rows and stands beside no page where the list has none", async () => {
    expect(await pageOf(listOf("Entries", []))).toEqual({ counts: [], start: 0, rowCount: 0 });
  });

  it("holds no rows where it reads from the front of the list, and comes after the page that holds the first", async () => {
    expect(await pageOf(listOf("Entries", entriesOf(120)), 0)).toEqual({
      counts: [],
      start: 0,
      rowCount: 120,
      previous: 50,
    });
  });
});

describe("a page of a list sorted by its fields", () => {
  const sortedList = (count: number) => listOf("Entries", entriesOf(count), ["count"]);

  it("holds the rows at the front, in the order of the list, where it reads from no place", async () => {
    expect(await pageOf(sortedList(120))).toEqual({
      counts: countsFrom(0, 49),
      start: 0,
      rowCount: 120,
      next: 50,
    });
  });

  it("holds the columns of the fields it is sorted by first, and after them the others", async () => {
    const list = listOf("Entries", entriesOf(1), ["count", "name"]);
    const source = sourceOf(list);
    const rowSchema = await readRowSchema(source, entrySchema.link);
    const { columns, rows } = await readListPage(source, list.description, rowSchema, [], undefined);
    expect(columns.map(({ name }) => name)).toEqual(["count", "name", "to"]);
    expect(rows).toEqual([[0, "entry 0", undefined]]);
  });

  it("holds the rows after the place it reads from, between the pages beside it", async () => {
    expect(await pageOf(sortedList(200), 100)).toEqual({
      counts: countsFrom(100, 149),
      start: 100,
      rowCount: 200,
      previous: 50,
      next: 150,
    });
  });

  it("comes after the page at the front of the list where it reads from within a page of the front", async () => {
    expect(await pageOf(sortedList(120), 30)).toMatchObject({ counts: countsFrom(30, 79), previous: 0 });
  });

  it("holds the rows left at the end of the list, with no page after it", async () => {
    expect(await pageOf(sortedList(120), 100)).toEqual({
      counts: countsFrom(100, 119),
      start: 100,
      rowCount: 120,
      previous: 50,
    });
  });

  it("holds the rows under the links of a prefix, and counts those alone", async () => {
    const target = linkOf(Uint8Array.of(1));
    const other = linkOf(Uint8Array.of(2));
    const rows = entriesOf(130).map((entry) => ({ ...entry, to: new LinkValue(entry.count < 70 ? target : other) }));
    const list = listOf("Entries", rows, ["to", "count"]);
    expect(await pageOf(list, undefined, [target])).toEqual({
      counts: countsFrom(0, 49),
      start: 0,
      rowCount: 70,
      next: 50,
    });
    expect(await pageOf(list, 50, [target])).toEqual({
      counts: countsFrom(50, 69),
      start: 50,
      rowCount: 70,
      previous: 0,
    });
    expect(await pageOf(list, undefined, [linkOf(Uint8Array.of(3))])).toEqual({ counts: [], start: 0, rowCount: 0 });
  });
});

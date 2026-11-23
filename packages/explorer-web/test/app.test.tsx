import { encodeObject, LinkValue, linkOf, type ValueMap } from "@estoc/object";
import { any, array, boolean, bytes, optional, schema, string } from "@estoc/schema";
import { render } from "@solidjs/web";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { App } from "../src/app.tsx";
import type { Source } from "../src/list-page.ts";
import { entriesOf, entrySchema, listOf, sourceHolding, sourceOf } from "./fixtures.ts";

function show(source: Source): HTMLElement {
  const root = document.createElement("div");
  onTestFinished(render(() => <App source={source} />, root));
  return root;
}

function open(fragment: string): void {
  location.hash = fragment;
  dispatchEvent(new Event("hashchange"));
}

const textsOf = (root: HTMLElement, selector: string) =>
  Array.from(root.querySelectorAll(selector), (node) => node.textContent);

const cellsOf = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("tbody tr"), (row) => Array.from(row.children, (cell) => cell.textContent));

const hrefsOf = (root: HTMLElement, selector: string) =>
  Array.from(root.querySelectorAll(selector), (node) => [node.textContent, node.getAttribute("href")]);

beforeEach(() => {
  location.hash = "";
});

describe("the page", () => {
  it("shows the first list of the runtime while the fragment names none, with a link to each list", async () => {
    const root = show(sourceOf(listOf("Entries", entriesOf(3)), listOf("Others", [])));
    await vi.waitFor(() => expect(cellsOf(root)).toHaveLength(3));
    expect(textsOf(root, "h1")).toEqual(["Entries"]);
    expect(hrefsOf(root, "header a")).toEqual([
      ["Entries", "#list=Entries"],
      ["Others", "#list=Others"],
    ]);
    expect(textsOf(root, "header [aria-current]")).toEqual(["Entries"]);
  });

  it("shows a column for each field of the row schema and a row for each row of the page, newest first", async () => {
    const root = show(sourceOf(listOf("Entries", entriesOf(3))));
    await vi.waitFor(() => expect(cellsOf(root)).toHaveLength(3));
    expect(textsOf(root, "th")).toEqual(["to", "name", "count"]);
    expect(cellsOf(root)).toEqual([
      ["", "entry 2", "2"],
      ["", "entry 1", "1"],
      ["", "entry 0", "0"],
    ]);
    expect(textsOf(root, ".turns")).toEqual(["Rows 1 to 3 of 3"]);
  });

  it("shows the list the fragment names, from the place it names, with links to the pages beside it", async () => {
    open("#list=Others&from=120");
    const root = show(sourceOf(listOf("Entries", []), listOf("Others", entriesOf(200))));
    await vi.waitFor(() => expect(cellsOf(root)).toHaveLength(50));
    expect(textsOf(root, "h1")).toEqual(["Others"]);
    expect(cellsOf(root)[0]).toEqual(["", "entry 119", "119"]);
    expect(hrefsOf(root, ".turns a")).toEqual([
      ["Previous", "#list=Others&from=170"],
      ["Next", "#list=Others&from=70"],
    ]);
    expect(textsOf(root, ".turns .muted")).toEqual(["Rows 71 to 120 of 200"]);
  });

  it("shows another page once the fragment names it", async () => {
    const root = show(sourceOf(listOf("Entries", entriesOf(120)), listOf("Others", entriesOf(1))));
    await vi.waitFor(() => expect(cellsOf(root)[0]).toEqual(["", "entry 119", "119"]));
    open("#list=Entries&from=70");
    await vi.waitFor(() => expect(cellsOf(root)[0]).toEqual(["", "entry 69", "69"]));
    open("#list=Others");
    await vi.waitFor(() => expect(cellsOf(root)).toEqual([["", "entry 0", "0"]]));
    expect(textsOf(root, "header [aria-current]")).toEqual(["Others"]);
  });

  it("says how a list is ordered and what it reads", async () => {
    const sorted = { ...listOf("Sorted", entriesOf(2), ["name", "count"]) };
    const read = listOf("Read", []);
    const root = show(sourceOf(sorted, { ...read, description: { ...read.description, readsBlobs: true } }));
    await vi.waitFor(() => expect(cellsOf(root)[0]).toEqual(["", "entry 0", "0"]));
    expect(textsOf(root, "main > .note")).toEqual(["Sorted by name, count. Read from the records of the store."]);
    open("#list=Read");
    await vi.waitFor(() =>
      expect(textsOf(root, "main > .note")).toEqual([
        "In the order written, newest first. Read from every blob the store holds, so a row may come of an object that a stranger sent.",
      ]),
    );
    expect(textsOf(root, ".card")).toEqual(["The page has no rows."]);
    expect(textsOf(root, ".turns")).toEqual(["0 rows"]);
  });

  it("shows a value of each type a field can be", async () => {
    const valuesSchema = schema("Values", {
      a: string(),
      b: boolean(),
      c: bytes(),
      d: array(string()),
      e: any(),
    });
    const target = linkOf(new Uint8Array([1]));
    const values = {
      a: "<b>text</b>",
      b: true,
      c: new Uint8Array([1, 255]),
      d: ["one", "two"],
      e: { to: new LinkValue(target) },
    };
    const root = show(
      sourceOf(
        listOf("Values", [values], [], valuesSchema),
        listOf("Entries", [{ name: "linked", count: 1, to: new LinkValue(target) }]),
      ),
    );
    await vi.waitFor(() =>
      expect(cellsOf(root)).toEqual([["<b>text</b>", "true", "2 bytes 01ff", "onetwo", "map · 1 member"]]),
    );
    expect(textsOf(root, "td li")).toEqual(["one", "two"]);
    open("#list=Entries");
    await vi.waitFor(() => expect(cellsOf(root)).toEqual([[target, "linked", "1"]]));
    expect(root.querySelector("td [title]")?.getAttribute("title")).toBe(target);
    expect(hrefsOf(root, "td a")).toEqual([[target, `#${target}`]]);
  });

  it("shows the blob the fragment names in place of a list, and the list again once the fragment names it", async () => {
    const entry = encodeObject(entrySchema, { name: "alone", count: 7 });
    open(`#${entry.link}`);
    const root = show(sourceHolding(sourceOf(listOf("Entries", entriesOf(1))), entry.bytes));
    await vi.waitFor(() =>
      expect(textsOf(root, "tbody tr")).toEqual(['name"alone"string', "count7integer", "toleft outlink · optional"]),
    );
    expect(textsOf(root, "h1")).toEqual(["Blob"]);
    expect(textsOf(root, ".head .title")).toEqual(["Entry"]);
    expect(textsOf(root, "header a")).toEqual(["Entries"]);
    expect(textsOf(root, "header [aria-current]")).toEqual([]);
    open("#list=Entries");
    await vi.waitFor(() => expect(cellsOf(root)).toEqual([["", "entry 0", "0"]]));
    expect(textsOf(root, "header [aria-current]")).toEqual(["Entries"]);
  });

  it("shows another blob once the fragment names it", async () => {
    const [first, second] = [encodeObject(entrySchema, { name: "first", count: 1 }), Uint8Array.of(0, 10, 255)];
    open(`#${first.link}`);
    const root = show(sourceHolding(sourceOf(), first.bytes, second));
    await vi.waitFor(() => expect(textsOf(root, ".head dd")[0]).toBe(first.link));
    open(`#${linkOf(second)}`);
    await vi.waitFor(() => expect(textsOf(root, ".head dd")).toEqual([linkOf(second), "3 bytes"]));
  });

  it("shows why a blob was not read", async () => {
    open(`#${linkOf(Uint8Array.of(1))}`);
    const root = show({ ...sourceOf(), get: () => Promise.reject(new Error("the channel is closed")) });
    await vi.waitFor(() => expect(textsOf(root, "main [role=alert]")).toEqual(["the channel is closed"]));
  });

  it("shows nothing where a row leaves out a field, whatever every object inherits under its name", async () => {
    const vehicleSchema = schema("Vehicle", { name: string(), constructor: optional(string()) });
    const vehicles: ValueMap[] = [{ name: "One" }, { name: "Two", constructor: "Factory" }];
    const root = show(sourceOf(listOf("Vehicles", vehicles, ["name"], vehicleSchema)));
    await vi.waitFor(() =>
      expect(cellsOf(root)).toEqual([
        ["One", ""],
        ["Two", "Factory"],
      ]),
    );
  });

  it("shows the page a link beside a page led to once more rows are written", async () => {
    const list = listOf("Entries", entriesOf(120));
    open("#list=Entries&from=70");
    const root = show(sourceOf(list));
    await vi.waitFor(() => expect(hrefsOf(root, ".turns a")[0]).toEqual(["Previous", "#list=Entries&from=120"]));
    list.rows.push(...entriesOf(180).slice(120));
    open("#list=Entries&from=120");
    await vi.waitFor(() => expect(textsOf(root, ".turns .muted")).toEqual(["Rows 71 to 120 of 180"]));
    expect(cellsOf(root)[0]).toEqual(["", "entry 119", "119"]);
  });

  it("says that the runtime gives no list of the name the fragment holds", async () => {
    open("#list=Nothing");
    const root = show(sourceOf(listOf("Entries", entriesOf(1))));
    await vi.waitFor(() => expect(textsOf(root, "main")).toEqual(["The runtime gives no list of that name."]));
  });

  it("shows why a page was not read, and the next page once the fragment names one that is", async () => {
    const source = sourceOf(listOf("Entries", entriesOf(120)));
    const root = show({
      ...source,
      page: (list, start, limit) =>
        start < 0 ? Promise.reject(new Error("the channel is closed")) : source.page(list, start, limit),
    });
    await vi.waitFor(() => expect(textsOf(root, "main [role=alert]")).toEqual(["the channel is closed"]));
    expect(textsOf(root, "header a")).toEqual(["Entries"]);
    open("#list=Entries&from=70");
    await vi.waitFor(() => expect(cellsOf(root)[0]).toEqual(["", "entry 69", "69"]));
    expect(textsOf(root, "[role=alert]")).toEqual([]);
  });

  it("shows why a page was not read in place of the page shown before it", async () => {
    const source = sourceOf(listOf("Entries", entriesOf(120)));
    const root = show({
      ...source,
      page: (list, start, limit) =>
        start < 0 ? source.page(list, start, limit) : Promise.reject(new Error("the channel is closed")),
    });
    await vi.waitFor(() => expect(cellsOf(root)).toHaveLength(50));
    open("#list=Entries&from=70");
    await vi.waitFor(() => expect(textsOf(root, "main [role=alert]")).toEqual(["the channel is closed"]));
    expect(cellsOf(root)).toEqual([]);
  });

  it("shows why the lists were not read", async () => {
    const root = show({ ...sourceOf(), lists: () => Promise.reject(new Error("the channel is closed")) });
    await vi.waitFor(() => expect(textsOf(root, "[role=alert]")).toEqual(["the channel is closed"]));
  });
});

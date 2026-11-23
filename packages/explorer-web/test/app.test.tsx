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

const navigation = new EventTarget();
vi.stubGlobal("navigation", navigation);

/** The handlers the page intercepts the navigation with. A browser runs them once it has changed the address. */
function navigate(url: string, sameDocument: boolean): NavigationInterceptHandler[] {
  const handlers: NavigationInterceptHandler[] = [];
  const intercept = ({ handler }: NavigationInterceptOptions) => handler && handlers.push(handler);
  navigation.dispatchEvent(Object.assign(new Event("navigate"), { destination: { url, sameDocument }, intercept }));
  return handlers;
}

/** Resolves when the page says that the place is shown. */
async function open(fragment: string): Promise<void> {
  location.hash = fragment;
  await Promise.all(navigate(location.href, true).map((handler) => handler()));
}

function gate(): { permissionToRead: Promise<void>; open: () => void } {
  let open = () => {};
  const permissionToRead = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { permissionToRead, open };
}

function finishOf(promise: Promise<void>): { promise: Promise<void>; isFinished: boolean } {
  const finish = { promise, isFinished: false };
  void promise.then(() => {
    finish.isFinished = true;
  });
  return finish;
}

/** Long enough for the page to settle on what it can show without another read. */
const turn = () => new Promise((resolve) => setTimeout(resolve));

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
    location.hash = "#list=Others&from=120";
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
    await open("#list=Entries&from=70");
    expect(cellsOf(root)[0]).toEqual(["", "entry 69", "69"]);
    await open("#list=Others");
    expect(cellsOf(root)).toEqual([["", "entry 0", "0"]]);
    expect(textsOf(root, "header [aria-current]")).toEqual(["Others"]);
  });

  it("says how a list is ordered and what it reads", async () => {
    const sorted = { ...listOf("Sorted", entriesOf(2), ["name", "count"]) };
    const read = listOf("Read", []);
    const root = show(sourceOf(sorted, { ...read, description: { ...read.description, readsBlobs: true } }));
    await vi.waitFor(() => expect(cellsOf(root)[0]).toEqual(["", "entry 0", "0"]));
    expect(textsOf(root, "main > .note")).toEqual(["Sorted by name, count. Read from the records of the store."]);
    await open("#list=Read");
    expect(textsOf(root, "main > .note")).toEqual([
      "In the order written, newest first. Read from every blob the store holds, so a row may come of an object that a stranger sent.",
    ]);
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
    await open("#list=Entries");
    expect(cellsOf(root)).toEqual([[target, "linked", "1"]]);
    expect(root.querySelector("td [title]")?.getAttribute("title")).toBe(target);
    expect(hrefsOf(root, "td a")).toEqual([[target, `#${target}`]]);
  });

  it("shows the blob the fragment names in place of a list, and the list again once the fragment names it", async () => {
    const entry = encodeObject(entrySchema, { name: "alone", count: 7 });
    location.hash = `#${entry.link}`;
    const root = show(sourceHolding(sourceOf(listOf("Entries", entriesOf(1))), entry.bytes));
    await vi.waitFor(() =>
      expect(textsOf(root, "tbody tr")).toEqual(['name"alone"string', "count7integer", "toleft outlink · optional"]),
    );
    expect(textsOf(root, "h1")).toEqual(["Blob"]);
    expect(textsOf(root, ".head .title")).toEqual(["Entry"]);
    expect(textsOf(root, "header a")).toEqual(["Entries"]);
    expect(textsOf(root, "header [aria-current]")).toEqual([]);
    await open("#list=Entries");
    expect(cellsOf(root)).toEqual([["", "entry 0", "0"]]);
    expect(textsOf(root, "header [aria-current]")).toEqual(["Entries"]);
  });

  it("shows another blob once the fragment names it", async () => {
    const [first, second] = [encodeObject(entrySchema, { name: "first", count: 1 }), Uint8Array.of(0, 10, 255)];
    location.hash = `#${first.link}`;
    const root = show(sourceHolding(sourceOf(), first.bytes, second));
    await vi.waitFor(() => expect(textsOf(root, ".head dd")[0]).toBe(first.link));
    await open(`#${linkOf(second)}`);
    expect(textsOf(root, ".head dd")).toEqual([linkOf(second), "3 bytes"]);
  });

  it("keeps the place it shows, marked as pending, until the place a navigation names is read", async () => {
    const entry = encodeObject(entrySchema, { name: "alone", count: 7 });
    const source = sourceHolding(sourceOf(listOf("Entries", entriesOf(1))), entry.bytes);
    const reading = gate();
    const root = show({
      ...source,
      async get(link) {
        if (link === entry.link) await reading.permissionToRead;
        return source.get(link);
      },
    });
    await vi.waitFor(() => expect(textsOf(root, "h1")).toEqual(["Entries"]));
    const opened = open(`#${entry.link}`);
    await vi.waitFor(() => expect(root.querySelector("main.pending")).not.toBeNull());
    expect(textsOf(root, "h1")).toEqual(["Entries"]);
    reading.open();
    await opened;
    expect(textsOf(root, "h1")).toEqual(["Blob"]);
    expect(root.querySelector("main.pending")).toBeNull();
  });

  it("finishes a navigation to the place it is reading only when the place is shown", async () => {
    const entry = encodeObject(entrySchema, { name: "alone", count: 7 });
    const source = sourceHolding(sourceOf(listOf("Entries", entriesOf(1))), entry.bytes);
    const reading = gate();
    const root = show({
      ...source,
      async get(link) {
        if (link === entry.link) await reading.permissionToRead;
        return source.get(link);
      },
    });
    await vi.waitFor(() => expect(textsOf(root, "h1")).toEqual(["Entries"]));
    void open(`#${entry.link}`);
    await vi.waitFor(() => expect(root.querySelector("main.pending")).not.toBeNull());
    const again = finishOf(open(`#${entry.link}`));
    await turn();
    expect(again.isFinished).toBe(false);
    reading.open();
    await again.promise;
    expect(textsOf(root, "h1")).toEqual(["Blob"]);
  });

  it("finishes a navigation made before the first place is read only when the place it names is shown", async () => {
    const entry = encodeObject(entrySchema, { name: "alone", count: 7 });
    const source = sourceHolding(sourceOf(listOf("Entries", entriesOf(3))), entry.bytes);
    const reading = gate();
    location.hash = `#${entry.link}`;
    const root = show({
      ...source,
      async lists() {
        await reading.permissionToRead;
        return source.lists();
      },
    });
    const back = finishOf(open(""));
    await turn();
    expect(back.isFinished).toBe(false);
    expect(textsOf(root, "main")).toEqual(["Reading the store."]);
    reading.open();
    await back.promise;
    expect(cellsOf(root)).toHaveLength(3);
  });

  it("finishes a navigation made before the lists are read once it shows why they were not", async () => {
    const reading = gate();
    const root = show({
      ...sourceOf(),
      async lists() {
        await reading.permissionToRead;
        throw new Error("the channel is closed");
      },
    });
    const opened = open("#list=Entries");
    reading.open();
    await opened;
    expect(textsOf(root, "[role=alert]")).toEqual(["the channel is closed"]);
  });

  it("leaves a navigation to another document to the browser", async () => {
    const root = show(sourceOf(listOf("Entries", entriesOf(1))));
    await vi.waitFor(() => expect(textsOf(root, "h1")).toEqual(["Entries"]));
    expect(navigate("https://estoc.dev/", false)).toEqual([]);
  });

  it("says that it reads the store until the first place is read", async () => {
    const root = show({ ...sourceOf(), lists: () => new Promise(() => {}) });
    expect(textsOf(root, "main")).toEqual(["Reading the store."]);
  });

  it("shows why a blob was not read", async () => {
    location.hash = `#${linkOf(Uint8Array.of(1))}`;
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
    location.hash = "#list=Entries&from=70";
    const root = show(sourceOf(list));
    await vi.waitFor(() => expect(hrefsOf(root, ".turns a")[0]).toEqual(["Previous", "#list=Entries&from=120"]));
    list.rows.push(...entriesOf(180).slice(120));
    await open("#list=Entries&from=120");
    expect(textsOf(root, ".turns .muted")).toEqual(["Rows 71 to 120 of 180"]);
    expect(cellsOf(root)[0]).toEqual(["", "entry 119", "119"]);
  });

  it("says that the runtime gives no list of the name the fragment holds", async () => {
    location.hash = "#list=Nothing";
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
    await open("#list=Entries&from=70");
    expect(cellsOf(root)[0]).toEqual(["", "entry 69", "69"]);
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
    await open("#list=Entries&from=70");
    expect(textsOf(root, "main [role=alert]")).toEqual(["the channel is closed"]);
    expect(cellsOf(root)).toEqual([]);
  });

  it("shows why the lists were not read", async () => {
    const root = show({ ...sourceOf(), lists: () => Promise.reject(new Error("the channel is closed")) });
    await vi.waitFor(() => expect(textsOf(root, "[role=alert]")).toEqual(["the channel is closed"]));
  });
});

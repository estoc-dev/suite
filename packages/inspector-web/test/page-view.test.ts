// @vitest-environment happy-dom
import { encodeBundle } from "@estoc/bundle";
import { encodeObject, LinkValue, linkOf } from "@estoc/object";
import { link, schema } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { fragmentOf } from "../src/address.ts";
import { h } from "../src/dom.ts";
import { type Page, pageOf, readFile } from "../src/page.ts";
import { pageView } from "../src/page-view.ts";

const photo = Uint8Array.of(0, 10, 255);
const albumSchema = schema("Album", { cover: link() });
const album = encodeObject(albumSchema, { cover: new LinkValue(linkOf(photo)) });
const albumFile = new File([encodeBundle(album.link, [album.bytes, photo])], "album.eof");

const viewOf = (page: Page) =>
  h(
    "div",
    null,
    pageView(page, () => {}),
  );

const textsOf = (view: HTMLElement, selector: string) =>
  Array.from(view.querySelectorAll(selector), (node) => node.textContent);

describe("the view of a page", () => {
  it("has a place to choose a file where none is open", () => {
    const view = viewOf({ kind: "closed" });
    expect(view.querySelectorAll("input[type=file]")).toHaveLength(1);
    expect(view.querySelectorAll("[role=alert]")).toHaveLength(0);
  });

  it("names a file that could not be read, with what stopped the reading", () => {
    const view = viewOf({ kind: "unread", name: "lost.eof", error: new Error("the file was removed") });
    expect(textsOf(view, "[role=alert] p")).toEqual(["lost.eof could not be read.", "the file was removed"]);
  });

  it("leaves no link to follow, and a place to choose a file, where the file could not be read", () => {
    const view = viewOf({ kind: "unread", name: "lost.eof", error: new Error("the file was removed") });
    expect(view.querySelectorAll("a")).toHaveLength(0);
    expect(textsOf(view, "header")).toEqual(["Inspector"]);
    expect(view.querySelectorAll("input[type=file]")).toHaveLength(1);
  });

  it("names a file that is not a bundle, with why it is refused", async () => {
    const view = viewOf(await pageOf(readFile(new File([photo], "photo.jpg")), ""));
    expect(textsOf(view, "[role=alert] p:first-child")).toEqual([
      "photo.jpg is not a bundle: the root of a bundle is an object.",
    ]);
  });

  it("shows the root of an open file under its name and size, then its blobs", async () => {
    const view = viewOf(await pageOf(readFile(albumFile), ""));
    expect(textsOf(view, "header")).toEqual([`Inspector${`album.eof · ${albumFile.size} bytes`}Open another…`]);
    expect(textsOf(view, "h1")).toEqual(["Root"]);
    expect(textsOf(view, ".head dd:first-of-type")).toEqual([album.link]);
    expect(view.querySelectorAll(".blobs li")).toHaveLength(2);
  });

  it("says of a link the file has no blob for that a bundle can leave blobs out", async () => {
    const view = viewOf(await pageOf(readFile(albumFile), fragmentOf(albumSchema.link)));
    expect(textsOf(view, "h1")).toEqual(["Absent"]);
    expect(textsOf(view, "main > .note")).toEqual([
      "A bundle need not be complete: it can leave out a blob that its reader already holds.",
    ]);
  });
});

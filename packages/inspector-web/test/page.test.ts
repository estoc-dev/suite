import { markdownBodyOf, postSchema } from "@estoc/blog";
import { encodeBundle } from "@estoc/bundle";
import { encodeObject, LinkValue, linkOf } from "@estoc/object";
import { link, schema } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { fragmentOf } from "../src/address.ts";
import { latestOnly } from "../src/latest.ts";
import { type Page, pageOf, readFile } from "../src/page.ts";

const photo = Uint8Array.of(0, 10, 255);
const albumSchema = schema("Album", { cover: link() });
const album = encodeObject(albumSchema, { cover: new LinkValue(linkOf(photo)) });
const albumFile = new File([encodeBundle(album, [photo])], "album.eof");

const body = markdownBodyOf("## Identity\n");
const post = encodeObject(postSchema, { title: "Identity", date: "2026-10-20", body: new LinkValue(body.link) });
const postFile = new File([encodeBundle(post, [body.bytes])], "post.eof");

const removal = new Error("the file was removed");

/** A file that gives no bytes once `fail` is called, as one removed after it was chosen. */
function lostFile(name: string): { readonly file: Pick<File, "name" | "arrayBuffer">; readonly fail: () => void } {
  let fail = () => {};
  const bytes = new Promise<ArrayBuffer>((_, reject) => {
    fail = () => reject(removal);
  });
  return { file: { name, arrayBuffer: () => bytes }, fail: () => fail() };
}

describe("reading a file", () => {
  it("gives the bundle of a file that is one, with its blobs", async () => {
    const file = await readFile(albumFile);
    expect(file).toMatchObject({ kind: "open", name: "album.eof" });
    if (file.kind !== "open") throw new Error(file.kind);
    expect(file.bundle.link).toBe(album.link);
    expect(file.blobs.map(({ inspection }) => inspection.link)).toEqual([album.link, linkOf(photo)]);
  });

  it("gives a refusal for bytes that are not a bundle", async () => {
    const file = await readFile(new File([photo], "photo.jpg"));
    expect(file).toMatchObject({ kind: "refused", name: "photo.jpg" });
  });

  it("gives the failure of a file that gives no bytes, and does not throw it", async () => {
    const lost = lostFile("lost.eof");
    lost.fail();
    expect(await readFile(lost.file)).toEqual({ kind: "unread", name: "lost.eof", error: removal });
  });
});

describe("the page of a file", () => {
  it("is closed where no file was chosen", async () => {
    expect(await pageOf(undefined, "")).toEqual({ kind: "closed" });
  });

  it("is at the root for a fragment that names no link", async () => {
    const page = await pageOf(readFile(albumFile), "");
    expect(page).toMatchObject({ kind: "open", inspection: { kind: "object", link: album.link } });
  });

  it("is at the link that the fragment names", async () => {
    const page = await pageOf(readFile(albumFile), fragmentOf(linkOf(photo)));
    expect(page).toMatchObject({ kind: "open", inspection: { kind: "bytes", link: linkOf(photo) } });
  });

  it("has what the page makes of a body, at the link of the body", async () => {
    const page = await pageOf(readFile(postFile), fragmentOf(body.link));
    expect(page).toMatchObject({ inspection: { link: body.link }, reading: { html: "<h2>Identity</h2>\n" } });
  });

  it("has no more than the fields of an object of a schema the page does not read", async () => {
    const page = await pageOf(readFile(postFile), "");
    expect(page).toMatchObject({ inspection: { link: post.link }, reading: undefined });
  });

  it("is the failure of a file that could not be read, at any fragment", async () => {
    const lost = lostFile("lost.eof");
    lost.fail();
    const fileTask = readFile(lost.file);
    expect(await pageOf(fileTask, "")).toEqual({ kind: "unread", name: "lost.eof", error: removal });
    expect(await pageOf(fileTask, fragmentOf(album.link))).toEqual({
      kind: "unread",
      name: "lost.eof",
      error: removal,
    });
  });
});

describe("the pages shown as files are chosen", () => {
  it("have the failure of the file chosen last, in place of the file before it", async () => {
    const shownPages: Page[] = [];
    const show = latestOnly<Page>((page) => shownPages.push(page));
    await show(pageOf(readFile(albumFile), ""));
    const lost = lostFile("lost.eof");
    const lastPage = show(pageOf(readFile(lost.file), ""));
    lost.fail();
    await lastPage;
    expect(shownPages.map(({ kind }) => kind)).toEqual(["open", "unread"]);
  });

  it("do not have the failure of an earlier file that fails after a later one is shown", async () => {
    const shownPages: Page[] = [];
    const show = latestOnly<Page>((page) => shownPages.push(page));
    const lost = lostFile("lost.eof");
    const earlierPage = show(pageOf(readFile(lost.file), ""));
    await show(pageOf(readFile(albumFile), ""));
    lost.fail();
    await earlierPage;
    expect(shownPages.map(({ kind }) => kind)).toEqual(["open"]);
  });
});

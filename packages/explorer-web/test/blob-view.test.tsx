import { markdownBodyOf, markdownBodySchema } from "@estoc/blog";
import { ed25519, loadIdentity, SoftwareSigner } from "@estoc/identity";
import {
  encodeObject,
  type Link,
  LinkValue,
  linkOf,
  ObjectValue,
  objectFormat,
  type Schema,
  type ValueMap,
} from "@estoc/object";
import { any, array, link, optional, rootSchema, schema, string } from "@estoc/schema";
import { render } from "@solidjs/web";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { BlobView } from "../src/blob-view.tsx";
import { readerOf } from "./fixtures.ts";

/** The view of the blob at `link`, once it shows what `blobs` give for it. */
async function viewAt(link: Link<unknown>, ...blobs: readonly Uint8Array[]): Promise<HTMLElement> {
  const reader = readerOf(...blobs);
  const root = document.createElement("div");
  onTestFinished(render(() => <BlobView reader={reader} link={link} />, root));
  await vi.waitFor(() => expect(root.querySelector(".head")).not.toBeNull());
  return root;
}

function viewOf(objectSchema: Schema, data: ValueMap, ...others: readonly Uint8Array[]): Promise<HTMLElement> {
  const bytes = objectFormat.encode(new ObjectValue(objectSchema.link, data));
  return viewAt(linkOf(bytes), bytes, ...objectSchema.blobs, ...others);
}

const textsOf = (view: HTMLElement, selector: string) =>
  Array.from(view.querySelectorAll(selector), (node) => node.textContent);

const hrefsOf = (view: HTMLElement, selector: string) =>
  Array.from(view.querySelectorAll(selector), (node) => node.getAttribute("href"));

const partsOf = (view: HTMLElement) =>
  Array.from(view.querySelector(".card")?.children ?? [], ({ className, tagName }) => className || tagName);

const photo = Uint8Array.of(0, 10, 255);
const noteSchema = schema("Note", { text: string(), tags: array(string()), more: optional(any()) });

describe("the view of a blob", () => {
  it("shows the link alone where no blob is given for it", async () => {
    const view = await viewAt(linkOf(photo));
    expect(textsOf(view, "dt, dd")).toEqual(["Link", linkOf(photo)]);
    expect(textsOf(view, ".note")).toEqual(["The runtime gives no blob for it."]);
  });

  it("shows the size and the hex of bytes that are not an object", async () => {
    const view = await viewAt(linkOf(photo), photo);
    expect(textsOf(view, "dt, dd")).toEqual(["Link", linkOf(photo), "Size", "3 bytes"]);
    expect(textsOf(view, ".dump")).toEqual(["000aff"]);
  });

  it("leads from an object to the schema it names and to each link in its data", async () => {
    const albumSchema = schema("Album", { cover: link(), more: any() });
    const other = linkOf(Uint8Array.of(1));
    const view = await viewOf(albumSchema, {
      cover: new LinkValue(linkOf(photo)),
      more: [{ to: new LinkValue(other) }],
    });
    expect(hrefsOf(view, "a")).toEqual([`#${albumSchema.link}`, `#${other}`, `#${linkOf(photo)}`]);
  });

  it("shows the title of the schema, that the data fits it, and a row for each field", async () => {
    const view = await viewOf(noteSchema, { text: "<em>a word</em>", tags: [] });
    expect(textsOf(view, ".head dd")).toEqual([
      expect.stringMatching(/^sha256:/),
      expect.stringMatching(/ bytes$/),
      `Note ${noteSchema.link}The data fits it.`,
    ]);
    expect(textsOf(view, "tr")).toEqual([
      "FieldValueType",
      "tags" + "array · 0 items" + "array of string",
      "text" + '"<em>a word</em>"' + "string",
      "more" + "left out" + "any · optional",
    ]);
    expect(view.querySelector("em")).toBeNull();
    expect(view.querySelector(".reading")).toBeNull();
  });

  it("marks a problem at the value it is of", async () => {
    const view = await viewOf(noteSchema, { text: 7, tags: ["a", 8], more: { at: photo } });
    expect(textsOf(view, ".head .problem")).toEqual(["The data does not fit it: 2 problems."]);
    expect(textsOf(view, "tbody tr")).toEqual([
      "more" + "map · 1 member" + "at3 bytes 000aff" + "any · optional",
      "tags" + "array · 2 items" + '0"a"' + "18not a string" + "array of string",
      "text7not a stringstring",
    ]);
  });

  it("lists once, under the schema, a problem that reads as that of more than one value", async () => {
    const named = schema("Named", { a: any(), "a/0": string(), label: string(), "label: detail": string() });
    const view = await viewOf(named, {
      a: ["valid nested text"],
      "a/0": 7,
      label: "valid field text",
      "label: detail": 8,
    });
    expect(textsOf(view, "table .problem")).toEqual([]);
    expect(textsOf(view, ".head .problem")).toEqual([
      "The data does not fit it: 2 problems.",
      "#/a/0: not a string",
      "#/label: detail: not a string",
    ]);
  });

  it("says that a schema written to itself is, and shows no type where the schema is not given or is not one", async () => {
    const itself = await viewAt(rootSchema.link, ...rootSchema.blobs);
    expect(textsOf(itself, ".head p")).toEqual(["The object is written to itself. The data fits it."]);

    const note = objectFormat.encode(new ObjectValue(noteSchema.link, { text: "a note", tags: [] }));
    const untyped = await viewAt(linkOf(note), note);
    expect(textsOf(untyped, ".head p")).toEqual(["The runtime gives no blob for it."]);
    expect(textsOf(untyped, "th")).toEqual(["Field", "Value"]);

    const toNote = objectFormat.encode(new ObjectValue(linkOf(note), { text: "a note" }));
    const refused = await viewAt(linkOf(toNote), toNote, note, ...noteSchema.blobs);
    expect(textsOf(refused, ".head .problem")).toEqual([expect.stringMatching(/^Not a schema of Estoc Schema: /)]);
    expect(textsOf(refused, "th")).toEqual(["Field", "Value"]);
  });

  it("says that an object with no data has no fields", async () => {
    const view = await viewOf(schema("Nothing", {}), {});
    expect(textsOf(view, ".card > .note")).toEqual(["The object has no fields."]);
  });

  it("shows the body the page reads the object as, rendered above its fields", async () => {
    const body = markdownBodyOf("a *word* and <b>markup</b>");
    const view = await viewAt(body.link, body.bytes, ...markdownBodySchema.blobs);
    expect(textsOf(view, ".reading .band")).toEqual(["Read by this page as the body of a post"]);
    expect(textsOf(view, ".rendered em")).toEqual(["word"]);
    expect(view.querySelector(".rendered b")).toBeNull();
    expect(partsOf(view)).toEqual(["head", "reading", "fields"]);
  });

  it("says above its fields why the page could not read the object as a body", async () => {
    const view = await viewOf(markdownBodySchema, { text: 7 });
    expect(textsOf(view, ".reading p")).toEqual([
      "Not read by this page as the body of a post",
      "the data does not fit its schema: #/text: not a string",
    ]);
    expect(view.querySelector(".rendered")).toBeNull();
    expect(partsOf(view)).toEqual(["head", "reading", "fields"]);
  });

  it("names who signed, the key that signed and the object of a signature, each as a link to follow", async () => {
    const { keys, publish, signatures } = loadIdentity([ed25519]);
    const root = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
    const agent = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(2));
    const signedIdentity = await publish(root, { agents: [agent.key], at: 1763078400000 });
    const signed = encodeObject(noteSchema, { text: "signed", tags: [] });
    const signature = await signatures.actor(agent, signedIdentity, async (inHand) => inHand).sign(signed);
    const view = await viewAt(signature.link, ...signature.blobs);
    expect(textsOf(view, ".reading .band")).toEqual(["Read by this page as a signature"]);
    expect(textsOf(view, ".reading dt")).toEqual(["Identifier", "Key", "Object"]);
    expect(hrefsOf(view, ".reading dd a")).toEqual(
      [keys.encode(root.key).link, keys.encode(agent.key).link, signed.link].map((link) => `#${link}`),
    );
    expect(textsOf(view, ".reading .note")).toEqual([
      "Honored by the identity version it carries and those that version follows alone. The page looks at no others to verify it, a later crisis that the store holds among them.",
    ]);
  });
});

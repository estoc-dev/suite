import { decodeObject, encodeObject, LinkValue, linkOf } from "@estoc/object";
import { array, boolean, integer, link, optional, schema, string } from "@estoc/schema";
import { describe, expect, it, vi } from "vitest";
import { performForm, readActionForms, requestOf } from "../src/action-page.ts";
import { entrySchema, type GivenAction, sourceOf, sourceWithActions } from "./fixtures.ts";

const greetingSchema = schema("Greeting", { text: string(), to: link() });

const greet: GivenAction = {
  requestSchema: schema("Greet", {
    words: string(),
    to: link(),
    note: optional(string()),
    others: optional(array(link())),
  }),
  resultSchema: greetingSchema,
  targetSchemas: { to: entrySchema, others: entrySchema },
  perform: async ({ words, to }) => ({ result: { text: `${words}!`, ...(to !== undefined && { to }) }, commits: [] }),
};

const count: GivenAction = {
  requestSchema: schema("Count", { from: integer(), isLoud: optional(boolean()), all: array(link()) }),
  resultSchema: schema("Counted", {}),
  perform: async () => ({ result: {}, commits: [] }),
};

const entry = encodeObject(entrySchema, { name: "alone", count: 7 });
const other = linkOf(Uint8Array.of(1));

const formsOf = (...actions: readonly GivenAction[]) => readActionForms(sourceWithActions(sourceOf(), ...actions));

async function given(action: GivenAction) {
  const source = sourceWithActions(sourceOf(), action);
  const [form] = await readActionForms(source);
  if (form === undefined) throw new Error("the source lists no action");
  return { source, form };
}

const formOf = async (action: GivenAction) => (await given(action)).form;
const typed = (texts: Record<string, string>) => new Map(Object.entries(texts));

describe("the forms of the actions", () => {
  it("hold, for each action in the order of the runtime, the titles of its schemas and the fields of its request schema", async () => {
    expect(await formsOf(greet, count)).toMatchObject([
      {
        title: "Greet",
        request: { link: greet.requestSchema.link },
        result: { link: greetingSchema.link, title: "Greeting" },
        fields: [
          { name: "to", field: { type: "link" }, target: { link: entrySchema.link, title: "Entry" } },
          { name: "note", field: { type: "string", optional: true } },
          { name: "words", field: { type: "string" } },
          {
            name: "others",
            field: { type: "array", items: { type: "link" }, optional: true },
            target: { link: entrySchema.link, title: "Entry" },
          },
        ],
      },
      { title: "Count", result: { title: "Counted" } },
    ]);
  });

  it("hold no target for a field that the action names no schema for", async () => {
    const { fields } = await formOf(count);
    expect(fields.map((field) => "target" in field)).toEqual([false, false, false]);
  });
});

describe("the request of a form", () => {
  const dataOf = async (action: GivenAction, texts: Record<string, string>) => {
    const form = await formOf(action);
    return decodeObject(requestOf(form, typed(texts)), form.request).data;
  };

  it("holds a string as it was typed, a link without the space around it, and each link of an array", async () => {
    expect(
      await dataOf(greet, { words: " good day ", to: ` ${entry.link}\n`, others: `${other}\n  ${entry.link} ` }),
    ).toEqual({
      words: " good day ",
      to: new LinkValue(entry.link),
      others: [new LinkValue(other), new LinkValue(entry.link)],
    });
  });

  it("leaves out an optional field that nothing is typed for", async () => {
    expect(await dataOf(greet, { words: "", to: entry.link, note: " ", others: "\n" })).toEqual({
      words: "",
      to: new LinkValue(entry.link),
    });
  });

  it("is refused where a field of links holds what is not a link", async () => {
    await expect(dataOf(greet, { words: "hello" })).rejects.toThrow('the field to takes a link, which "" is not');
    await expect(dataOf(greet, { words: "hello", to: entry.link, others: `${other} nearby` })).rejects.toThrow(
      'the field others takes a link, which "nearby" is not',
    );
  });

  it("is refused where a field that is not optional is of a type the page has no input for", async () => {
    await expect(dataOf(count, { all: other })).rejects.toThrow("the page has no input for the field from, integer");
  });

  it("leaves out an optional field of a type the page has no input for, and holds no link for an empty array", async () => {
    const optionalCount: GivenAction = {
      ...count,
      requestSchema: schema("Count", { isLoud: optional(boolean()), all: array(link()) }),
    };
    expect(await dataOf(optionalCount, {})).toEqual({ all: [] });
  });
});

describe("a form that is performed", () => {
  it("gives the result as the page of a blob, read from the bytes of the reply and not from the store", async () => {
    const { source, form } = await given(greet);
    const outcome = await performForm(source, form, typed({ words: "hello", to: entry.link }));
    const result = encodeObject(greetingSchema, { text: "hello!", to: new LinkValue(entry.link) });
    expect(await source.get(result.link)).toBeUndefined();
    expect(outcome).toMatchObject({
      kind: "performed",
      result: {
        inspection: { kind: "object", link: result.link, schema: { kind: "schema", problems: [] } },
        reading: undefined,
      },
      commits: [],
    });
  });

  it("gives the commits of the reply", async () => {
    const commits = [entry.link, other];
    const { source, form } = await given({
      requestSchema: schema("Tick", {}),
      resultSchema: schema("Ticked", {}),
      perform: async () => ({ result: {}, commits }),
    });
    expect(await performForm(source, form, typed({}))).toMatchObject({ kind: "performed", commits });
  });

  it("gives why the runtime failed", async () => {
    const perform = async () => {
      throw new Error("the mailbox gave no answer");
    };
    const { source, form } = await given({ ...greet, perform });
    const outcome = await performForm(source, form, typed({ words: "hello", to: entry.link }));
    expect(outcome).toEqual({ kind: "failed", error: new Error("the mailbox gave no answer") });
  });

  it("gives why a request was refused, and asks nothing of the runtime", async () => {
    const perform = vi.fn(greet.perform);
    const { source, form } = await given({ ...greet, perform });
    const outcome = await performForm(source, form, typed({ to: "somewhere" }));
    expect(outcome).toEqual({
      kind: "failed",
      error: new Error('the field to takes a link, which "somewhere" is not'),
    });
    expect(perform).not.toHaveBeenCalled();
  });
});

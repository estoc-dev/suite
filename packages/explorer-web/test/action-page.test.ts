import { decodeObject, encodeObject, LinkValue, linkOf } from "@estoc/object";
import { array, boolean, integer, link, optional, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { readActionForms, readResultPage, requestOf } from "../src/action-page.ts";
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
        result: { schema: { link: greetingSchema.link }, title: "Greeting" },
        fields: [
          { name: "to", field: { type: "link" }, target: { schema: { link: entrySchema.link }, title: "Entry" } },
          { name: "note", field: { type: "string", optional: true } },
          { name: "words", field: { type: "string" } },
          {
            name: "others",
            field: { type: "array", items: { type: "link" }, optional: true },
            target: { schema: { link: entrySchema.link }, title: "Entry" },
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

  it("holds a field named __proto__ as any other", async () => {
    const remember = { ...count, requestSchema: schema("Remember", { ["__proto__"]: optional(string()) }) };
    const form = await formOf(remember);
    const { data } = decodeObject(requestOf(form, new Map([["__proto__", "memo"]])), form.request);
    expect(Object.entries(data)).toEqual([["__proto__", "memo"]]);
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

describe("the page of a result", () => {
  const result = encodeObject(greetingSchema, { text: "hello!", to: new LinkValue(entry.link) });

  it("is read from the bytes of the reply and the result schema of the form, with no read of the source", async () => {
    const get = async () => {
      throw new Error("the channel is closed");
    };
    expect(await readResultPage({ get }, await formOf(greet), result.bytes)).toMatchObject({
      inspection: { kind: "object", link: result.link, schema: { kind: "schema", problems: [] } },
      reading: undefined,
    });
  });
});

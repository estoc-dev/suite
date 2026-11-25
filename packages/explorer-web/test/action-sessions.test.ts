import { encodeObject, LinkValue, linkOf } from "@estoc/object";
import { link, optional, schema, string } from "@estoc/schema";
import { describe, expect, it, vi } from "vitest";
import type { ActionSource } from "../src/action-page.ts";
import { ActionSessions } from "../src/action-sessions.ts";
import { entrySchema, type GivenAction, sourceOf, sourceWithActions } from "./fixtures.ts";

const greetingSchema = schema("Greeting", { text: string(), to: link() });

const greet: GivenAction = {
  requestSchema: schema("Greet", { words: string(), to: link(), note: optional(string()) }),
  resultSchema: greetingSchema,
  perform: async ({ words, to }) => ({ result: { text: `${words}!`, ...(to !== undefined && { to }) }, commits: [] }),
};

const tick: GivenAction = {
  requestSchema: schema("Tick", {}),
  resultSchema: schema("Ticked", {}),
  perform: async () => ({ result: {}, commits: [] }),
};

const entry = encodeObject(entrySchema, { name: "alone", count: 7 });
const other = linkOf(Uint8Array.of(1));

async function sessionOver(source: ActionSource) {
  const [session] = await new ActionSessions(source).all();
  if (session === undefined) throw new Error("the source lists no action");
  return session;
}

const sessionOf = (action: GivenAction) => sessionOver(sourceWithActions(sourceOf(), action));

describe("the sessions of the actions", () => {
  it("hold a session with the form of each action, in the order of the runtime", async () => {
    const sessions = await new ActionSessions(sourceWithActions(sourceOf(), greet, tick)).all();
    expect(sessions.map(({ form }) => form.title)).toEqual(["Greet", "Tick"]);
  });

  it("read the forms once, and give the same sessions each time", async () => {
    const source = sourceWithActions(sourceOf(), greet, tick);
    const actions = vi.spyOn(source, "actions");
    const sessions = new ActionSessions(source);
    expect(await sessions.all()).toBe(await sessions.all());
    expect(actions).toHaveBeenCalledTimes(1);
  });
});

describe("the session of an action", () => {
  it("holds the text that was set for a field, and no text for the others", async () => {
    const session = await sessionOf(greet);
    session.setText("words", " good day ");
    expect(["words", "to"].map((field) => session.textOf(field))).toEqual([" good day ", ""]);
    expect(session.state()).toBeUndefined();
  });

  it("has the runtime perform the action on the texts, and holds the commits and the page of the result", async () => {
    const commits = [entry.link, other];
    const session = await sessionOf({
      ...greet,
      perform: async (request) => ({ ...(await greet.perform(request)), commits }),
    });
    session.setText("words", "hello");
    session.setText("to", entry.link);
    await session.perform();
    const result = encodeObject(greetingSchema, { text: "hello!", to: new LinkValue(entry.link) });
    const state = session.state();
    expect(state).toMatchObject({ kind: "performed", commits });
    expect(state?.kind === "performed" && (await state.result)).toMatchObject({
      kind: "read",
      page: { inspection: { kind: "object", link: result.link } },
    });
  });

  it("holds the commits of a reply whose result could not be read, and has the action performed once", async () => {
    const commits = [entry.link];
    let isClosed = false;
    const perform = vi.fn(async () => {
      isClosed = true;
      return { result: {}, commits };
    });
    const source = sourceWithActions(sourceOf(), { ...tick, perform });
    const session = await sessionOver({
      ...source,
      async get(asked) {
        if (isClosed) throw new Error("the channel closed before the reply");
        return source.get(asked);
      },
    });
    await session.perform();
    const state = session.state();
    expect(state).toMatchObject({ kind: "performed", commits });
    expect(state?.kind === "performed" && (await state.result)).toEqual({
      kind: "unread",
      error: new Error("the channel closed before the reply"),
    });
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it("holds why the runtime failed", async () => {
    const perform = async () => {
      throw new Error("the mailbox gave no answer");
    };
    const session = await sessionOf({ ...tick, perform });
    await session.perform();
    expect(session.state()).toEqual({ kind: "failed", error: new Error("the mailbox gave no answer") });
  });

  it("holds why a request was refused, and asks nothing of the runtime", async () => {
    const perform = vi.fn(greet.perform);
    const session = await sessionOf({ ...greet, perform });
    session.setText("to", "somewhere");
    await session.perform();
    expect(session.state()).toEqual({
      kind: "failed",
      error: new Error('the field to takes a link, which "somewhere" is not'),
    });
    expect(perform).not.toHaveBeenCalled();
  });
});

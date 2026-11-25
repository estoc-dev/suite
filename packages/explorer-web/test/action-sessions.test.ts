import { encodeObject, LinkValue, linkOf } from "@estoc/object";
import { link, optional, schema, string } from "@estoc/schema";
import { describe, expect, it, vi } from "vitest";
import type { ActionSource } from "../src/action-page.ts";
import { ActionSessions } from "../src/action-sessions.ts";
import { entrySchema, type GivenAction, sourceOf, sourceWithActions, sourceWithLinks } from "./fixtures.ts";

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

  it("read the forms again after a read that failed, and keep the sessions of the one that did not", async () => {
    const source = sourceWithActions(sourceOf(), greet, tick);
    const actions = vi.spyOn(source, "actions").mockRejectedValueOnce(new Error("database is locked"));
    const sessions = new ActionSessions(source);
    await expect(sessions.all()).rejects.toThrow("database is locked");
    const read = await sessions.all();
    expect(read.map(({ form }) => form.title)).toEqual(["Greet", "Tick"]);
    expect(await sessions.all()).toBe(read);
    expect(actions).toHaveBeenCalledTimes(2);
  });
});

describe("entering the place of an action", () => {
  const place = { action: greet.requestSchema.link, filledField: { name: "to", link: entry.link } };

  it("gives the session of that action, with what was typed for it", async () => {
    const sessions = new ActionSessions(sourceWithActions(sourceOf(), tick, greet));
    const [, second] = await sessions.all();
    second?.setText("words", "good day");
    const session = await sessions.enter({ action: greet.requestSchema.link }, "first");
    expect(session).toBe(second);
    expect(session?.textOf("words")).toBe("good day");
  });

  it("sets the field that the place fills in to its link, over what was typed for it, and keeps the others", async () => {
    const sessions = new ActionSessions(sourceWithActions(sourceOf(), greet, tick));
    const session = await sessions.enter({ action: place.action }, "first");
    session?.setText("to", other);
    session?.setText("words", "good day");
    await sessions.enter(place, "second");
    expect(["words", "to"].map((field) => session?.textOf(field))).toEqual(["good day", entry.link]);
  });

  it("sets the field once for an entry of the history, and again for another entry", async () => {
    const sessions = new ActionSessions(sourceWithActions(sourceOf(), greet, tick));
    const session = await sessions.enter(place, "first");
    session?.setText("to", "");
    await sessions.enter(place, "first");
    expect(session?.textOf("to")).toBe("");
    session?.setText("to", other);
    await sessions.enter(place, "first");
    expect(session?.textOf("to")).toBe(other);
    await sessions.enter(place, "second");
    expect(session?.textOf("to")).toBe(entry.link);
  });

  it("sets the field for an entry that the actions were not read for the time before", async () => {
    const source = sourceWithActions(sourceOf(), greet);
    vi.spyOn(source, "actions").mockRejectedValueOnce(new Error("database is locked"));
    const sessions = new ActionSessions(source);
    await expect(sessions.enter(place, "first")).rejects.toThrow("database is locked");
    expect((await sessions.enter(place, "first"))?.textOf("to")).toBe(entry.link);
  });

  it("gives no session where the runtime lists no action that takes a request written to that schema", async () => {
    const sessions = new ActionSessions(sourceWithActions(sourceOf(), tick));
    expect(await sessions.enter(place, "first")).toBeUndefined();
    expect((await sessions.all()).map((session) => session.textOf("to"))).toEqual([""]);
  });
});

describe("the session of an action", () => {
  it("holds the text that was set for a field, and no text for the others", async () => {
    const session = await sessionOf(greet);
    session.setText("words", " good day ");
    expect(["words", "to"].map((field) => session.textOf(field))).toEqual([" good day ", ""]);
    expect(session.state()).toBeUndefined();
  });

  it("has the runtime perform the action on the texts, and holds the bytes of the result and the commits", async () => {
    const commits = [entry.link, other];
    const session = await sessionOf({
      ...greet,
      perform: async (request) => ({ ...(await greet.perform(request)), commits }),
    });
    session.setText("words", "hello");
    session.setText("to", entry.link);
    await session.perform();
    const result = encodeObject(greetingSchema, { text: "hello!", to: new LinkValue(entry.link) });
    expect(session.state()).toEqual({ kind: "performed", result: result.bytes, commits });
  });

  it("reads the page of a result that the source has since stopped giving blobs for", async () => {
    let isClosed = false;
    const source = sourceWithActions(sourceOf(), greet);
    const session = await sessionOver({
      ...source,
      async get(asked) {
        if (isClosed) throw new Error("database is locked");
        return source.get(asked);
      },
    });
    isClosed = true;
    const result = encodeObject(greetingSchema, { text: "hello!", to: new LinkValue(entry.link) });
    expect(await session.readPageOf(result.bytes)).toMatchObject({
      inspection: { kind: "object", link: result.link, schema: { kind: "schema", problems: [] } },
    });
  });

  it("reads the first of the objects held that are written to a schema, and how many there are", async () => {
    const objects = Array.from({ length: 12 }, (_, count) => encodeObject(entrySchema, { name: "one", count }).link);
    const pairs = objects.map((object) => [entrySchema.link, object] as const);
    const session = await sessionOver(
      sourceWithActions(sourceWithLinks(sourceOf(), { objects: [[greetingSchema.link, other], ...pairs] }), greet),
    );
    expect(await session.readObjectsOf(entrySchema.link)).toMatchObject({ links: objects.slice(0, 10), linkCount: 12 });
    expect(await session.readObjectsOf(greetingSchema.link)).toMatchObject({ links: [other], linkCount: 1 });
    expect(await session.readObjectsOf(tick.requestSchema.link)).toMatchObject({ links: [], linkCount: 0 });
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

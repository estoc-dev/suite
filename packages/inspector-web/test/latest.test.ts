import { describe, expect, it } from "vitest";
import { latestOnly } from "../src/latest.ts";

function task(): { readonly promise: Promise<string>; readonly end: (value: string) => void } {
  let end: (value: string) => void = () => {};
  const promise = new Promise<string>((resolve) => {
    end = resolve;
  });
  return { promise, end };
}

describe("the tasks given to latestOnly", () => {
  it("show what the one taken last comes to, when an earlier one ends after it", async () => {
    const shownValues: string[] = [];
    const show = latestOnly<string>((value) => shownValues.push(value));
    const first = task();
    const last = task();
    const tasks = [show(first.promise), show(last.promise)];
    last.end("the file chosen last");
    first.end("the file chosen first");
    await Promise.all(tasks);
    expect(shownValues).toEqual(["the file chosen last"]);
  });

  it("show nothing of an earlier one that ends before the last", async () => {
    const shownValues: string[] = [];
    const show = latestOnly<string>((value) => shownValues.push(value));
    const first = task();
    const last = task();
    const tasks = [show(first.promise), show(last.promise)];
    first.end("the file chosen first");
    await tasks[0];
    expect(shownValues).toEqual([]);
    last.end("the file chosen last");
    await Promise.all(tasks);
    expect(shownValues).toEqual(["the file chosen last"]);
  });

  it("show each in turn when one ends before the next is taken", async () => {
    const shownValues: string[] = [];
    const show = latestOnly<string>((value) => shownValues.push(value));
    await show(Promise.resolve("the file chosen first"));
    await show(Promise.resolve("the file chosen last"));
    expect(shownValues).toEqual(["the file chosen first", "the file chosen last"]);
  });
});

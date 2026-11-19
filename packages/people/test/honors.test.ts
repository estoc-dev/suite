import { ed25519, eip191 } from "@estoc/identity";
import { encodeObject, type Link } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import type { Arrivals } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { identityVersionInHand, peopleHavingSeen, publish, signatures, signer } from "./fixtures.ts";

const note = schema("Note", { text: string() });
const hello = encodeObject(note, { text: "hello" });

describe("a signature by an agent, as identity versions follow one another", () => {
  const [wallet, laptop, phone] = [signer(eip191), signer(ed25519, 2), signer(ed25519, 3)];

  it("is honored when the latest identity version the reader has seen lists its agent, whichever identity version it carries", async () => {
    const first = await publish(wallet, { agents: [laptop.key], at: 1_000 });
    const second = await publish(wallet, { prior: first, agents: [phone.key, laptop.key], at: 2_000 });
    const signature = await signatures.actor(laptop, first, identityVersionInHand).sign(hello);
    expect(await peopleHavingSeen(second).honors(signature)).toBe(true);
  });

  it("is not honored when the latest identity version the reader has seen no longer lists its agent", async () => {
    const first = await publish(wallet, { agents: [laptop.key, phone.key], at: 1_000 });
    const second = await publish(wallet, { prior: first, agents: [phone.key], at: 2_000 });
    const signature = await signatures.actor(laptop, first, identityVersionInHand).sign(hello);
    expect(await peopleHavingSeen(second).honors(signature)).toBe(false);
  });

  it("is not honored when the latest identity version the reader has seen lists no agents", async () => {
    const earlier = await publish(wallet, { agents: [laptop.key], at: 1_000 });
    const later = await publish(wallet, { prior: earlier, at: 2_000 });
    const signature = await signatures.actor(laptop, earlier, identityVersionInHand).sign(hello);
    expect(await peopleHavingSeen(later).honors(signature)).toBe(false);
  });

  it("is honored by the identity version it carries when that is later than any the reader has seen", async () => {
    const first = await publish(wallet, { agents: [laptop.key], at: 1_000 });
    const second = await publish(wallet, { prior: first, agents: [laptop.key, phone.key], at: 2_000 });
    const signature = await signatures.actor(phone, second, identityVersionInHand).sign(hello);
    expect(await peopleHavingSeen(first).honors(signature)).toBe(true);
  });

  it("is honored, against an identity version at the same at that drops its agent, when the one that lists it has the greater link", async () => {
    const first = await publish(wallet, { at: 500 });
    const listing = await publish(wallet, { prior: first, agents: [laptop.key, phone.key], at: 1_000 });
    const dropping = await publish(wallet, { prior: first, agents: [phone.key], at: 1_000 });
    const signature = await signatures.actor(laptop, listing, identityVersionInHand).sign(hello);
    expect(await peopleHavingSeen(dropping).honors(signature)).toBe(listing.link > dropping.link);
  });

  it("is honored by the identity version it carries when the reader has seen no identity versions", async () => {
    const first = await publish(wallet, { agents: [laptop.key], at: 1_000 });
    await publish(wallet, { prior: first, agents: [phone.key], at: 2_000 });
    const signature = await signatures.actor(laptop, first, identityVersionInHand).sign(hello);
    expect(await peopleHavingSeen().honors(signature)).toBe(true);
  });
});

describe("a signature as of when it came to the reader's devices", () => {
  const [wallet, laptop, phone] = [signer(eip191), signer(ed25519, 2), signer(ed25519, 3)];
  const chain = async () => {
    const first = await publish(wallet, { agents: [laptop.key, phone.key], at: 1_000 });
    const second = await publish(wallet, { prior: first, agents: [phone.key], at: 2_000 });
    return { first, second, signature: await signatures.actor(laptop, first, identityVersionInHand).sign(hello) };
  };
  const arrivalsOf = (...arrivals: readonly (readonly [{ readonly link: Link<unknown> }, number])[]): Arrivals => {
    const times = new Map(arrivals.map(([{ link }, at]) => [link, at]));
    return { atOf: async (link) => times.get(link) };
  };

  it("is honored when it came before an identity version that takes its key out", async () => {
    const { first, second, signature } = await chain();
    const people = peopleHavingSeen(second);
    const arrivals = arrivalsOf([first, 1], [signature, 5], [second, 9]);
    expect(await people.asOfArrival(arrivals).honors(signature)).toBe(true);
    expect(await people.honors(signature)).toBe(false);
  });

  it("is not honored when it came after, though the identity version it carries lists its key", async () => {
    const { first, second, signature } = await chain();
    const arrivals = arrivalsOf([first, 1], [second, 5], [signature, 9]);
    expect(await peopleHavingSeen(second).asOfArrival(arrivals).honors(signature)).toBe(false);
  });

  it("is not honored when it came at the same time as that identity version", async () => {
    const { first, second, signature } = await chain();
    const arrivals = arrivalsOf([first, 1], [second, 5], [signature, 5]);
    expect(await peopleHavingSeen(second).asOfArrival(arrivals).honors(signature)).toBe(false);
  });

  it("is not honored when nothing says when that identity version came", async () => {
    const { first, second, signature } = await chain();
    const arrivals = arrivalsOf([first, 1], [signature, 5]);
    expect(await peopleHavingSeen(second).asOfArrival(arrivals).honors(signature)).toBe(false);
  });

  it("is cut by a crisis that came after it", async () => {
    const { first, signature } = await chain();
    const crisis = await publish(wallet, { prior: first, agents: [laptop.key], isCrisis: true, at: 2_000 });
    const byCrisis = await signatures.actor(laptop, crisis, identityVersionInHand).sign(hello);
    const peopleAsOfArrival = peopleHavingSeen(crisis).asOfArrival(
      arrivalsOf([first, 1], [signature, 5], [crisis, 9], [byCrisis, 9]),
    );
    expect(await peopleAsOfArrival.honors(signature)).toBe(false);
    expect(await peopleAsOfArrival.honors(byCrisis)).toBe(true);
  });

  it("is honored as one that comes in now when nothing says when it came", async () => {
    const { first, second, signature } = await chain();
    const peopleAsOfArrival = peopleHavingSeen(second).asOfArrival(arrivalsOf([first, 1], [second, 9]));
    expect(await peopleAsOfArrival.honors(signature)).toBe(false);
    expect(
      await peopleAsOfArrival.honors(await signatures.actor(phone, first, identityVersionInHand).sign(hello)),
    ).toBe(true);
  });
});

describe("a signature by a root", () => {
  const [wallet, laptop] = [signer(eip191), signer(ed25519, 2)];

  it("is honored whichever agents the latest identity version the reader has seen lists", async () => {
    const published = await publish(wallet, { at: 1_000 });
    const later = await publish(wallet, { prior: published, agents: [laptop.key], at: 2_000 });
    const signature = await signatures.actor(wallet, published, identityVersionInHand).sign(hello);
    expect(await peopleHavingSeen(later).honors(signature)).toBe(true);
  });
});

describe("a signature by an identity version before a crisis", () => {
  const [wallet, laptop] = [signer(eip191), signer(ed25519, 2)];
  const chain = async () => {
    const first = await publish(wallet, { agents: [laptop.key], at: 1_000 });
    const crisis = await publish(wallet, { prior: first, agents: [laptop.key], isCrisis: true, at: 2_000 });
    const after = await publish(wallet, { prior: crisis, agents: [laptop.key], at: 3_000 });
    return { first, crisis, after };
  };

  it.each([
    ["an agent the crisis lists again", laptop],
    ["the root", wallet],
  ])("by %s is not honored once the reader has seen the crisis", async (_, by) => {
    const { first, crisis } = await chain();
    const signature = await signatures.actor(by, first, identityVersionInHand).sign(hello);
    expect(await peopleHavingSeen(crisis).honors(signature)).toBe(false);
  });

  it("is not honored by a reader that has seen only an identity version that follows the crisis", async () => {
    const { first, after } = await chain();
    const people = peopleHavingSeen(after);
    expect(await people.honors(await signatures.actor(wallet, first, identityVersionInHand).sign(hello))).toBe(false);
    expect(await people.honors(await signatures.actor(laptop, first, identityVersionInHand).sign(hello))).toBe(false);
  });

  it("is not honored once the signature of an identity version that follows the crisis carries it to the reader", async () => {
    const { first, after } = await chain();
    const reading = peopleHavingSeen(first);
    expect(await reading.honors(await signatures.actor(laptop, after, identityVersionInHand).sign(hello))).toBe(true);
    expect(await reading.honors(await signatures.actor(laptop, first, identityVersionInHand).sign(hello))).toBe(true);
    const seeing = peopleHavingSeen(first, after);
    expect(await seeing.honors(await signatures.actor(laptop, first, identityVersionInHand).sign(hello))).toBe(false);
  });

  it("is honored by the identity version it carries when the reader has seen no identity versions", async () => {
    const { first } = await chain();
    const signature = await signatures.actor(laptop, first, identityVersionInHand).sign(hello);
    expect(await peopleHavingSeen().honors(signature)).toBe(true);
  });

  it("is not honored once the reader has seen a later crisis that follows it", async () => {
    const { crisis } = await chain();
    const later = await publish(wallet, { prior: crisis, agents: [laptop.key], isCrisis: true, at: 4_000 });
    const people = peopleHavingSeen(later);
    expect(await people.honors(await signatures.actor(laptop, crisis, identityVersionInHand).sign(hello))).toBe(false);
    expect(await people.honors(await signatures.actor(laptop, later, identityVersionInHand).sign(hello))).toBe(true);
  });
});

describe("a signature by the crisis or an identity version that follows it", () => {
  it("is honored, by the root and by an agent", async () => {
    const [wallet, laptop] = [signer(eip191), signer(ed25519, 2)];
    const first = await publish(wallet, { agents: [laptop.key], at: 1_000 });
    const crisis = await publish(wallet, { prior: first, isCrisis: true, at: 2_000 });
    const after = await publish(wallet, { prior: crisis, agents: [laptop.key], at: 3_000 });
    const people = peopleHavingSeen(after);
    expect(await people.honors(await signatures.actor(wallet, crisis, identityVersionInHand).sign(hello))).toBe(true);
    expect(await people.honors(await signatures.actor(laptop, after, identityVersionInHand).sign(hello))).toBe(true);
  });
});

describe("a signature on a branch that does not follow the crisis", () => {
  const [wallet, laptop] = [signer(eip191), signer(ed25519, 2)];

  it("is not honored once the reader has seen the crisis, though the branch is later", async () => {
    const first = await publish(wallet, { at: 1_000 });
    const crisis = await publish(wallet, { prior: first, isCrisis: true, at: 2_000 });
    const branch = await publish(wallet, { prior: first, agents: [laptop.key], at: 3_000 });
    const people = peopleHavingSeen(crisis, branch);
    expect(await people.honors(await signatures.actor(laptop, branch, identityVersionInHand).sign(hello))).toBe(false);
    expect(await people.honors(await signatures.actor(wallet, branch, identityVersionInHand).sign(hello))).toBe(false);
    expect(
      await peopleHavingSeen(branch).honors(await signatures.actor(laptop, branch, identityVersionInHand).sign(hello)),
    ).toBe(true);
  });

  it("with a crisis of its own is honored over an earlier crisis on another branch", async () => {
    const first = await publish(wallet, { at: 1_000 });
    const crisis = await publish(wallet, { prior: first, isCrisis: true, at: 2_000 });
    const branch = await publish(wallet, { prior: first, agents: [laptop.key], isCrisis: true, at: 3_000 });
    const people = peopleHavingSeen(crisis, branch);
    expect(await people.honors(await signatures.actor(laptop, branch, identityVersionInHand).sign(hello))).toBe(true);
    expect(await people.honors(await signatures.actor(wallet, crisis, identityVersionInHand).sign(hello))).toBe(false);
  });
});

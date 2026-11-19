import { encodeObject, type Link, LinkValue, linkOf, readObject } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { bodies, markdownBodyOf, markdownBodySchema, postSchema } from "../src/index.ts";

const byLink = (blobs: readonly Uint8Array[]) =>
  new Map<Link<unknown>, Uint8Array>(blobs.map((bytes) => [linkOf(bytes), bytes]));

async function htmlOf(text: string): Promise<string> {
  const { link, bytes } = markdownBodyOf(text);
  return (await bodies.read(link, byLink([bytes]))).html;
}

describe("a post", () => {
  it("links to its body, which is read by the schema the body names", async () => {
    const body = markdownBodyOf("Most of our online identities depend on platforms.\n");
    const post = encodeObject(postSchema, {
      title: "Imagining the internet from offline",
      date: "2026-10-20",
      body: new LinkValue(body.link),
    });
    const reader = byLink([post.bytes, body.bytes]);

    const { data } = await readObject(reader, post.link, postSchema);
    const readBody = await bodies.read(data.body.link, reader);
    expect(readBody).toEqual({
      link: body.link,
      html: "<p>Most of our online identities depend on platforms.</p>\n",
    });
  });
});

describe("a Markdown body", () => {
  it("is an object of the Markdown body schema that holds its text", () => {
    const body = markdownBodyOf("## Identity\n");
    expect(body.schema.link).toBe(markdownBodySchema.link);
    expect(body.data).toEqual({ text: "## Identity\n" });
  });

  it("reads as headings, lists, links and code in HTML", async () => {
    expect(await htmlOf("## Identity\n\n- `sign` is the [holder](https://estoc.dev)'s.\n")).toBe(
      '<h2>Identity</h2>\n<ul>\n<li><code>sign</code> is the <a href="https://estoc.dev">holder</a>\'s.</li>\n</ul>\n',
    );
    expect(await htmlOf("```ts\nconst a = 1 < 2;\n```\n")).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2;\n</code></pre>\n',
    );
  });

  it("reads HTML written in its text as text", async () => {
    expect(await htmlOf("<script>alert(1)</script>\n")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;\n");
  });
});

describe("a body written to a schema that is not listed", () => {
  it("is refused", async () => {
    const { link, bytes } = encodeObject(schema("Plain Body", { text: string() }), { text: "plain" });
    await expect(bodies.read(link as Link<never>, byLink([bytes]))).rejects.toThrow("is not a schema read here");
  });
});

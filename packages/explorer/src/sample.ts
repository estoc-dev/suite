import { markdownBodyOf, postSchema } from "@estoc/blog";
import { ed25519, identityKit, SoftwareSigner } from "@estoc/identity";
import { encodeObject, LinkValue, linkOf } from "@estoc/object";
import { link, schema, string } from "@estoc/schema";
import { Store, writtenObjectsOf } from "@estoc/store";
import { SqliteBackend } from "@estoc/store/sqlite";

const photoSchema = schema("Photo", { caption: string(), image: link() });

const DAY = 24 * 60 * 60 * 1000;
const firstDay = Date.UTC(2026, 0, 1);

const [database, ...rest] = process.argv.slice(2);
if (database === undefined || rest.length > 0) {
  console.error("Usage: sample.ts <database>");
  process.exitCode = 1;
} else {
  const backend = new SqliteBackend(database);
  try {
    await writeSample(new Store(backend));
  } finally {
    backend.close();
  }
}

/** Every blob and time is the same each run, so writing the sample to a store that holds it adds nothing. */
async function writeSample(store: Store): Promise<void> {
  for (let day = 0; day < 120; day++) {
    const at = firstDay + day * DAY;
    const body = markdownBodyOf(`Written on day ${day + 1}.\n\n- one\n- two`);
    const post = encodeObject(postSchema, {
      title: `Post ${day + 1}`,
      date: new Date(at).toISOString().slice(0, 10),
      body: new LinkValue(body.link),
    });
    await store.write({
      roots: [post.link],
      blobs: [post.bytes, body.bytes, ...postSchema.blobs, ...body.schema.blobs],
    });
    await store.record(writtenObjectsOf([post.link], at));
  }
  const image = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>',
  );
  const photo = encodeObject(photoSchema, { caption: "A circle", image: new LinkValue(linkOf(image)) });
  await store.write({ roots: [photo.link], blobs: [photo.bytes, image, ...photoSchema.blobs] });
  await store.record(writtenObjectsOf([photo.link], firstDay + 120 * DAY));

  const { publish, signatures } = identityKit;
  const root = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
  const agent = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(2));
  const signedIdentity = await publish(root, { agents: [agent.key], at: firstDay });
  const signature = await signatures.actor(agent, signedIdentity, async (inHand) => inHand).sign(photo);
  await store.write({ roots: [signature.link], blobs: signature.blobs });
  await store.record(writtenObjectsOf([signature.link], firstDay + 121 * DAY));
}

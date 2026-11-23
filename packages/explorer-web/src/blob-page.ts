import { type Inspection, inspect } from "@estoc/inspector";
import type { Link, Reader } from "@estoc/object";
import { bodyReading } from "./body-reading.tsx";
import { type Reading, type ReadingAs, readingOf } from "./reading.ts";
import { signatureReading } from "./signature-reading.tsx";

const readings: readonly ReadingAs<unknown>[] = [bodyReading, signatureReading];

export interface BlobPage {
  readonly inspection: Inspection;
  readonly reading: Reading | undefined;
}

export async function readBlobPage(reader: Reader, link: Link<unknown>): Promise<BlobPage> {
  const inspection = await inspect(link, reader);
  return {
    inspection,
    reading: inspection.kind === "object" ? await readingOf(inspection, reader, readings) : undefined,
  };
}

import { bodyReading } from "./body-reading.ts";
import type { ReadingAs } from "./reading.ts";
import { signatureReading } from "./signature-reading.ts";

/** What the page reads objects as. */
export const readings: readonly ReadingAs<unknown>[] = [bodyReading, signatureReading];

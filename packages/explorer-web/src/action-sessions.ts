import type { LinkPage } from "@estoc/explorer";
import type { Link, Schema } from "@estoc/object";
import { createSignal } from "solid-js";
import { type ActionForm, type ActionSource, readActionForms, readResultPage, requestOf } from "./action-page.ts";
import type { BlobPage } from "./blob-page.ts";
import { shownLinkLimit } from "./link-page.ts";
import type { ActionPlace } from "./place.ts";

export type ActionState =
  | { readonly kind: "performing" }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "performed"; readonly result: Uint8Array; readonly commits: readonly Link<unknown>[] };

/**
 * The runtime gives a reply once and keeps none for the page, so leaving the page of an action for
 * a blob that its result links to would otherwise lose the result.
 */
export class ActionSession {
  readonly form: ActionForm;
  readonly #source: ActionSource;
  // A signal gives what it held before a write until the writes are flushed, and what performs
  // right after a text is set reads that text. So the texts are held here, and the signal only
  // tells what shows them that one was set.
  readonly #texts = new Map<string, string>();
  readonly #trackTexts;
  readonly #notifyOfTexts;
  readonly #state;
  readonly #setState;

  constructor(source: ActionSource, form: ActionForm) {
    this.#source = source;
    this.form = form;
    [this.#trackTexts, this.#notifyOfTexts] = createSignal<undefined>(undefined, { equals: false });
    [this.#state, this.#setState] = createSignal<ActionState | undefined>(undefined);
  }

  textOf(field: string): string {
    this.#trackTexts();
    return this.#texts.get(field) ?? "";
  }

  setText(field: string, text: string): void {
    this.#texts.set(field, text);
    this.#notifyOfTexts(undefined);
  }

  state(): ActionState | undefined {
    return this.#state();
  }

  async perform(): Promise<void> {
    this.#setState({ kind: "performing" });
    try {
      const { result, commits } = await this.#source.perform(requestOf(this.form, this.#texts));
      this.#setState({ kind: "performed", result, commits });
    } catch (error) {
      this.#setState({ kind: "failed", error });
    }
  }

  readPageOf(result: Uint8Array): Promise<BlobPage> {
    return readResultPage(this.#source, this.form, result);
  }

  /** The first of the objects held that are written to `schema`, with how many there are. */
  readObjectsOf(schema: Link<Schema>): Promise<LinkPage> {
    return this.#source.objectsOf(schema, 0, shownLinkLimit);
  }
}

/** A runtime lists the same actions for as long as it runs, so the page reads their forms once. */
export class ActionSessions {
  readonly #source: ActionSource;
  #sessions: Promise<readonly ActionSession[]> | undefined;

  constructor(source: ActionSource) {
    this.#source = source;
  }

  all(): Promise<readonly ActionSession[]> {
    this.#sessions ??= readActionForms(this.#source).then(
      (forms) => forms.map((form) => new ActionSession(this.#source, form)),
      (error) => {
        this.#sessions = undefined;
        throw error;
      },
    );
    return this.#sessions;
  }

  /** Sets the field that `place` fills in, and gives the session of its action where the runtime lists one. */
  async enter({ action, filledField }: ActionPlace): Promise<ActionSession | undefined> {
    const session = (await this.all()).find(({ form }) => form.request.link === action);
    if (filledField !== undefined) session?.setText(filledField.name, filledField.link);
    return session;
  }
}

import type { Schema, ValueMap } from "@estoc/object";
import { type Action, type ActionOutcome, perform, type Store } from "@estoc/store";

/**
 * An action with the environment it is performed in, which takes as a request the data of an
 * object that was read with no schema in hand. It is bound to no store: whoever performs it says
 * on which.
 */
export interface ListedAction {
  readonly requestSchema: Schema;
  readonly resultSchema: Schema;
  readonly targetSchemas: { readonly [field: string]: Schema | undefined };
  perform(store: Store, request: ValueMap): Promise<ActionOutcome<ValueMap>>;
}

export function listedAction<Q extends ValueMap, R extends ValueMap, E extends object>(
  action: Action<Q, R, E>,
  environment: E,
): ListedAction {
  return {
    requestSchema: action.requestSchema,
    resultSchema: action.resultSchema,
    targetSchemas: action.targetSchemas,
    perform: (store, request) => perform(store, action, action.requestSchema.validate(request), environment),
  };
}

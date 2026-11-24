import { decodeObject, type Schema, type ValueMap } from "@estoc/object";
import { type Action, type ActionOutcome, perform, type Store } from "@estoc/store";

/**
 * An action with the environment it is performed in, which takes a request as the bytes that cross
 * a channel. It is bound to no store: whoever performs it says on which.
 */
export interface ListedAction {
  readonly requestSchema: Schema;
  readonly resultSchema: Schema;
  readonly targetSchemas: { readonly [field: string]: Schema | undefined };
  perform(store: Store, request: Uint8Array): Promise<ActionOutcome<ValueMap>>;
}

export function listedAction<Q extends ValueMap, R extends ValueMap, E extends object>(
  action: Action<Q, R, E>,
  environment: E,
): ListedAction {
  return {
    requestSchema: action.requestSchema,
    resultSchema: action.resultSchema,
    targetSchemas: action.targetSchemas,
    perform: (store, request) => perform(store, action, decodeObject(request, action.requestSchema).data, environment),
  };
}

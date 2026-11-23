/**
 * One end of a line between a page and the runtime that holds the store. Each message sent comes out
 * whole at the other end, in the order sent. Both ends are inside the boundary of the user, so
 * nothing that crosses is kept from either.
 */
export interface Channel {
  /** The channel may send `message` after this returns, so its bytes are left as they are. */
  send(message: Uint8Array<ArrayBuffer>): void;
  /**
   * Takes the messages that come from then on. A channel has one receiver. `onClose` is called
   * once, when either end closes.
   */
  receive(onMessage: (message: Uint8Array) => void, onClose: () => void): void;
  close(): void;
}

/**
 * A browser gives a port no event when either end closes, so the end that closes sends `null`
 * first, which is not a message. An end that is ended without closing, as by terminating its
 * worker, sends nothing: whoever ends it closes the other end too.
 */
export function portChannel(port: MessagePort): Channel {
  let isClosed = false;
  let notifyReceiver = () => {};
  function finish() {
    if (isClosed) return;
    isClosed = true;
    port.close();
    notifyReceiver();
  }
  return {
    send: (message) => port.postMessage(message),
    receive(onMessage, onClose) {
      notifyReceiver = onClose;
      port.addEventListener("message", ({ data }) => (data === null ? finish() : onMessage(data as Uint8Array)));
      port.start();
    },
    close() {
      if (!isClosed) port.postMessage(null);
      finish();
    },
  };
}

/** What a `WebSocket` of a browser and one of `ws` both are. */
interface Socket {
  binaryType: string;
  readonly readyState: number;
  readonly CONNECTING: number;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
  addEventListener(type: "open" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
}

export function socketChannel(socket: Socket): Channel {
  socket.binaryType = "arraybuffer";
  // A socket of `ws` throws an error that no one listens for. It closes next, which the receiver is told.
  socket.addEventListener("error", () => {});
  // What is given before the socket opens, until it is sent. The socket is not asked at each `send`
  // whether it is open: it is before these are sent, and a message sent in between would come out
  // ahead of them.
  let waitingMessages: Uint8Array<ArrayBuffer>[] | undefined = socket.readyState === socket.CONNECTING ? [] : undefined;
  socket.addEventListener("open", () => {
    for (const message of waitingMessages ?? []) socket.send(message);
    waitingMessages = undefined;
  });
  return {
    send(message) {
      if (waitingMessages === undefined) socket.send(message);
      else waitingMessages.push(message);
    },
    receive(onMessage, onClose) {
      socket.addEventListener("message", ({ data }) => onMessage(new Uint8Array(data as ArrayBuffer)));
      socket.addEventListener("close", onClose);
    },
    close: () => socket.close(),
  };
}

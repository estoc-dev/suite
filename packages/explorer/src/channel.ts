/**
 * One end of a line between a page and the runtime that holds the store. Each message sent comes out
 * whole at the other end, in the order sent. Both ends are inside the boundary of the user, so
 * nothing that crosses is kept from either.
 */
export interface Channel {
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
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
}

/** `socket` is open. */
export function socketChannel(socket: Socket): Channel {
  socket.binaryType = "arraybuffer";
  return {
    send: (message) => socket.send(message),
    receive(onMessage, onClose) {
      socket.addEventListener("message", ({ data }) => onMessage(new Uint8Array(data as ArrayBuffer)));
      socket.addEventListener("close", onClose);
    },
    close: () => socket.close(),
  };
}

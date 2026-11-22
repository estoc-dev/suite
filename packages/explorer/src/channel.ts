/**
 * One end of a line between a page and the runtime that holds the store. Each message sent comes out
 * whole at the other end, in the order sent. Both ends are inside the boundary of the user, so
 * nothing that crosses is kept from either.
 */
export interface Channel {
  send(message: Uint8Array): void;
  /** Takes the messages that come from then on. A channel has one receiver. */
  receive(onMessage: (message: Uint8Array) => void, onClose: () => void): void;
  close(): void;
}

export function portChannel(port: MessagePort): Channel {
  return {
    send: (message) => port.postMessage(message),
    receive(onMessage, onClose) {
      port.addEventListener("message", ({ data }) => onMessage(data as Uint8Array));
      port.addEventListener("close", onClose);
      port.start();
    },
    close: () => port.close(),
  };
}

/** What a `WebSocket` of a browser and one of `ws` both are. */
interface Socket {
  binaryType: string;
  send(data: Uint8Array): void;
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

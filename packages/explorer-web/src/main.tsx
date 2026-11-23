import { Client, socketChannel } from "@estoc/explorer";
import { render } from "@solidjs/web";
import { App } from "./app.tsx";

const socket = new WebSocket(`${location.origin.replace("http", "ws")}/channel`);
// Made here and not in the markup, where a property is read anew each time it is used.
const client = new Client(socketChannel(socket));
// The page does not wait for the socket to open: a navigation made before that is its to show too.
render(() => <App source={client} />, document.querySelector("#app") as HTMLElement);
// A socket that does not open closes too, and after either every call fails.
socket.addEventListener("close", () => document.querySelector("#closed")?.removeAttribute("hidden"));

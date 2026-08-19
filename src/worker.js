import { Room } from "./room.js";
export { Room };

// Single global session: every visitor lands in the same room.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected a WebSocket upgrade", { status: 426 });
      }
      return env.ROOM.get(env.ROOM.idFromName("main")).fetch(request);
    }

    if (url.pathname === "/results") {
      return Response.redirect(new URL("/screen", url).toString(), 302);
    }

    return env.ASSETS.fetch(request);
  },
};

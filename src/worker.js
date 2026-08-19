import { Room } from "./room.js";
export { Room };

// No ambiguous characters (0/O, 1/I/L) so codes are easy to read off a screen.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function makeCode(len = 4) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = makeCode();
        const stub = env.ROOM.get(env.ROOM.idFromName(code));
        const res = await stub.fetch("https://room/init", { method: "POST" });
        if (res.ok) {
          const { presenterKey } = await res.json();
          return Response.json({ code, presenterKey });
        }
      }
      return Response.json({ error: "could not allocate a room code" }, { status: 500 });
    }

    let m = url.pathname.match(/^\/api\/rooms\/([a-z0-9]{4,8})$/i);
    if (m && request.method === "GET") {
      const stub = env.ROOM.get(env.ROOM.idFromName(m[1].toUpperCase()));
      return stub.fetch("https://room/exists");
    }

    m = url.pathname.match(/^\/ws\/([a-z0-9]{4,8})$/i);
    if (m) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected a WebSocket upgrade", { status: 426 });
      }
      const stub = env.ROOM.get(env.ROOM.idFromName(m[1].toUpperCase()));
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

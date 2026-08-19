// The single session room. Holds a deck of questions (multiple-choice or
// open text) and broadcasts state to every connected WebSocket.
// Uses the hibernation API so the idle room costs nothing.

const MAX_QUESTIONS = 50;
const MAX_OPTIONS = 8;
const MAX_ANSWERS_PER_QUESTION = 500;
const MAX_ANSWERS_PER_PERSON = 3;

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const url = new URL(request.url);
      const key = url.searchParams.get("key");
      const role = key && this.env.ADMIN_KEY && key === this.env.ADMIN_KEY ? "presenter" : "audience";
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [role]);
      const deck = await this.getDeck();
      pair[1].send(JSON.stringify(this.snapshotFor(role, deck)));
      await this.broadcast(deck, pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("not found", { status: 404 });
  }

  async getDeck() {
    return (await this.ctx.storage.get("deck")) ?? { questions: [] };
  }

  snapshotFor(role, deck) {
    const participants = this.ctx.getWebSockets().length;
    return { type: "state", role, participants, questions: deck.questions };
  }

  async broadcast(deck, skip = null) {
    const forPresenter = JSON.stringify(this.snapshotFor("presenter", deck));
    const forAudience = JSON.stringify(this.snapshotFor("audience", deck));
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === skip) continue;
      const msg = this.ctx.getTags(ws).includes("presenter") ? forPresenter : forAudience;
      try { ws.send(msg); } catch {}
    }
  }

  async save(deck) {
    await this.ctx.storage.put("deck", deck);
    await this.broadcast(deck);
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const isPresenter = this.ctx.getTags(ws).includes("presenter");
    const deck = await this.getDeck();
    const find = (id) => deck.questions.find((q) => q.id === id);

    if (isPresenter) {
      if (msg.type === "add_question") {
        if (deck.questions.length >= MAX_QUESTIONS) return;
        const prompt = String(msg.prompt ?? "").trim().slice(0, 240);
        if (!prompt) return;
        const qtype = msg.qtype === "choice" ? "choice" : "text";
        const q = { id: crypto.randomUUID(), type: qtype, prompt, open: true };
        if (qtype === "choice") {
          const options = (Array.isArray(msg.options) ? msg.options : [])
            .map((o) => String(o).trim().slice(0, 100))
            .filter(Boolean)
            .slice(0, MAX_OPTIONS);
          if (options.length < 2) return;
          q.options = options;
          q.votes = options.map(() => 0);
        } else {
          q.answers = [];
        }
        deck.questions.push(q);
        return this.save(deck);
      }
      if (msg.type === "close" || msg.type === "reopen") {
        const q = find(msg.id);
        if (!q) return;
        q.open = msg.type === "reopen";
        return this.save(deck);
      }
      if (msg.type === "remove_question") {
        const i = deck.questions.findIndex((q) => q.id === msg.id);
        if (i === -1) return;
        deck.questions.splice(i, 1);
        return this.save(deck);
      }
      if (msg.type === "remove_answer") {
        const q = find(msg.qid);
        if (!q || q.type !== "text") return;
        q.answers = q.answers.filter((a) => a.id !== msg.aid);
        return this.save(deck);
      }
      if (msg.type === "remove_text") {
        // Removes every answer with this text (the cloud groups duplicates).
        const q = find(msg.qid);
        if (!q || q.type !== "text") return;
        const norm = String(msg.text ?? "").trim().toLowerCase();
        if (!norm) return;
        q.answers = q.answers.filter((a) => a.text.trim().toLowerCase() !== norm);
        return this.save(deck);
      }
    }

    if (msg.type === "vote") {
      const q = find(msg.qid);
      const choice = Number(msg.option);
      if (!q || q.type !== "choice" || !q.open) return;
      if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return;
      // One vote per connection per question; voting again moves it.
      const att = ws.deserializeAttachment() ?? {};
      att.votes ??= {};
      const prev = att.votes[q.id];
      if (prev === choice) return;
      if (Number.isInteger(prev)) q.votes[prev] -= 1;
      q.votes[choice] += 1;
      att.votes[q.id] = choice;
      ws.serializeAttachment(att);
      return this.save(deck);
    }

    if (msg.type === "submit_text") {
      const q = find(msg.qid);
      if (!q || q.type !== "text" || !q.open) return;
      if (q.answers.length >= MAX_ANSWERS_PER_QUESTION) return;
      const text = String(msg.text ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
      if (!text) return;
      const att = ws.deserializeAttachment() ?? {};
      att.texts ??= {};
      const used = att.texts[q.id] ?? 0;
      if (used >= MAX_ANSWERS_PER_PERSON) return;
      q.answers.push({ id: crypto.randomUUID(), text });
      att.texts[q.id] = used + 1;
      ws.serializeAttachment(att);
      return this.save(deck);
    }
  }

  async webSocketClose() {
    await this.broadcast(await this.getDeck());
  }

  async webSocketError() {
    await this.broadcast(await this.getDeck());
  }

  // Old multi-room instances from earlier versions may still have pending
  // self-destruct alarms; let them clean themselves up.
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

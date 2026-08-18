import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type ChatMessageRow = {
  id: number;
  room_id: string;
  author_id: string;
  author_name: string;
  body: string;
  created_at: number;
};

type SignalRow = {
  id: number;
  room_id: string;
  sender_id: string;
  recipient_id: string | null;
  kind: string;
  payload: string;
  created_at: number;
};

type PresenceRow = {
  room_id: string;
  client_id: string;
  name: string;
  mic_on: number;
  camera_on: number;
  screen_on: number;
  last_seen: number;
};

type LocalStore = {
  nextMessageId: number;
  nextSignalId: number;
  messages: ChatMessageRow[];
  signals: SignalRow[];
  presences: PresenceRow[];
};

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const PRESENCE_TTL_MS = 6500;

const emptyStore = (): LocalStore => ({
  nextMessageId: 1,
  nextSignalId: 1,
  messages: [],
  signals: [],
  presences: [],
});

async function readLocalStore(): Promise<LocalStore> {
  const globalStore = globalThis as typeof globalThis & {
    __sharetalkStore?: LocalStore;
  };

  if (globalStore.__sharetalkStore) {
    return normalizeStore(globalStore.__sharetalkStore);
  }

  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const filePath =
    process.env.SHARETALK_DATA_FILE ??
    path.join(process.cwd(), ".data", "sharetalk-store.json");

  try {
    const raw = await fs.readFile(filePath, "utf8");
    globalStore.__sharetalkStore = normalizeStore(JSON.parse(raw) as LocalStore);
  } catch {
    globalStore.__sharetalkStore = emptyStore();
  }

  return globalStore.__sharetalkStore;
}

async function writeLocalStore(store: LocalStore) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const filePath =
    process.env.SHARETALK_DATA_FILE ??
    path.join(process.cwd(), ".data", "sharetalk-store.json");

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), "utf8");
}

function normalizeStore(store: LocalStore): LocalStore {
  store.presences ??= [];
  return store;
}

async function handleLocalMessages(request: Request) {
  const url = new URL(request.url);
  const store = await readLocalStore();

  if (request.method === "GET") {
    const roomId = cleanText(url.searchParams.get("roomId"), "sala-amigos", 120);
    const messages = store.messages
      .filter((message) => message.room_id === roomId)
      .sort((a, b) => a.created_at - b.created_at || a.id - b.id)
      .slice(-300)
      .map(toMessage);

    return json({ messages });
  }

  if (request.method === "POST") {
    const body = (await request.json()) as Record<string, unknown>;
    const roomId = cleanText(body.roomId, "sala-amigos", 120);
    const authorId = cleanText(body.authorId, "pessoa", 80);
    const authorName = cleanText(body.authorName, "Amigo", 48);
    const message = cleanText(body.body, "", 1500);

    if (!message) {
      return json({ error: "Mensagem vazia." }, 400);
    }

    const row: ChatMessageRow = {
      id: store.nextMessageId++,
      room_id: roomId,
      author_id: authorId,
      author_name: authorName,
      body: message,
      created_at: Date.now(),
    };

    store.messages.push(row);
    store.messages = store.messages.slice(-5000);
    await writeLocalStore(store);

    return json({ message: toMessage(row) }, 201);
  }

  return json({ error: "Metodo nao permitido." }, 405);
}

async function handleLocalSignals(request: Request) {
  const url = new URL(request.url);
  const store = await readLocalStore();

  if (request.method === "GET") {
    const roomId = cleanText(url.searchParams.get("roomId"), "sala-amigos", 120);
    if (url.searchParams.get("latest") === "1") {
      const lastId = store.signals
        .filter((signal) => signal.room_id === roomId)
        .reduce((max, signal) => Math.max(max, signal.id), 0);

      return json({ signals: [], lastId });
    }

    const after = Number(url.searchParams.get("after") ?? "0");
    const signals = store.signals
      .filter((signal) => signal.room_id === roomId && signal.id > (Number.isFinite(after) ? after : 0))
      .sort((a, b) => a.id - b.id)
      .slice(0, 200);

    return json({
      signals: signals.map(toSignal),
      lastId: signals.at(-1)?.id ?? after,
    });
  }

  if (request.method === "POST") {
    const body = (await request.json()) as Record<string, unknown>;
    const roomId = cleanText(body.roomId, "sala-amigos", 120);
    const senderId = cleanText(body.senderId, "pessoa", 80);
    const recipientId = typeof body.recipientId === "string" ? cleanText(body.recipientId, "", 80) : null;
    const kind = cleanText(body.kind, "", 24);

    if (!["join", "offer", "answer", "ice", "leave", "state"].includes(kind)) {
      return json({ error: "Sinal invalido." }, 400);
    }

    store.signals.push({
      id: store.nextSignalId++,
      room_id: roomId,
      sender_id: senderId,
      recipient_id: recipientId,
      kind,
      payload: JSON.stringify(body.payload ?? {}),
      created_at: Date.now(),
    });
    store.signals = store.signals.slice(-2000);
    await writeLocalStore(store);

    return json({ ok: true }, 201);
  }

  return json({ error: "Metodo nao permitido." }, 405);
}

function toPresence(row: PresenceRow) {
  return {
    roomId: row.room_id,
    clientId: row.client_id,
    name: row.name,
    micOn: Boolean(row.mic_on),
    cameraOn: Boolean(row.camera_on),
    screenOn: Boolean(row.screen_on),
    lastSeen: row.last_seen,
  };
}

async function handleLocalPresence(request: Request) {
  const url = new URL(request.url);
  const store = await readLocalStore();
  const now = Date.now();

  if (request.method === "GET") {
    const roomId = cleanText(url.searchParams.get("roomId"), "sala-amigos", 120);
    store.presences = store.presences.filter((presence) => now - presence.last_seen < PRESENCE_TTL_MS);
    await writeLocalStore(store);

    return json({
      participants: store.presences
        .filter((presence) => presence.room_id === roomId)
        .sort((a, b) => a.name.localeCompare(b.name) || a.client_id.localeCompare(b.client_id))
        .map(toPresence),
    });
  }

  if (request.method === "POST") {
    const body = (await request.json()) as Record<string, unknown>;
    const roomId = cleanText(body.roomId, "sala-amigos", 120);
    const clientId = cleanText(body.clientId, "pessoa", 80);
    const name = cleanText(body.name, "Amigo", 48);
    const nextPresence: PresenceRow = {
      room_id: roomId,
      client_id: clientId,
      name,
      mic_on: body.micOn === false ? 0 : 1,
      camera_on: body.cameraOn === true ? 1 : 0,
      screen_on: body.screenOn === true ? 1 : 0,
      last_seen: now,
    };

    store.presences = [
      ...store.presences.filter((presence) => !(presence.room_id === roomId && presence.client_id === clientId)),
      nextPresence,
    ].filter((presence) => now - presence.last_seen < PRESENCE_TTL_MS);
    await writeLocalStore(store);

    return json({ ok: true, participant: toPresence(nextPresence) }, 201);
  }

  if (request.method === "DELETE") {
    const body = (await request.json()) as Record<string, unknown>;
    const roomId = cleanText(body.roomId, "sala-amigos", 120);
    const clientId = cleanText(body.clientId, "pessoa", 80);
    store.presences = store.presences.filter((presence) => !(presence.room_id === roomId && presence.client_id === clientId));
    await writeLocalStore(store);

    return json({ ok: true });
  }

  return json({ error: "Metodo nao permitido." }, 405);
}

async function ensureSchema(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_room_created
      ON chat_messages(room_id, created_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS room_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      recipient_id TEXT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_room_signals_room_id
      ON room_signals(room_id, id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS voice_presence (
      room_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      name TEXT NOT NULL,
      mic_on INTEGER NOT NULL,
      camera_on INTEGER NOT NULL,
      screen_on INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (room_id, client_id)
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_voice_presence_room_seen
      ON voice_presence(room_id, last_seen)`),
  ]);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: jsonHeaders,
  });
}

function cleanText(value: unknown, fallback: string, maxLength: number) {
  if (typeof value !== "string") {
    return fallback;
  }

  const clean = value.trim().slice(0, maxLength);
  return clean || fallback;
}

function toMessage(row: ChatMessageRow) {
  return {
    id: row.id,
    roomId: row.room_id,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at,
  };
}

function toSignal(row: SignalRow) {
  return {
    id: row.id,
    roomId: row.room_id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    kind: row.kind,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

async function handleMessages(request: Request, env?: Env) {
  if (!env?.DB) {
    return handleLocalMessages(request);
  }

  await ensureSchema(env.DB);
  const url = new URL(request.url);

  if (request.method === "GET") {
    const roomId = cleanText(url.searchParams.get("roomId"), "sala-amigos", 80);
    const result = await env.DB.prepare(
      `SELECT id, room_id, author_id, author_name, body, created_at
       FROM chat_messages
       WHERE room_id = ?
       ORDER BY created_at ASC, id ASC
       LIMIT 300`,
    )
      .bind(roomId)
      .all<ChatMessageRow>();

    return json({ messages: (result.results ?? []).map(toMessage) });
  }

  if (request.method === "POST") {
    const body = (await request.json()) as Record<string, unknown>;
    const roomId = cleanText(body.roomId, "sala-amigos", 80);
    const authorId = cleanText(body.authorId, "pessoa", 80);
    const authorName = cleanText(body.authorName, "Amigo", 48);
    const message = cleanText(body.body, "", 1500);

    if (!message) {
      return json({ error: "Mensagem vazia." }, 400);
    }

    const createdAt = Date.now();
    const result = await env.DB.prepare(
      `INSERT INTO chat_messages (room_id, author_id, author_name, body, created_at)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id, room_id, author_id, author_name, body, created_at`,
    )
      .bind(roomId, authorId, authorName, message, createdAt)
      .first<ChatMessageRow>();

    return json({ message: toMessage(result as ChatMessageRow) }, 201);
  }

  return json({ error: "Metodo nao permitido." }, 405);
}

async function handleSignals(request: Request, env?: Env) {
  if (!env?.DB) {
    return handleLocalSignals(request);
  }

  await ensureSchema(env.DB);
  const url = new URL(request.url);

  if (request.method === "GET") {
    const roomId = cleanText(url.searchParams.get("roomId"), "sala-amigos", 80);
    if (url.searchParams.get("latest") === "1") {
      const result = await env.DB.prepare(
        `SELECT MAX(id) AS last_id
         FROM room_signals
         WHERE room_id = ?`,
      )
        .bind(roomId)
        .first<{ last_id: number | null }>();

      return json({ signals: [], lastId: result?.last_id ?? 0 });
    }

    const after = Number(url.searchParams.get("after") ?? "0");
    const result = await env.DB.prepare(
      `SELECT id, room_id, sender_id, recipient_id, kind, payload, created_at
       FROM room_signals
       WHERE room_id = ? AND id > ?
       ORDER BY id ASC
       LIMIT 200`,
    )
      .bind(roomId, Number.isFinite(after) ? after : 0)
      .all<SignalRow>();

    const rows = result.results ?? [];
    return json({
      signals: rows.map(toSignal),
      lastId: rows.at(-1)?.id ?? after,
    });
  }

  if (request.method === "POST") {
    const body = (await request.json()) as Record<string, unknown>;
    const roomId = cleanText(body.roomId, "sala-amigos", 80);
    const senderId = cleanText(body.senderId, "pessoa", 80);
    const recipientId = typeof body.recipientId === "string" ? cleanText(body.recipientId, "", 80) : null;
    const kind = cleanText(body.kind, "", 24);

    if (!["join", "offer", "answer", "ice", "leave", "state"].includes(kind)) {
      return json({ error: "Sinal invalido." }, 400);
    }

    await env.DB.prepare(
      `INSERT INTO room_signals (room_id, sender_id, recipient_id, kind, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(roomId, senderId, recipientId, kind, JSON.stringify(body.payload ?? {}), Date.now())
      .run();

    return json({ ok: true }, 201);
  }

  return json({ error: "Metodo nao permitido." }, 405);
}

async function handlePresence(request: Request, env?: Env) {
  if (!env?.DB) {
    return handleLocalPresence(request);
  }

  await ensureSchema(env.DB);
  const url = new URL(request.url);
  const now = Date.now();

  if (request.method === "GET") {
    const roomId = cleanText(url.searchParams.get("roomId"), "sala-amigos", 120);
    await env.DB.prepare(`DELETE FROM voice_presence WHERE last_seen < ?`).bind(now - PRESENCE_TTL_MS).run();
    const result = await env.DB.prepare(
      `SELECT room_id, client_id, name, mic_on, camera_on, screen_on, last_seen
       FROM voice_presence
       WHERE room_id = ?
       ORDER BY name ASC, client_id ASC`,
    )
      .bind(roomId)
      .all<PresenceRow>();

    return json({ participants: (result.results ?? []).map(toPresence) });
  }

  if (request.method === "POST") {
    const body = (await request.json()) as Record<string, unknown>;
    const roomId = cleanText(body.roomId, "sala-amigos", 120);
    const clientId = cleanText(body.clientId, "pessoa", 80);
    const name = cleanText(body.name, "Amigo", 48);
    const micOn = body.micOn === false ? 0 : 1;
    const cameraOn = body.cameraOn === true ? 1 : 0;
    const screenOn = body.screenOn === true ? 1 : 0;

    await env.DB.prepare(
      `INSERT INTO voice_presence (room_id, client_id, name, mic_on, camera_on, screen_on, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_id, client_id) DO UPDATE SET
         name = excluded.name,
         mic_on = excluded.mic_on,
         camera_on = excluded.camera_on,
         screen_on = excluded.screen_on,
         last_seen = excluded.last_seen`,
    )
      .bind(roomId, clientId, name, micOn, cameraOn, screenOn, now)
      .run();

    return json({
      ok: true,
      participant: toPresence({
        room_id: roomId,
        client_id: clientId,
        name,
        mic_on: micOn,
        camera_on: cameraOn,
        screen_on: screenOn,
        last_seen: now,
      }),
    }, 201);
  }

  if (request.method === "DELETE") {
    const body = (await request.json()) as Record<string, unknown>;
    const roomId = cleanText(body.roomId, "sala-amigos", 120);
    const clientId = cleanText(body.clientId, "pessoa", 80);
    await env.DB.prepare(`DELETE FROM voice_presence WHERE room_id = ? AND client_id = ?`).bind(roomId, clientId).run();

    return json({ ok: true });
  }

  return json({ error: "Metodo nao permitido." }, 405);
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/messages") {
      return handleMessages(request, env);
    }

    if (url.pathname === "/api/signals") {
      return handleSignals(request, env);
    }

    if (url.pathname === "/api/presence") {
      return handlePresence(request, env);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;

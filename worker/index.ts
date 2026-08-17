import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
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

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

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

async function handleMessages(request: Request, env: Env) {
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

async function handleSignals(request: Request, env: Env) {
  await ensureSchema(env.DB);
  const url = new URL(request.url);

  if (request.method === "GET") {
    const roomId = cleanText(url.searchParams.get("roomId"), "sala-amigos", 80);
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

    if (!["join", "offer", "answer", "ice", "leave"].includes(kind)) {
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

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/messages") {
      return handleMessages(request, env);
    }

    if (url.pathname === "/api/signals") {
      return handleSignals(request, env);
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

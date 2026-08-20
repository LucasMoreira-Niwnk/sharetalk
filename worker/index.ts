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
  avatar_url?: string;
  mic_on: number;
  camera_on: number;
  screen_on: number;
  last_seen: number;
};

type ChannelRow = {
  id: string;
  server_id: string;
  name: string;
  type: "text" | "voice";
  order_index: number;
  created_at: number;
  updated_at: number;
};

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  password_hash: string;
  salt: string;
  session_token: string | null;
  created_at: number;
  updated_at: number;
};

type LocalStore = {
  nextMessageId: number;
  nextSignalId: number;
  messages: ChatMessageRow[];
  signals: SignalRow[];
  presences: PresenceRow[];
  channels: ChannelRow[];
  users: UserRow[];
};

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const PRESENCE_TTL_MS = 4000;
const DEFAULT_SERVER_ID = "infernus";
const DEFAULT_CHANNELS: Omit<ChannelRow, "server_id" | "created_at" | "updated_at">[] = [
  { id: "geral", name: "geral", type: "text", order_index: 1 },
  { id: "avisos", name: "avisos", type: "text", order_index: 2 },
  { id: "memes", name: "memes", type: "text", order_index: 3 },
  { id: "lounge", name: "Lounge", type: "voice", order_index: 1 },
  { id: "jogos", name: "Jogos", type: "voice", order_index: 2 },
  { id: "estudo", name: "Estudo", type: "voice", order_index: 3 },
];

const emptyStore = (): LocalStore => ({
  nextMessageId: 1,
  nextSignalId: 1,
  messages: [],
  signals: [],
  presences: [],
  channels: [],
  users: [],
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
  store.channels ??= [];
  store.users ??= [];
  return store;
}

function toUser(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  };
}

function cleanUsername(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 32);
}

async function hashPassword(password: string, salt: string) {
  const bytes = new TextEncoder().encode(`${salt}:${password}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function makeToken(prefix: string) {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "")}`;
}

function cleanAvatar(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  const clean = value.trim();
  if (!clean) {
    return "";
  }

  if (!clean.startsWith("data:image/") && !clean.startsWith("https://") && !clean.startsWith("http://")) {
    return "";
  }

  return clean.slice(0, 350000);
}

async function validateLocalSession(store: LocalStore, userId: string, token: string) {
  const user = store.users.find((row) => row.id === userId && row.session_token === token);
  return user ?? null;
}

function defaultChannels(serverId: string): ChannelRow[] {
  const now = Date.now();
  return DEFAULT_CHANNELS.map((channel) => ({
    ...channel,
    server_id: serverId,
    created_at: now,
    updated_at: now,
  }));
}

function toChannel(row: ChannelRow) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function channelIdFromName(name: string) {
  const id = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  return id || `canal-${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueChannelId(rows: ChannelRow[], serverId: string, name: string) {
  const base = channelIdFromName(name);
  let candidate = base;
  let suffix = 2;

  while (rows.some((row) => row.server_id === serverId && row.id === candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

async function handleLocalChannels(request: Request) {
  const url = new URL(request.url);
  const store = await readLocalStore();
  const serverId = cleanText(url.searchParams.get("serverId"), DEFAULT_SERVER_ID, 80);

  if (!store.channels.some((channel) => channel.server_id === serverId)) {
    store.channels.push(...defaultChannels(serverId));
    await writeLocalStore(store);
  }

  if (request.method === "GET") {
    return json({
      channels: store.channels
        .filter((channel) => channel.server_id === serverId)
        .sort((a, b) => a.type.localeCompare(b.type) || a.order_index - b.order_index || a.created_at - b.created_at)
        .map(toChannel),
    });
  }

  if (request.method === "POST") {
    const body = (await request.json()) as Record<string, unknown>;
    const bodyServerId = cleanText(body.serverId, serverId, 80);
    const type = body.type === "voice" ? "voice" : "text";
    const name = cleanText(body.name, type === "voice" ? "Novo canal" : "novo-canal", 48);
    const now = Date.now();
    const orderIndex = store.channels.filter((channel) => channel.server_id === bodyServerId && channel.type === type).length + 1;
    const row: ChannelRow = {
      id: uniqueChannelId(store.channels, bodyServerId, name),
      server_id: bodyServerId,
      name,
      type,
      order_index: orderIndex,
      created_at: now,
      updated_at: now,
    };

    store.channels.push(row);
    await writeLocalStore(store);

    return json({ channel: toChannel(row) }, 201);
  }

  if (request.method === "PATCH") {
    const body = (await request.json()) as Record<string, unknown>;
    const bodyServerId = cleanText(body.serverId, serverId, 80);
    const id = cleanText(body.id, "", 80);
    const name = cleanText(body.name, "", 48);
    const row = store.channels.find((channel) => channel.server_id === bodyServerId && channel.id === id);

    if (!row || !name) {
      return json({ error: "Canal nao encontrado." }, 404);
    }

    row.name = name;
    row.updated_at = Date.now();
    await writeLocalStore(store);

    return json({ channel: toChannel(row) });
  }

  if (request.method === "DELETE") {
    const body = (await request.json()) as Record<string, unknown>;
    const bodyServerId = cleanText(body.serverId, serverId, 80);
    const id = cleanText(body.id, "", 80);
    const row = store.channels.find((channel) => channel.server_id === bodyServerId && channel.id === id);

    if (!row) {
      return json({ error: "Canal nao encontrado." }, 404);
    }

    const sameTypeCount = store.channels.filter((channel) => channel.server_id === bodyServerId && channel.type === row.type).length;
    if (sameTypeCount <= 1) {
      return json({ error: "Mantenha pelo menos um canal deste tipo." }, 400);
    }

    store.channels = store.channels.filter((channel) => !(channel.server_id === bodyServerId && channel.id === id));
    const roomPrefix = `${bodyServerId}:${row.type === "voice" ? "voz" : "texto"}:${id}`;
    store.messages = store.messages.filter((message) => message.room_id !== roomPrefix);
    store.signals = store.signals.filter((signal) => signal.room_id !== roomPrefix);
    store.presences = store.presences.filter((presence) => presence.room_id !== roomPrefix);
    await writeLocalStore(store);

    return json({ ok: true });
  }

  return json({ error: "Metodo nao permitido." }, 405);
}

async function handleLocalAuth(request: Request) {
  const url = new URL(request.url);
  const store = await readLocalStore();

  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    const userId = cleanText(url.searchParams.get("userId"), "", 80);
    const token = cleanText(url.searchParams.get("token"), "", 160);
    const user = await validateLocalSession(store, userId, token);

    if (!user) {
      return json({ error: "Sessao invalida." }, 401);
    }

    return json({ user: toUser(user) });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/register") {
    const body = (await request.json()) as Record<string, unknown>;
    const username = cleanUsername(body.username);
    const password = typeof body.password === "string" ? body.password : "";
    const displayName = cleanText(body.displayName, username || "Amigo", 48);
    const avatarUrl = cleanAvatar(body.avatarUrl);

    if (username.length < 3 || password.length < 4) {
      return json({ error: "Informe usuario com 3 caracteres e senha com 4 ou mais." }, 400);
    }

    if (store.users.some((user) => user.username === username)) {
      return json({ error: "Usuario ja existe." }, 409);
    }

    const now = Date.now();
    const salt = makeToken("sal");
    const token = makeToken("sessao");
    const row: UserRow = {
      id: makeToken("user").slice(0, 24),
      username,
      display_name: displayName,
      avatar_url: avatarUrl,
      password_hash: await hashPassword(password, salt),
      salt,
      session_token: token,
      created_at: now,
      updated_at: now,
    };

    store.users.push(row);
    await writeLocalStore(store);

    return json({ user: toUser(row), token }, 201);
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const body = (await request.json()) as Record<string, unknown>;
    const username = cleanUsername(body.username);
    const password = typeof body.password === "string" ? body.password : "";
    const user = store.users.find((row) => row.username === username);

    if (!user || user.password_hash !== await hashPassword(password, user.salt)) {
      return json({ error: "Usuario ou senha invalidos." }, 401);
    }

    user.session_token = makeToken("sessao");
    user.updated_at = Date.now();
    await writeLocalStore(store);

    return json({ user: toUser(user), token: user.session_token });
  }

  if (request.method === "PATCH" && url.pathname === "/api/auth/profile") {
    const body = (await request.json()) as Record<string, unknown>;
    const userId = cleanText(body.userId, "", 80);
    const token = cleanText(body.token, "", 160);
    const user = await validateLocalSession(store, userId, token);

    if (!user) {
      return json({ error: "Sessao invalida." }, 401);
    }

    user.display_name = cleanText(body.displayName, user.display_name, 48);
    user.avatar_url = cleanAvatar(body.avatarUrl);
    user.updated_at = Date.now();
    await writeLocalStore(store);

    return json({ user: toUser(user) });
  }

  return json({ error: "Metodo nao permitido." }, 405);
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
    avatarUrl: row.avatar_url ?? "",
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
    const avatarUrl = cleanAvatar(body.avatarUrl);
    const nextPresence: PresenceRow = {
      room_id: roomId,
      client_id: clientId,
      name,
      avatar_url: avatarUrl,
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
      avatar_url TEXT NOT NULL DEFAULT '',
      mic_on INTEGER NOT NULL,
      camera_on INTEGER NOT NULL,
      screen_on INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (room_id, client_id)
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_voice_presence_room_seen
      ON voice_presence(room_id, last_seen)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS server_channels (
      id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (server_id, id)
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_server_channels_server_type
      ON server_channels(server_id, type, order_index)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      avatar_url TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      session_token TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_users_session
      ON users(id, session_token)`),
  ]);

  try {
    await db.prepare(`ALTER TABLE voice_presence ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''`).run();
  } catch {
    // Existing databases already have the profile avatar column.
  }
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

async function handleChannels(request: Request, env?: Env) {
  if (!env?.DB) {
    return handleLocalChannels(request);
  }

  await ensureSchema(env.DB);
  const url = new URL(request.url);
  const serverId = cleanText(url.searchParams.get("serverId"), DEFAULT_SERVER_ID, 80);

  const existing = await env.DB.prepare(`SELECT COUNT(*) AS total FROM server_channels WHERE server_id = ?`)
    .bind(serverId)
    .first<{ total: number }>();

  if (!existing?.total) {
    const now = Date.now();
    await env.DB.batch(DEFAULT_CHANNELS.map((channel) =>
      env.DB!.prepare(
        `INSERT OR IGNORE INTO server_channels (id, server_id, name, type, order_index, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(channel.id, serverId, channel.name, channel.type, channel.order_index, now, now),
    ));
  }

  if (request.method === "GET") {
    const result = await env.DB.prepare(
      `SELECT id, server_id, name, type, order_index, created_at, updated_at
       FROM server_channels
       WHERE server_id = ?
       ORDER BY type ASC, order_index ASC, created_at ASC`,
    )
      .bind(serverId)
      .all<ChannelRow>();

    return json({ channels: (result.results ?? []).map(toChannel) });
  }

  if (request.method === "POST") {
    const body = (await request.json()) as Record<string, unknown>;
    const bodyServerId = cleanText(body.serverId, serverId, 80);
    const type = body.type === "voice" ? "voice" : "text";
    const name = cleanText(body.name, type === "voice" ? "Novo canal" : "novo-canal", 48);
    const rows = await env.DB.prepare(`SELECT id, server_id, name, type, order_index, created_at, updated_at FROM server_channels WHERE server_id = ?`)
      .bind(bodyServerId)
      .all<ChannelRow>();
    const existingRows = rows.results ?? [];
    const id = uniqueChannelId(existingRows, bodyServerId, name);
    const orderIndex = existingRows.filter((channel) => channel.type === type).length + 1;
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO server_channels (id, server_id, name, type, order_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, bodyServerId, name, type, orderIndex, now, now)
      .run();

    return json({
      channel: toChannel({
        id,
        server_id: bodyServerId,
        name,
        type,
        order_index: orderIndex,
        created_at: now,
        updated_at: now,
      }),
    }, 201);
  }

  if (request.method === "PATCH") {
    const body = (await request.json()) as Record<string, unknown>;
    const bodyServerId = cleanText(body.serverId, serverId, 80);
    const id = cleanText(body.id, "", 80);
    const name = cleanText(body.name, "", 48);
    const now = Date.now();

    if (!name) {
      return json({ error: "Nome invalido." }, 400);
    }

    const row = await env.DB.prepare(
      `UPDATE server_channels
       SET name = ?, updated_at = ?
       WHERE server_id = ? AND id = ?
       RETURNING id, server_id, name, type, order_index, created_at, updated_at`,
    )
      .bind(name, now, bodyServerId, id)
      .first<ChannelRow>();

    if (!row) {
      return json({ error: "Canal nao encontrado." }, 404);
    }

    return json({ channel: toChannel(row) });
  }

  if (request.method === "DELETE") {
    const body = (await request.json()) as Record<string, unknown>;
    const bodyServerId = cleanText(body.serverId, serverId, 80);
    const id = cleanText(body.id, "", 80);
    const row = await env.DB.prepare(
      `SELECT id, server_id, name, type, order_index, created_at, updated_at
       FROM server_channels
       WHERE server_id = ? AND id = ?`,
    )
      .bind(bodyServerId, id)
      .first<ChannelRow>();

    if (!row) {
      return json({ error: "Canal nao encontrado." }, 404);
    }

    const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM server_channels WHERE server_id = ? AND type = ?`)
      .bind(bodyServerId, row.type)
      .first<{ total: number }>();

    if ((count?.total ?? 0) <= 1) {
      return json({ error: "Mantenha pelo menos um canal deste tipo." }, 400);
    }

    const roomId = `${bodyServerId}:${row.type === "voice" ? "voz" : "texto"}:${id}`;
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM server_channels WHERE server_id = ? AND id = ?`).bind(bodyServerId, id),
      env.DB.prepare(`DELETE FROM chat_messages WHERE room_id = ?`).bind(roomId),
      env.DB.prepare(`DELETE FROM room_signals WHERE room_id = ?`).bind(roomId),
      env.DB.prepare(`DELETE FROM voice_presence WHERE room_id = ?`).bind(roomId),
    ]);

    return json({ ok: true });
  }

  return json({ error: "Metodo nao permitido." }, 405);
}

async function validateSession(db: D1Database, userId: string, token: string) {
  if (!userId || !token) {
    return null;
  }

  return db.prepare(
    `SELECT id, username, display_name, avatar_url, password_hash, salt, session_token, created_at, updated_at
     FROM users
     WHERE id = ? AND session_token = ?`,
  )
    .bind(userId, token)
    .first<UserRow>();
}

async function handleAuth(request: Request, env?: Env) {
  if (!env?.DB) {
    return handleLocalAuth(request);
  }

  await ensureSchema(env.DB);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    const userId = cleanText(url.searchParams.get("userId"), "", 80);
    const token = cleanText(url.searchParams.get("token"), "", 160);
    const user = await validateSession(env.DB, userId, token);

    if (!user) {
      return json({ error: "Sessao invalida." }, 401);
    }

    return json({ user: toUser(user) });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/register") {
    const body = (await request.json()) as Record<string, unknown>;
    const username = cleanUsername(body.username);
    const password = typeof body.password === "string" ? body.password : "";
    const displayName = cleanText(body.displayName, username || "Amigo", 48);
    const avatarUrl = cleanAvatar(body.avatarUrl);

    if (username.length < 3 || password.length < 4) {
      return json({ error: "Informe usuario com 3 caracteres e senha com 4 ou mais." }, 400);
    }

    const existing = await env.DB.prepare(`SELECT id FROM users WHERE username = ?`).bind(username).first<{ id: string }>();
    if (existing) {
      return json({ error: "Usuario ja existe." }, 409);
    }

    const now = Date.now();
    const salt = makeToken("sal");
    const token = makeToken("sessao");
    const row: UserRow = {
      id: makeToken("user").slice(0, 24),
      username,
      display_name: displayName,
      avatar_url: avatarUrl,
      password_hash: await hashPassword(password, salt),
      salt,
      session_token: token,
      created_at: now,
      updated_at: now,
    };

    await env.DB.prepare(
      `INSERT INTO users (id, username, display_name, avatar_url, password_hash, salt, session_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(row.id, row.username, row.display_name, row.avatar_url, row.password_hash, row.salt, row.session_token, row.created_at, row.updated_at)
      .run();

    return json({ user: toUser(row), token }, 201);
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const body = (await request.json()) as Record<string, unknown>;
    const username = cleanUsername(body.username);
    const password = typeof body.password === "string" ? body.password : "";
    const user = await env.DB.prepare(
      `SELECT id, username, display_name, avatar_url, password_hash, salt, session_token, created_at, updated_at
       FROM users
       WHERE username = ?`,
    )
      .bind(username)
      .first<UserRow>();

    if (!user || user.password_hash !== await hashPassword(password, user.salt)) {
      return json({ error: "Usuario ou senha invalidos." }, 401);
    }

    const token = makeToken("sessao");
    const now = Date.now();
    await env.DB.prepare(`UPDATE users SET session_token = ?, updated_at = ? WHERE id = ?`)
      .bind(token, now, user.id)
      .run();

    user.session_token = token;
    user.updated_at = now;

    return json({ user: toUser(user), token });
  }

  if (request.method === "PATCH" && url.pathname === "/api/auth/profile") {
    const body = (await request.json()) as Record<string, unknown>;
    const userId = cleanText(body.userId, "", 80);
    const token = cleanText(body.token, "", 160);
    const user = await validateSession(env.DB, userId, token);

    if (!user) {
      return json({ error: "Sessao invalida." }, 401);
    }

    const displayName = cleanText(body.displayName, user.display_name, 48);
    const avatarUrl = cleanAvatar(body.avatarUrl);
    const now = Date.now();
    await env.DB.prepare(`UPDATE users SET display_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?`)
      .bind(displayName, avatarUrl, now, user.id)
      .run();

    return json({
      user: toUser({
        ...user,
        display_name: displayName,
        avatar_url: avatarUrl,
        updated_at: now,
      }),
    });
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
      `SELECT room_id, client_id, name, avatar_url, mic_on, camera_on, screen_on, last_seen
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
    const avatarUrl = cleanAvatar(body.avatarUrl);
    const micOn = body.micOn === false ? 0 : 1;
    const cameraOn = body.cameraOn === true ? 1 : 0;
    const screenOn = body.screenOn === true ? 1 : 0;

    await env.DB.prepare(
      `INSERT INTO voice_presence (room_id, client_id, name, avatar_url, mic_on, camera_on, screen_on, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_id, client_id) DO UPDATE SET
         name = excluded.name,
         avatar_url = excluded.avatar_url,
         mic_on = excluded.mic_on,
         camera_on = excluded.camera_on,
         screen_on = excluded.screen_on,
         last_seen = excluded.last_seen`,
    )
      .bind(roomId, clientId, name, avatarUrl, micOn, cameraOn, screenOn, now)
      .run();

    return json({
      ok: true,
      participant: toPresence({
        room_id: roomId,
        client_id: clientId,
        name,
        avatar_url: avatarUrl,
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

    if (url.pathname === "/api/channels") {
      return handleChannels(request, env);
    }

    if (url.pathname.startsWith("/api/auth/")) {
      return handleAuth(request, env);
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

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
      DB: {
        batch: async () => [],
        prepare: () => {
          throw new Error("DB should not be called while server-rendering the shell");
        },
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the video room shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /Sharetalk/i);
  assert.match(html, /Carregando/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("uses local persistence when D1 is unavailable", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sharetalk-"));
  process.env.SHARETALK_DATA_FILE = join(dataDir, "store.json");

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("local", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const ctx = {
      waitUntil() {},
      passThroughOnException() {},
    };

    const created = await worker.fetch(
      new Request("http://localhost/api/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roomId: "Servidor-thoseguys:texto:geral",
          authorId: "pessoa-teste",
          authorName: "Lucas",
          body: "Teste local",
        }),
      }),
      undefined,
      ctx,
    );

    assert.equal(created.status, 201);

    const loaded = await worker.fetch(
      new Request("http://localhost/api/messages?roomId=Servidor-thoseguys%3Atexto%3Ageral"),
      undefined,
      ctx,
    );
    assert.equal(loaded.status, 200);

    const payload = await loaded.json();
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0].body, "Teste local");
  } finally {
    delete process.env.SHARETALK_DATA_FILE;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("can manage local server channels when D1 is unavailable", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sharetalk-channels-"));
  process.env.SHARETALK_DATA_FILE = join(dataDir, "store.json");

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("channels", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const ctx = {
      waitUntil() {},
      passThroughOnException() {},
    };

    const created = await worker.fetch(
      new Request("http://localhost/api/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serverId: "infernus",
          type: "voice",
          name: "Cinema",
        }),
      }),
      undefined,
      ctx,
    );

    assert.equal(created.status, 201);
    const createdPayload = await created.json();
    assert.equal(createdPayload.channel.name, "Cinema");

    const renamed = await worker.fetch(
      new Request("http://localhost/api/channels", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serverId: "infernus",
          id: createdPayload.channel.id,
          name: "Filmes",
        }),
      }),
      undefined,
      ctx,
    );

    assert.equal(renamed.status, 200);
    const renamedPayload = await renamed.json();
    assert.equal(renamedPayload.channel.name, "Filmes");

    const removed = await worker.fetch(
      new Request("http://localhost/api/channels", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serverId: "infernus",
          id: createdPayload.channel.id,
        }),
      }),
      undefined,
      ctx,
    );

    assert.equal(removed.status, 200);

    const loaded = await worker.fetch(
      new Request("http://localhost/api/channels?serverId=infernus"),
      undefined,
      ctx,
    );
    const payload = await loaded.json();
    assert.equal(payload.channels.some((channel) => channel.name === "Filmes"), false);
  } finally {
    delete process.env.SHARETALK_DATA_FILE;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("can register, login and update a local profile", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sharetalk-auth-"));
  process.env.SHARETALK_DATA_FILE = join(dataDir, "store.json");

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("auth", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const ctx = {
      waitUntil() {},
      passThroughOnException() {},
    };

    const registered = await worker.fetch(
      new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "lucas",
          password: "1234",
          displayName: "Lucas",
          avatarUrl: "data:image/png;base64,AAAA",
        }),
      }),
      undefined,
      ctx,
    );

    assert.equal(registered.status, 201);
    const registerPayload = await registered.json();
    assert.equal(registerPayload.user.username, "lucas");

    const logged = await worker.fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "lucas",
          password: "1234",
        }),
      }),
      undefined,
      ctx,
    );

    assert.equal(logged.status, 200);
    const loginPayload = await logged.json();

    const updated = await worker.fetch(
      new Request("http://localhost/api/auth/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: loginPayload.user.id,
          token: loginPayload.token,
          displayName: "Lucas MG",
          avatarUrl: "data:image/png;base64,BBBB",
        }),
      }),
      undefined,
      ctx,
    );

    assert.equal(updated.status, 200);
    const updatedPayload = await updated.json();
    assert.equal(updatedPayload.user.displayName, "Lucas MG");
    assert.equal(updatedPayload.user.avatarUrl, "data:image/png;base64,BBBB");
  } finally {
    delete process.env.SHARETALK_DATA_FILE;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("tracks local voice presence when D1 is unavailable", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sharetalk-presence-"));
  process.env.SHARETALK_DATA_FILE = join(dataDir, "store.json");

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("presence", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const ctx = {
      waitUntil() {},
      passThroughOnException() {},
    };

    const heartbeat = await worker.fetch(
      new Request("http://localhost/api/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roomId: "Servidor-thoseguys:voz:lounge",
          clientId: "pessoa-teste",
          name: "Lucas",
          micOn: true,
          cameraOn: false,
          screenOn: false,
        }),
      }),
      undefined,
      ctx,
    );

    assert.equal(heartbeat.status, 201);

    const loaded = await worker.fetch(
      new Request("http://localhost/api/presence?roomId=Servidor-thoseguys%3Avoz%3Alounge"),
      undefined,
      ctx,
    );
    assert.equal(loaded.status, 200);

    const payload = await loaded.json();
    assert.equal(payload.participants.length, 1);
    assert.equal(payload.participants[0].clientId, "pessoa-teste");
    assert.equal(payload.participants[0].name, "Lucas");
    assert.equal(payload.participants[0].micOn, true);
  } finally {
    delete process.env.SHARETALK_DATA_FILE;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("can start signaling from the latest local cursor", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sharetalk-signals-"));
  process.env.SHARETALK_DATA_FILE = join(dataDir, "store.json");

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("signals", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const ctx = {
      waitUntil() {},
      passThroughOnException() {},
    };

    for (const senderId of ["pessoa-a", "pessoa-b"]) {
      const created = await worker.fetch(
        new Request("http://localhost/api/signals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            roomId: "Servidor-thoseguys:voz:lounge",
            senderId,
            kind: "join",
            payload: { name: senderId },
          }),
        }),
        undefined,
        ctx,
      );
      assert.equal(created.status, 201);
    }

    const latest = await worker.fetch(
      new Request("http://localhost/api/signals?roomId=Servidor-thoseguys%3Avoz%3Alounge&latest=1"),
      undefined,
      ctx,
    );

    assert.equal(latest.status, 200);
    const payload = await latest.json();
    assert.deepEqual(payload.signals, []);
    assert.equal(payload.lastId, 2);
  } finally {
    delete process.env.SHARETALK_DATA_FILE;
    await rm(dataDir, { recursive: true, force: true });
  }
});

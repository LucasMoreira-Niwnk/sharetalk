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
    new Request("http://localhost/servers/servidor-teste", {
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
  assert.match(html, /Papo Vivo/i);
  assert.match(html, /Chamada de video/i);
  assert.match(html, /Canais de texto/i);
  assert.match(html, /Canais de voz/i);
  assert.match(html, /Entrar no canal/i);
  assert.match(html, /Chat persistente/i);
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

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_REQUEST_BYTES, validateObsEvent } from "../shared/types.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const token = "sty190-server-test";
let port = 0;
let temporaryDirectory = "";
let serverProcess: ChildProcess;

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Unable to allocate test port"));
        return;
      }
      listener.close(() => {
        resolve(address.port);
      });
    });
  });
}

function validEvent() {
  return {
    event_id: "server-valid-event",
    ts: "2026-08-20T00:00:00.000Z",
    type: "user_message",
    session_id: "server-session",
    cwd: "/tmp/server",
    pool: "test",
    tags: ["sty-190"],
    payload: { text: "captured", images_count: 0 },
    seq: 0,
  } as const;
}

async function postEvent(body: unknown): Promise<{ ingested: number; rejected: string[] }> {
  const response = await fetch(`http://127.0.0.1:${port}/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<{ ingested: number; rejected: string[] }>;
}

async function sendOversizedChunkedBody(): Promise<Response> {
  const encodedChunk = new TextEncoder().encode("é".repeat(32_768));
  let bytesSent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (bytesSent > MAX_REQUEST_BYTES) {
        controller.close();
        return;
      }
      controller.enqueue(encodedChunk);
      bytesSent += encodedChunk.byteLength;
    },
  });
  return fetch(`http://127.0.0.1:${port}/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

async function readStreamUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes(marker)) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`SSE stream ended before ${marker}`);
    received += decoder.decode(chunk.value, { stream: true });
  }
  return received;
}

beforeAll(async () => {
  port = await allocatePort();
  temporaryDirectory = mkdtempSync(join(tmpdir(), "sty190-server-"));
  serverProcess = spawn("bun", ["apps/observability/server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      OBS_PORT: String(port),
      OBS_HOST: "127.0.0.1",
      OBS_AUTH_TOKEN: token,
      OBS_DB_PATH: join(temporaryDirectory, "events.sqlite"),
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  let healthStatus = 0;
  while (Date.now() < deadline && healthStatus !== 200) {
    try {
      healthStatus = (await fetch(`http://127.0.0.1:${port}/health`)).status;
    } catch {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  }
  expect(healthStatus).toBe(200);
});

afterAll(async () => {
  serverProcess.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    serverProcess.once("exit", () => {
      resolve();
    });
  });
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("server ingestion trust boundary", () => {
  it("validates exact envelopes and discriminator payloads before persistence", async () => {
    expect(validateObsEvent(validEvent())).toBe(true);
    const malformed = {
      ...validEvent(),
      event_id: "server-malformed-event",
      type: "not_an_event",
      seq: "zero",
      unexpected: true,
    };
    expect(validateObsEvent(malformed)).toBe(false);
    expect(
      validateObsEvent({
        ...validEvent(),
        event_id: "invalid-nested-event",
        type: "agent_start",
        payload: {
          prompt: "prompt",
          images_count: 0,
          system_prompt_options: { unexpected: "nested exact-key violation" },
        },
      }),
    ).toBe(false);
    expect(validateObsEvent({ ...validEvent(), ts: "not-a-timestamp" })).toBe(false);
    expect(await postEvent(malformed)).toEqual({
      ingested: 0,
      rejected: ["server-malformed-event"],
    });
    expect(await postEvent(validEvent())).toEqual({ ingested: 1, rejected: [] });
  });

  it("keeps one SSE subscription alive through a heartbeat and a later event", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/events/stream?token=${token}`, {
      signal: AbortSignal.timeout(20_000),
    });
    expect(response.status).toBe(200);
    expect(response.body).not.toBeNull();
    const reader = response.body!.getReader();
    try {
      await readStreamUntil(reader, "\n\n");
      const heartbeat = await reader.read();
      expect(heartbeat.done).toBe(false);
      expect(heartbeat.value?.byteLength).toBeGreaterThan(0);

      const eventAfterHeartbeat = {
        ...validEvent(),
        event_id: "server-event-after-heartbeat",
        seq: 1,
      };
      expect(await postEvent(eventAfterHeartbeat)).toEqual({ ingested: 1, rejected: [] });
      expect(await readStreamUntil(reader, eventAfterHeartbeat.event_id)).toContain(
        eventAfterHeartbeat.event_id,
      );
    } finally {
      await reader.cancel();
    }
  }, 25_000);

  it("rejects deeply nested custom JSON without destabilizing the server", async () => {
    const eventId = "server-deeply-nested-event";
    const nestedData = `${'{"next":'.repeat(50_000)}null${"}".repeat(50_000)}`;
    const body = JSON.stringify({
      ...validEvent(),
      event_id: eventId,
      type: "custom",
      session_id: "server-deep-session",
      payload: { custom_type: "deeply-nested", data: null },
      seq: 0,
    }).replace('"data":null', `"data":${nestedData}`);

    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_REQUEST_BYTES);

    const request = fetch(`http://127.0.0.1:${port}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    });
    await expect(request).resolves.toHaveProperty("status", 200);
    await expect((await request).json()).resolves.toEqual({
      ingested: 0,
      rejected: [eventId],
    });

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ ok: true });

    await expect(
      postEvent({
        ...validEvent(),
        event_id: "server-valid-after-deeply-nested-event",
        session_id: "server-deep-session",
      }),
    ).resolves.toEqual({ ingested: 1, rejected: [] });
  });

  it("rejects streamed multibyte request bodies over the byte cap", async () => {
    const response = await sendOversizedChunkedBody();
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("Payload too large");
  });
});

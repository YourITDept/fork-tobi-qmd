/**
 * Fork (Business Brain Wiki, cs62): `qmd vsearch` printed `[]` and exited 0 when the query could not
 * be embedded (the key refused, the endpoint down), the error only on stderr, so a caller read it
 * as "nothing matched". Now it exits 1 with nothing on stdout. A real empty answer stays `[]`, exit 0.
 * A fake OpenAI-compatible /v1/embeddings server stands in for the provider.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawn } from "child_process";
import { createServer, type Server } from "http";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const qmdScript = join(projectRoot, "src", "cli", "qmd.ts");
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

let dir: string;
let server: Server;
let port = 0;
let refuse = false;

function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = isBun ? [qmdScript, ...args] : [tsxCli, qmdScript, ...args];
  const proc = spawn(process.execPath, command, {
    cwd: dir,
    env: {
      ...process.env,
      INDEX_PATH: join(dir, "index.sqlite"),
      QMD_CONFIG_DIR: join(dir, "config"),
      PWD: dir,
      QMD_LOCAL_MODELS: "off",
      QMD_EMBED_MODEL: `http://127.0.0.1:${port}/v1#test-embed`,
      QMD_EMBED_API_KEY: "test-key",
      QMD_DOCTOR_DEVICE_PROBE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  return new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (refuse) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "No auth credentials found" } }));
        return;
      }
      const input = (JSON.parse(body || "{}") as { input?: string | string[] }).input ?? [];
      const inputs = Array.isArray(input) ? input : [input];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "test-embed", data: inputs.map((_, index) => ({ index, embedding: [0.6, 0.8, 0] })) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as { port: number }).port;

  dir = await mkdtemp(join(tmpdir(), "qmd-vsearch-embed-error-"));
  await mkdir(join(dir, "config"), { recursive: true });
  await writeFile(join(dir, "config", "index.yml"), "collections: {}\n");
  await mkdir(join(dir, "notes"), { recursive: true });
  await writeFile(join(dir, "notes", "alpha.md"), "# Alpha\n\nThe alpha page.\n");
  await writeFile(join(dir, "notes", "beta.md"), "# Beta\n\nThe beta page.\n");
  expect((await run(["collection", "add", join(dir, "notes"), "--name", "notes"])).code).toBe(0);
  const embedded = await run(["embed"]);
  expect(embedded.code, embedded.stderr).toBe(0);
}, 120_000);

afterAll(async () => {
  server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("qmd vsearch and a query that cannot be embedded", () => {
  test("embedded: results, exit 0", async () => {
    refuse = false;
    const result = await run(["vsearch", "alpha", "--json", "-c", "notes"]);
    expect(result.code, result.stderr).toBe(0);
    expect((JSON.parse(result.stdout) as unknown[]).length).toBeGreaterThan(0);
  }, 60_000);

  test("nothing above the minimum score: [] and exit 0, as before", async () => {
    refuse = false;
    const result = await run(["vsearch", "alpha", "--json", "-c", "notes", "--min-score", "2"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  }, 60_000);

  test("the key refused: exit 1, nothing on stdout, the reason on stderr", async () => {
    refuse = true;
    const result = await run(["vsearch", "alpha", "--json", "-c", "notes"]);
    expect(result.code).toBe(1);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toMatch(/vsearch failed: the query could not be embedded \(all remote embedding endpoints failed or unhealthy \(last error: remote embed endpoint http:\/\/127\.0\.0\.1:\d+\/v1 returned HTTP 401\)\)\./);
  }, 60_000);
});

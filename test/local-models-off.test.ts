/**
 * Fork (Business Brain Wiki, cs62): API-only installs. `QMD_LOCAL_MODELS=off` keeps node-llama-cpp
 * unloaded (nothing downloaded): query expansion returns the original query and reranking keeps the
 * retrieval order. A local model that cannot load (node-llama-cpp not installed) falls back the
 * same way instead of failing the search.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { LlamaCpp, localModelsDisabled, setNodeLlamaCppModuleForTest } from "../src/llm.ts";

const documents = [
  { file: "a.md", text: "alpha" },
  { file: "b.md", text: "beta" },
  { file: "c.md", text: "gamma" },
];

function failingModule(getLlama: ReturnType<typeof vi.fn>) {
  return {
    LlamaLogLevel: { error: "error" },
    resolveModelFile: vi.fn(),
    LlamaChatSession: vi.fn() as any,
    getLlama,
  };
}

const previous = process.env.QMD_LOCAL_MODELS;
const previousCi = process.env.CI;
afterEach(() => {
  setNodeLlamaCppModuleForTest(null);
  if (previous === undefined) delete process.env.QMD_LOCAL_MODELS;
  else process.env.QMD_LOCAL_MODELS = previous;
  if (previousCi === undefined) delete process.env.CI;
  else process.env.CI = previousCi;
  vi.restoreAllMocks();
});

describe("QMD_LOCAL_MODELS", () => {
  test("reads off / 0 / false / no / none as off; anything else (or unset) as on", () => {
    for (const value of ["off", "OFF", "0", "false", "no", "none", " off "]) expect(localModelsDisabled(value), value).toBe(true);
    for (const value of [undefined, "", "on", "1", "true", "local"]) expect(localModelsDisabled(value), String(value)).toBe(false);
  });

  test("off: expansion returns the original query and node-llama-cpp is never loaded", async () => {
    process.env.QMD_LOCAL_MODELS = "off";
    const getLlama = vi.fn(async () => { throw new Error("must not load"); });
    setNodeLlamaCppModuleForTest(failingModule(getLlama));
    const llm = new LlamaCpp();
    expect(await llm.expandQuery("how do agents propose a change")).toEqual([
      { type: "lex", text: "how do agents propose a change" },
      { type: "vec", text: "how do agents propose a change" },
    ]);
    expect(await llm.expandQuery("q", { includeLexical: false })).toEqual([{ type: "vec", text: "q" }]);
    expect(getLlama).not.toHaveBeenCalled();
  });

  test("off: reranking keeps the retrieval order", async () => {
    process.env.QMD_LOCAL_MODELS = "off";
    const getLlama = vi.fn(async () => { throw new Error("must not load"); });
    setNodeLlamaCppModuleForTest(failingModule(getLlama));
    const result = await new LlamaCpp().rerank("q", documents);
    expect(result.results.map((r) => r.file)).toEqual(["a.md", "b.md", "c.md"]);
    expect(result.results.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(getLlama).not.toHaveBeenCalled();
  });
});

describe("a local model that cannot load", () => {
  test("expansion falls back to the original query, with one warning", async () => {
    delete process.env.QMD_LOCAL_MODELS;
    delete process.env.CI; // CI mode refuses model work before the fallback, by design
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setNodeLlamaCppModuleForTest(failingModule(vi.fn(async () => { throw new Error("node-llama-cpp is not installed"); })));
    const llm = new LlamaCpp();
    expect(await llm.expandQuery("q")).toEqual([{ type: "lex", text: "q" }, { type: "vec", text: "q" }]);
    expect(stderr.mock.calls.some(([text]) => String(text).includes("query expansion skipped"))).toBe(true);
  });

  test("reranking keeps the retrieval order", async () => {
    delete process.env.QMD_LOCAL_MODELS;
    delete process.env.CI;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setNodeLlamaCppModuleForTest(failingModule(vi.fn(async () => { throw new Error("node-llama-cpp is not installed"); })));
    const result = await new LlamaCpp().rerank("q", documents);
    expect(result.results.map((r) => r.file)).toEqual(["a.md", "b.md", "c.md"]);
  });
});

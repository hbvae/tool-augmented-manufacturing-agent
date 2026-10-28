import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EmbeddingReranker,
  EmbeddingVectorCache,
  TransformersEmbeddingProvider,
  cosineSimilarity,
  l2Normalize,
} from "../src/embedding.mjs";

test("L2 normalization produces unit vectors and cosine similarity", () => {
  const normalized = l2Normalize([3, 4]);
  assert.ok(Math.abs(normalized[0] - 0.6) < 1e-10);
  assert.ok(Math.abs(normalized[1] - 0.8) < 1e-10);
  assert.ok(Math.abs(cosineSimilarity(normalized, normalized) - 1) < 1e-10);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-10);
});

test("Transformers provider applies query instruction, normalizes, and persists cache", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "manufacturing-embedding-test-"));
  let calls = 0;
  let capturedInputs;
  const provider = new TransformersEmbeddingProvider({
    model: "mock-bge",
    dtype: "q8",
    vectorCache: new EmbeddingVectorCache({ directory }),
    pipelineFactory: async () => async (inputs, options) => {
      calls += 1;
      capturedInputs = inputs;
      assert.equal(options.pooling, "cls");
      assert.equal(options.normalize, true);
      return { tolist: () => inputs.map(() => [3, 4, 0]) };
    },
  });
  try {
    const first = await provider.embed(["轴承异常噪声"], { role: "query" });
    const second = await provider.embed(["轴承异常噪声"], { role: "query" });
    assert.match(capturedInputs[0], /^为这个句子生成表示以用于检索相关文章：/);
    assert.equal(first.metadata.dimension, 3);
    assert.equal(first.metadata.normalized, true);
    assert.equal(second.metadata.cacheHits, 1);
    assert.equal(calls, 1);
    assert.ok(Math.abs(cosineSimilarity(first.vectors[0], [0.6, 0.8, 0]) - 1) < 1e-10);
    assert.equal(provider.vectorCache.status().diskEntries, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("embedding reranker orders semantically related text first", async () => {
  const provider = {
    async embed(texts, { role }) {
      const vectors = role === "query" ? [[1, 0]] : texts.map((text) => text.includes("轴承") ? [1, 0] : [0, 1]);
      return { vectors, metadata: { provider: "mock", model: "mock", dtype: "f32", dimension: 2, cacheHits: 0, cacheMisses: vectors.length, durationMs: 1 } };
    },
  };
  const reranker = new EmbeddingReranker({ provider });
  const result = await reranker.rerank("设备异响", [{ text: "供应商交付" }, { text: "轴承磨损导致设备异响" }]);
  assert.equal(result.metadata.used, true);
  assert.match(result.items[0].text, /轴承/);
  assert.equal(result.items[0].vectorSimilarity, 1);
});

test("embedding reranker falls back without throwing when model fails", async () => {
  const provider = { async embed() { throw new Error("model unavailable"); } };
  const reranker = new EmbeddingReranker({ provider });
  const items = [{ text: "first" }, { text: "second" }];
  const result = await reranker.rerank("query", items);
  assert.equal(result.metadata.used, false);
  assert.equal(result.metadata.status, "fallback");
  assert.deepEqual(result.items, items);
});

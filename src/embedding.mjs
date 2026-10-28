import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(moduleDir, "..");
const DEFAULT_MODEL = "onnx-community/bge-small-zh-v1.5-ONNX";
const DEFAULT_QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章：";
const DEFAULT_CACHE_DIR = path.join(projectDir, ".model-cache");
const DEFAULT_VECTOR_CACHE_DIR = path.join(projectDir, "cache", "embeddings");

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function booleanEnvironment(name, defaultValue) {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  return !/^(?:0|false|no|off)$/i.test(value);
}

export function l2Normalize(vector) {
  const values = Array.from(vector ?? [], Number);
  if (!values.length || values.some((value) => !Number.isFinite(value))) throw new Error("Embedding vector must contain finite numbers");
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new Error("Embedding vector has zero or invalid L2 norm");
  return values.map((value) => value / norm);
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) throw new Error("Embedding vectors must have the same non-zero dimension");
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) throw new Error("Embedding vector has zero norm");
  return Math.max(-1, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)));
}

export class EmbeddingProvider {
  constructor(name, model) {
    this.name = name;
    this.model = model;
  }

  async embed() {
    throw new Error("EmbeddingProvider.embed must be implemented");
  }
}

export class EmbeddingVectorCache {
  constructor({ directory = process.env.MANUFACTURING_EMBEDDING_VECTOR_CACHE || DEFAULT_VECTOR_CACHE_DIR, enabled = booleanEnvironment("MANUFACTURING_EMBEDDING_CACHE_ENABLED", true) } = {}) {
    this.directory = path.resolve(directory);
    this.enabled = enabled;
    this.memory = new Map();
  }

  key({ model, dtype, role, text }) {
    return digest(JSON.stringify({ version: 1, model, dtype, role, text }));
  }

  get(key) {
    if (!this.enabled) return null;
    if (this.memory.has(key)) return this.memory.get(key);
    const file = path.join(this.directory, `${key}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      const vector = l2Normalize(record.vector);
      this.memory.set(key, vector);
      return vector;
    } catch {
      return null;
    }
  }

  set(key, vector, metadata = {}) {
    const normalized = l2Normalize(vector);
    if (!this.enabled) return normalized;
    fs.mkdirSync(this.directory, { recursive: true });
    const target = path.join(this.directory, `${key}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, normalized: true, dimension: normalized.length, vector: normalized, ...metadata }), "utf8");
    fs.renameSync(temporary, target);
    this.memory.set(key, normalized);
    return normalized;
  }

  status() {
    let diskEntries = 0;
    if (this.enabled && fs.existsSync(this.directory)) {
      try { diskEntries = fs.readdirSync(this.directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length; } catch { diskEntries = 0; }
    }
    return { enabled: this.enabled, directory: this.directory, memoryEntries: this.memory.size, diskEntries };
  }
}

export class TransformersEmbeddingProvider extends EmbeddingProvider {
  constructor({
    model = process.env.MANUFACTURING_EMBEDDING_MODEL || DEFAULT_MODEL,
    dtype = process.env.MANUFACTURING_EMBEDDING_DTYPE || "q8",
    modelCacheDir = process.env.MANUFACTURING_EMBEDDING_MODEL_CACHE || DEFAULT_CACHE_DIR,
    offline = booleanEnvironment("MANUFACTURING_EMBEDDING_OFFLINE", false),
    queryInstruction = process.env.MANUFACTURING_EMBEDDING_QUERY_INSTRUCTION || DEFAULT_QUERY_INSTRUCTION,
    vectorCache = new EmbeddingVectorCache(),
    pipelineFactory,
  } = {}) {
    super("transformers-js", model);
    this.dtype = dtype;
    this.modelCacheDir = path.resolve(modelCacheDir);
    this.offline = offline;
    this.queryInstruction = queryInstruction;
    this.vectorCache = vectorCache;
    this.pipelineFactory = pipelineFactory;
    this.pipelinePromise = null;
    this.dimension = null;
    this.loaded = false;
  }

  async load() {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        fs.mkdirSync(this.modelCacheDir, { recursive: true });
        if (this.pipelineFactory) return this.pipelineFactory({ model: this.model, dtype: this.dtype });
        const transformers = await import("@huggingface/transformers");
        transformers.env.cacheDir = this.modelCacheDir;
        transformers.env.allowRemoteModels = !this.offline;
        transformers.env.allowLocalModels = true;
        return transformers.pipeline("feature-extraction", this.model, { dtype: this.dtype, device: "cpu" });
      })().then((pipeline) => {
        this.loaded = true;
        return pipeline;
      }).catch((error) => {
        this.pipelinePromise = null;
        throw error;
      });
    }
    return this.pipelinePromise;
  }

  async embed(texts, { role = "document" } = {}) {
    const values = (Array.isArray(texts) ? texts : [texts]).map((text) => String(text ?? "").trim());
    if (!values.length || values.length > 64 || values.some((text) => !text)) throw new Error("Embedding input must contain 1 to 64 non-empty texts");
    const startedAt = Date.now();
    const vectors = new Array(values.length);
    const missing = [];
    let cacheHits = 0;
    for (let index = 0; index < values.length; index += 1) {
      const key = this.vectorCache.key({ model: this.model, dtype: this.dtype, role, text: values[index] });
      const cached = this.vectorCache.get(key);
      if (cached) {
        vectors[index] = cached;
        cacheHits += 1;
      } else missing.push({ index, key, text: values[index] });
    }
    if (missing.length) {
      const pipeline = await this.load();
      const inputs = missing.map((item) => role === "query" ? `${this.queryInstruction}${item.text}` : item.text);
      const output = await pipeline(inputs, { pooling: "cls", normalize: true });
      const generated = output.tolist();
      if (!Array.isArray(generated) || generated.length !== missing.length) throw new Error("Embedding model returned an unexpected output shape");
      for (let index = 0; index < missing.length; index += 1) {
        const normalized = this.vectorCache.set(missing[index].key, generated[index], { model: this.model, dtype: this.dtype, role });
        vectors[missing[index].index] = normalized;
      }
    }
    this.dimension = vectors[0].length;
    return {
      vectors,
      metadata: {
        provider: this.name,
        model: this.model,
        dtype: this.dtype,
        dimension: this.dimension,
        normalized: true,
        role,
        count: vectors.length,
        cacheHits,
        cacheMisses: missing.length,
        durationMs: Date.now() - startedAt,
      },
    };
  }

  status() {
    return {
      enabled: true,
      provider: this.name,
      model: this.model,
      dtype: this.dtype,
      dimension: this.dimension,
      loaded: this.loaded,
      offline: this.offline,
      modelCacheDir: this.modelCacheDir,
      vectorCache: this.vectorCache.status(),
    };
  }
}

export class EmbeddingReranker {
  constructor({ provider = new TransformersEmbeddingProvider(), enabled = booleanEnvironment("MANUFACTURING_EMBEDDING_ENABLED", true) } = {}) {
    this.provider = provider;
    this.enabled = enabled;
  }

  async rerank(query, items, { textSelector = (item) => item.text, limit = items.length } = {}) {
    const fallbackItems = [...items].slice(0, limit);
    if (!this.enabled || !items.length) return { items: fallbackItems, metadata: { used: false, status: this.enabled ? "no_items" : "disabled" } };
    try {
      const queryResult = await this.provider.embed([query], { role: "query" });
      const documentResult = await this.provider.embed(items.map(textSelector), { role: "document" });
      const scored = items.map((item, index) => ({ ...item, vectorSimilarity: Number(cosineSimilarity(queryResult.vectors[0], documentResult.vectors[index]).toFixed(6)) }))
        .sort((left, right) => right.vectorSimilarity - left.vectorSimilarity).slice(0, limit);
      return {
        items: scored,
        metadata: {
          used: true,
          status: "ok",
          provider: documentResult.metadata.provider,
          model: documentResult.metadata.model,
          dtype: documentResult.metadata.dtype,
          dimension: documentResult.metadata.dimension,
          normalized: true,
          queryInstructionApplied: true,
          cache: {
            hits: queryResult.metadata.cacheHits + documentResult.metadata.cacheHits,
            misses: queryResult.metadata.cacheMisses + documentResult.metadata.cacheMisses,
          },
          durationMs: queryResult.metadata.durationMs + documentResult.metadata.durationMs,
        },
      };
    } catch (error) {
      return { items: fallbackItems, metadata: { used: false, status: "fallback", reason: error instanceof Error ? error.message : String(error) } };
    }
  }
}

let defaultReranker;
export function getEmbeddingReranker() {
  defaultReranker ??= new EmbeddingReranker();
  return defaultReranker;
}

export async function getEmbeddingStatus({ loadModel = false } = {}, { reranker = getEmbeddingReranker() } = {}) {
  let healthCheck = null;
  if (loadModel && reranker.enabled) {
    const result = await reranker.rerank("设备异常噪声", [{ text: "轴承磨损可能引起异常噪声" }]);
    healthCheck = { status: result.metadata.status, used: result.metadata.used, reason: result.metadata.reason ?? null };
  }
  return { configured: reranker.enabled, ...reranker.provider.status(), healthCheck };
}

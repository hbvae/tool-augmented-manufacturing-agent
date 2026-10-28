import assert from "node:assert/strict";
import test from "node:test";
import {
  ExternalContentService,
  SearchSnippetContentProvider,
  TavilyExtractProvider,
  analyzeExternalConsensus,
  chunkExternalText,
  crossCheckExternalSources,
  fetchExternalDocument,
  rankExternalChunks,
} from "../src/external_content.mjs";

const fixedNow = new Date("2026-10-03T00:00:00.000Z");

function response(payload, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test("Tavily Extract adapter uses fixed endpoint and handles partial success", async () => {
  let request;
  const provider = new TavilyExtractProvider({
    apiKey: "tvly-test",
    clock: () => fixedNow,
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return response({
        request_id: "extract-1",
        response_time: 0.5,
        usage: { credits: 1 },
        results: [{ url: "https://www.nist.gov/guide", raw_content: "# Guide\n\nBearing vibration inspection guidance." }],
        failed_results: [{ url: "https://example.com/fail", error: "Unavailable" }],
      });
    },
  });
  const result = await provider.extract({ urls: ["https://www.nist.gov/guide", "https://example.com/fail"], extractDepth: "basic" });
  assert.equal(request.url, "https://api.tavily.com/extract");
  assert.equal(request.options.headers.Authorization, "Bearer tvly-test");
  assert.equal(request.body.include_images, false);
  assert.equal(result.documents[0].domain, "www.nist.gov");
  assert.equal(result.failures.length, 1);
  assert.equal(result.requestId, "extract-1");
});

test("Tavily Extract adapter blocks unsafe URLs before provider call", async () => {
  const provider = new TavilyExtractProvider({ apiKey: "tvly-test", fetchImpl: async () => { throw new Error("must not run"); } });
  await assert.rejects(() => provider.extract({ urls: ["http://127.0.0.1/admin"] }), (error) => error.code === "UNSAFE_EXTERNAL_URL");
});

test("search snippet content provider reuses cached Baidu excerpts without network access", async () => {
  const provider = new SearchSnippetContentProvider({
    clock: () => fixedNow,
    searchService: {
      findCachedResult(url) {
        return url === "https://example.com/guide"
          ? { value: { excerpt: "主轴异常噪声检查润滑、轴承和振动。" }, provider: "baidu" }
          : null;
      },
    },
  });
  const result = await provider.extract({ urls: ["https://example.com/guide", "https://example.com/missing"] });
  assert.equal(result.provider, "search_snippet");
  assert.equal(result.documents.length, 1);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.usage, { externalRequests: 0 });
});

test("long text is split into bounded overlapping chunks", () => {
  const text = `${"轴承振动检查。".repeat(80)}\n\n${"润滑状态检查。".repeat(80)}`;
  const result = chunkExternalText(text, { chunkSize: 500, chunkOverlap: 50, maxChunks: 20 });
  assert.ok(result.chunks.length > 2);
  assert.ok(result.chunks.every((chunk) => chunk.characterCount <= 500));
  assert.equal(result.chunkSize, 500);
  assert.equal(new Set(result.chunks.map((chunk) => chunk.contentHash)).size, result.chunks.length);
});

test("query ranking selects the relevant document chunk", () => {
  const chunks = chunkExternalText("库存管理基础。\n\n主轴轴承异常噪声通常需要检查润滑和振动。\n\n供应商交付管理。", { chunkSize: 300, chunkOverlap: 0 }).chunks;
  const ranked = rankExternalChunks("主轴轴承异常噪声", chunks, 1);
  assert.match(ranked[0].text, /主轴轴承异常噪声/);
  assert.ok(ranked[0].relevanceScore > 0);
});

test("fetchExternalDocument returns hashes and chunks without full text by default", async () => {
  const contentService = {
    async extract() {
      return { provider: "mock", extractedAt: fixedNow.toISOString(), requestId: "extract-2", responseTimeSeconds: 0.2, usage: { credits: 1 }, cache: { hit: false }, failures: [], documents: [{ url: "https://example.com/manual", domain: "example.com", content: "# Manual\n\n主轴轴承异常噪声通常需要检查润滑状态和振动。" }] };
    },
  };
  const result = await fetchExternalDocument({ url: "https://example.com/manual", query: "主轴异常噪声", chunkSize: 300, maxChunks: 5, semanticRerank: false }, { contentService });
  assert.equal(result.document.chunking.totalChunks, 1);
  assert.equal(result.document.contentHash.length, 32);
  assert.equal(result.document.text, undefined);
  assert.equal(result.dataAvailable, true);
});

test("uncached search-snippet URL returns governed insufficiency instead of a tool error", async () => {
  const contentService = {
    async extract() {
      return {
        provider: "search_snippet", extractedAt: fixedNow.toISOString(), requestId: null,
        responseTimeSeconds: null, usage: { externalRequests: 0 }, cache: { hit: false },
        documents: [], failures: [{ url: "https://eur-lex.europa.eu/example", error: "not cached" }],
      };
    },
  };
  const result = await fetchExternalDocument({ url: "https://eur-lex.europa.eu/example", query: "battery regulation" }, { contentService });
  assert.equal(result.dataAvailable, false);
  assert.equal(result.returned, 0);
  assert.equal(result.document, null);
  assert.equal(result.embedding.status, "no_cached_search_result");
});

test("fetchExternalDocument retries a failed EUR-Lex CELEX page with the official ELI URL", async () => {
  const calls = [];
  const contentService = {
    async extract(options) {
      calls.push(options.urls[0]);
      if (calls.length === 1) {
        return { provider: "mock", failures: [{ url: options.urls[0], error: "Failed to fetch url" }], documents: [] };
      }
      return {
        provider: "mock", extractedAt: fixedNow.toISOString(), requestId: "extract-eli", responseTimeSeconds: 0.2,
        usage: { credits: 1 }, cache: { hit: false }, failures: [],
        documents: [{ url: options.urls[0], domain: "eur-lex.europa.eu", content: "Regulation EU 2023/1542 battery passport requirements." }],
      };
    },
  };
  const result = await fetchExternalDocument({
    url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32023R1542",
    query: "battery passport", chunkSize: 300, maxChunks: 5, semanticRerank: false,
  }, { contentService });
  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://eur-lex.europa.eu/eli/reg/2023/1542/oj/eng");
  assert.equal(result.fallbackUrl, calls[1]);
  assert.equal(result.dataAvailable, true);
});

test("external content cache can be disabled", async () => {
  let calls = 0;
  const provider = { async extract() { calls += 1; return { provider: "mock", documents: [], failures: [] }; } };
  const service = new ExternalContentService({ provider, cacheTtlMs: 0, clock: () => fixedNow });
  await service.extract({ urls: ["https://example.com/manual"] });
  await service.extract({ urls: ["https://example.com/manual"] });
  assert.equal(calls, 2);
});

test("consensus analysis distinguishes corroboration and candidate conflicts", () => {
  const documents = [
    { domain: "a.example", url: "https://a.example/guide", chunks: [{ text: "The bearing temperature limit is 80°C. Bearing vibration inspection is required." }] },
    { domain: "b.example", url: "https://b.example/manual", chunks: [{ text: "The bearing temperature limit is 90°C. Bearing vibration inspection is required." }] },
  ];
  const result = analyzeExternalConsensus("bearing temperature limit vibration inspection", documents);
  assert.equal(result.independentSourceCount, 2);
  assert.ok(result.potentialConflicts.some((item) => item.type === "potential_numeric_conflict"));
  assert.ok(result.corroborations.length > 0);
  assert.equal(result.status, "potential_conflicts_found");
});

test("crossCheckExternalSources combines search, extraction, chunking, and review", async () => {
  const searchService = {
    async search(options) {
      return { provider: "mock", query: options.query, searchedAt: fixedNow.toISOString(), requestId: "search-1", usage: { credits: 1 }, cache: { hit: false }, results: [
        { title: "Guide A", url: "https://a.example/guide", domain: "a.example", excerpt: "bearing vibration inspection", providerScore: 0.9, publishedAt: null },
        { title: "Guide B", url: "https://b.example/guide", domain: "b.example", excerpt: "bearing vibration inspection", providerScore: 0.8, publishedAt: null },
      ] };
    },
  };
  const contentService = {
    async extract() {
      return { provider: "mock", extractedAt: fixedNow.toISOString(), requestId: "extract-3", usage: { credits: 1 }, cache: { hit: false }, failures: [], documents: [
        { url: "https://a.example/guide", domain: "a.example", content: "Bearing vibration inspection should include lubrication checks." },
        { url: "https://b.example/guide", domain: "b.example", content: "Bearing vibration inspection should include lubrication checks." },
      ] };
    },
  };
  const result = await crossCheckExternalSources({ query: "bearing vibration inspection lubrication", maxDocuments: 2, candidateCount: 2, chunkSize: 300, semanticRerank: false }, { searchService, contentService, clock: () => fixedNow });
  assert.equal(result.returned, 2);
  assert.equal(result.consensus.independentSourceCount, 2);
  assert.equal(result.consensus.status, "partially_corroborated");
});

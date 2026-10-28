import assert from "node:assert/strict";
import test from "node:test";
import {
  BaiduSearchProvider,
  ExternalSearchService,
  FallbackSearchProvider,
  TavilySearchProvider,
  createExternalSearchProviderFromEnv,
  fitBaiduQuery,
  normalizeCountry,
  retrieveExternalEvidence,
  safeExternalUrl,
  searchExternalSources,
} from "../src/external_search.mjs";

const fixedNow = new Date("2026-10-03T00:00:00.000Z");

function response(payload, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test("safeExternalUrl accepts public HTTP URLs and rejects local targets", () => {
  assert.equal(safeExternalUrl("https://www.nist.gov/example#section"), "https://www.nist.gov/example");
  assert.equal(safeExternalUrl("http://127.0.0.1/admin"), null);
  assert.equal(safeExternalUrl("http://169.254.169.254/latest/meta-data"), null);
  assert.equal(safeExternalUrl("http://[::1]/admin"), null);
  assert.equal(safeExternalUrl("file:///etc/passwd"), null);
});

test("Tavily adapter sends governed request and normalizes results", async () => {
  let request;
  const provider = new TavilySearchProvider({
    apiKey: "tvly-test",
    clock: () => fixedNow,
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return response({
        request_id: "req-1",
        response_time: "0.42",
        usage: { credits: 1 },
        results: [
          { title: "NIST maintenance guide", url: "https://www.nist.gov/maintenance#guide", content: "Predictive maintenance guidance", score: 0.91, published_date: "2026-09-01" },
          { title: "Unsafe", url: "http://127.0.0.1/private", content: "ignore", score: 1 },
        ],
      });
    },
  });

  const result = await provider.search({
    query: "predictive maintenance",
    includeDomains: ["nist.gov"],
    freshnessDays: 30,
    maxResults: 5,
    language: "zh",
    country: "cn",
  });
  assert.equal(request.url, "https://api.tavily.com/search");
  assert.equal(request.options.headers.Authorization, "Bearer tvly-test");
  assert.equal(request.body.include_answer, false);
  assert.equal(request.body.include_raw_content, false);
  assert.deepEqual(request.body.include_domains, ["nist.gov"]);
  assert.equal(request.body.language, "zh-cn");
  assert.equal(request.body.country, "china");
  assert.equal(request.body.start_date, "2026-09-03");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].domain, "www.nist.gov");
  assert.equal(result.requestId, "req-1");
  assert.equal(result.attemptCount, 1);
});

test("Baidu adapter maps governed options and normalizes references", async () => {
  let request;
  const provider = new BaiduSearchProvider({
    apiKey: "baidu-test",
    clock: () => fixedNow,
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return response({
        request_id: "baidu-1",
        references: [
          { title: "工信部新能源汽车信息", url: "https://www.miit.gov.cn/example", snippet: "新能源汽车产业公开信息", date: "2026-09-15" },
          { title: "Unsafe", url: "http://127.0.0.1/private", snippet: "ignore" },
        ],
      });
    },
  });
  const result = await provider.search({
    query: "新能源汽车发展趋势",
    searchDepth: "advanced",
    maxResults: 5,
    includeDomains: ["miit.gov.cn"],
    excludeDomains: ["example.com"],
    freshnessDays: 30,
    country: "cn",
  });
  assert.equal(request.url, "https://qianfan.baidubce.com/v2/ai_search/web_search");
  assert.equal(request.options.headers.Authorization, "Bearer baidu-test");
  assert.equal(request.body.search_source, "baidu_search_v2");
  assert.equal(request.body.edition, "standard");
  assert.deepEqual(request.body.resource_type_filter, [{ type: "web", top_k: 5 }]);
  assert.deepEqual(request.body.search_filter.match.site, ["miit.gov.cn"]);
  assert.deepEqual(request.body.search_filter.range.page_time, { gte: "2026-09-03", lte: "2026-10-03" });
  assert.deepEqual(request.body.block_websites, ["example.com"]);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].domain, "www.miit.gov.cn");
  assert.equal(result.provider, "baidu");
});

test("Baidu query fitting respects the documented 72-unit limit", () => {
  const fitted = fitBaiduQuery("新能源".repeat(30));
  assert.equal(fitted.units, 72);
  assert.equal(fitted.query.length, 36);
  assert.equal(fitted.truncated, true);
});

test("Baidu adapter retries transient provider errors", async () => {
  let calls = 0;
  const provider = new BaiduSearchProvider({
    apiKey: "baidu-test", maxRetries: 1, sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? response({ code: 502, message: "busy" }, { status: 500 }) : response({ request_id: "ok", references: [] });
    },
  });
  const result = await provider.search({ query: "设备维护" });
  assert.equal(calls, 2);
  assert.equal(result.attemptCount, 2);
});

test("provider factory and fallback preserve the actual provider", async () => {
  assert.equal(createExternalSearchProviderFromEnv({ MANUFACTURING_EXTERNAL_SEARCH_PROVIDER: "baidu", BAIDU_AI_SEARCH_API_KEY: "key" }).name, "baidu");
  assert.throws(() => createExternalSearchProviderFromEnv({ MANUFACTURING_EXTERNAL_SEARCH_PROVIDER: "unknown" }), (error) => error.code === "EXTERNAL_SEARCH_PROVIDER_INVALID");
  const fallback = new FallbackSearchProvider({
    primary: new BaiduSearchProvider({ apiKey: "", fetchImpl: async () => { throw new Error("must not run"); } }),
    fallback: { name: "tavily", async search(options) { return { provider: "tavily", query: options.query, results: [] }; } },
  });
  const result = await fallback.search({ query: "test" });
  assert.equal(result.provider, "tavily");
  assert.equal(result.fallback.used, true);
});

test("Tavily adapter retries transient network errors and records attempts", async () => {
  let calls = 0;
  const delays = [];
  const provider = new TavilySearchProvider({
    apiKey: "tvly-test",
    maxRetries: 2,
    retryBaseDelayMs: 500,
    sleep: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return response({ request_id: "retry-success", results: [] });
    },
  });
  const result = await provider.search({ query: "foundry supplier audit" });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [500]);
  assert.equal(result.attemptCount, 2);
});

test("Tavily adapter reports the final attempt count when network retries are exhausted", async () => {
  let calls = 0;
  const provider = new TavilySearchProvider({
    apiKey: "tvly-test", maxRetries: 2, sleep: async () => {},
    fetchImpl: async () => { calls += 1; throw new TypeError("fetch failed"); },
  });
  await assert.rejects(
    () => provider.search({ query: "foundry supplier audit" }),
    (error) => error.code === "EXTERNAL_SEARCH_NETWORK_ERROR" && error.details.attemptCount === 3,
  );
  assert.equal(calls, 3);
});

test("Tavily adapter retries 429 and 5xx but not deterministic 4xx errors", async () => {
  let retryableCalls = 0;
  const retryable = new TavilySearchProvider({
    apiKey: "tvly-test", maxRetries: 2, sleep: async () => {},
    fetchImpl: async () => {
      retryableCalls += 1;
      if (retryableCalls === 1) return response({ detail: "busy" }, { status: 503 });
      if (retryableCalls === 2) return response({ detail: "limited" }, { status: 429 });
      return response({ request_id: "recovered", results: [] });
    },
  });
  const recovered = await retryable.search({ query: "test" });
  assert.equal(recovered.attemptCount, 3);
  assert.equal(retryableCalls, 3);

  let badRequestCalls = 0;
  const badRequest = new TavilySearchProvider({
    apiKey: "tvly-test", maxRetries: 2, sleep: async () => {},
    fetchImpl: async () => { badRequestCalls += 1; return response({ detail: "bad request" }, { status: 400 }); },
  });
  await assert.rejects(
    () => badRequest.search({ query: "test" }),
    (error) => error.code === "EXTERNAL_SEARCH_PROVIDER_ERROR" && error.details.attemptCount === 1,
  );
  assert.equal(badRequestCalls, 1);
});

test("country normalization accepts ISO aliases and Tavily English names", () => {
  assert.equal(normalizeCountry("cn"), "china");
  assert.equal(normalizeCountry("US"), "united states");
  assert.equal(normalizeCountry("china"), "china");
  assert.equal(normalizeCountry(undefined), undefined);
});

test("country is rejected locally for non-general topics", async () => {
  const provider = new TavilySearchProvider({ apiKey: "tvly-test", fetchImpl: async () => { throw new Error("must not run"); } });
  await assert.rejects(
    () => provider.search({ query: "factory news", topic: "news", country: "cn" }),
    (error) => error.code === "INVALID_EXTERNAL_COUNTRY" && /topic is general/.test(error.message),
  );
});

test("Tavily provider errors retain bounded diagnostic detail", async () => {
  const provider = new TavilySearchProvider({
    apiKey: "tvly-test",
    fetchImpl: async () => response({ detail: { error: "Invalid country value" } }, { status: 400 }),
  });
  await assert.rejects(
    () => provider.search({ query: "test" }),
    (error) => error.code === "EXTERNAL_SEARCH_PROVIDER_ERROR"
      && error.details.status === 400
      && error.details.attemptCount === 1
      && error.details.providerMessage === "Invalid country value",
  );
});

test("Tavily adapter reports missing API key without making a request", async () => {
  const provider = new TavilySearchProvider({ apiKey: "", fetchImpl: async () => { throw new Error("must not run"); } });
  await assert.rejects(() => provider.search({ query: "test" }), (error) => error.code === "EXTERNAL_SEARCH_NOT_CONFIGURED");
});

test("external search service caches identical requests", async () => {
  let calls = 0;
  const provider = {
    async search(options) {
      calls += 1;
      return { provider: "mock", query: options.query, searchedAt: fixedNow.toISOString(), requestId: "mock-1", results: [] };
    },
  };
  const service = new ExternalSearchService({ provider, cacheTtlMs: 60_000, clock: () => fixedNow });
  const first = await searchExternalSources({ query: "bearing fault" }, { service });
  const second = await searchExternalSources({ query: "bearing fault" }, { service });
  assert.equal(calls, 1);
  assert.equal(first.cache.hit, false);
  assert.equal(second.cache.hit, true);
});

test("external search cache can be disabled", async () => {
  let calls = 0;
  const provider = { async search(options) { calls += 1; return { provider: "mock", query: options.query, searchedAt: fixedNow.toISOString(), results: [] }; } };
  const service = new ExternalSearchService({ provider, cacheTtlMs: 0, clock: () => fixedNow });
  await service.search({ query: "bearing fault" });
  await service.search({ query: "bearing fault" });
  assert.equal(calls, 2);
});

test("retrieveExternalEvidence returns transparent ranked evidence", async () => {
  const provider = {
    async search(options) {
      return {
        provider: "mock",
        query: options.query,
        searchedAt: fixedNow.toISOString(),
        requestId: "mock-2",
        results: [
          { title: "Bearing fault diagnosis", url: "https://www.nist.gov/bearing", domain: "www.nist.gov", excerpt: "bearing fault vibration diagnosis", providerScore: 0.8, publishedAt: "2026-09-01T00:00:00.000Z" },
          { title: "Unrelated article", url: "https://example.com/article", domain: "example.com", excerpt: "general article", providerScore: 0.9, publishedAt: null },
        ],
      };
    },
  };
  const service = new ExternalSearchService({ provider, cacheTtlMs: 0, clock: () => fixedNow });
  const result = await retrieveExternalEvidence({ query: "bearing fault diagnosis", candidateCount: 10, topK: 2, semanticRerank: false }, { service, clock: () => fixedNow });
  assert.equal(result.evidence[0].domain, "www.nist.gov");
  assert.equal(result.evidence[0].evidenceId, "EXT-001");
  assert.equal(result.ranking.method, "deterministic_evidence_ranking_v1");
  assert.equal(result.returned, 2);
});

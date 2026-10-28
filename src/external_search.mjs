import { DataToolError } from "./database.mjs";
import { getEmbeddingReranker } from "./embedding.mjs";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const BAIDU_SEARCH_URL = "https://qianfan.baidubce.com/v2/ai_search/web_search";
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const MAX_CONTENT_CHARACTERS = 4_000;
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const COUNTRY_CODE_OVERRIDES = Object.freeze({
  ae: "united arab emirates",
  bn: "brunei",
  bo: "bolivia",
  cd: "congo",
  cg: "congo",
  cn: "china",
  cv: "cape verde",
  cz: "czech republic",
  do: "dominican republic",
  gb: "united kingdom",
  kp: "north korea",
  kr: "south korea",
  md: "moldova",
  mk: "north macedonia",
  ru: "russia",
  tr: "turkey",
  tw: "taiwan",
  tz: "tanzania",
  uk: "united kingdom",
  us: "united states",
  ve: "venezuela",
  vn: "vietnam",
});

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(Math.max(Number(value) || 0, minimum), maximum);
}

function round(value, digits = 4) {
  return Number(Number(value).toFixed(digits));
}

function normalizeDomain(value) {
  const domain = String(value ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!domain || domain.length > 253 || !/^(?:[a-z0-9\u4e00-\u9fff](?:[a-z0-9\u4e00-\u9fff-]{0,61}[a-z0-9\u4e00-\u9fff])?\.)*[a-z0-9\u4e00-\u9fff](?:[a-z0-9\u4e00-\u9fff-]{0,61}[a-z0-9\u4e00-\u9fff])?$/.test(domain)) {
    throw new DataToolError("INVALID_EXTERNAL_DOMAIN", `Invalid external-search domain: ${value}`);
  }
  return domain;
}

function normalizeDomains(values = []) {
  return [...new Set(values.map(normalizeDomain))].slice(0, 20);
}

export function normalizeCountry(value, topic = "general") {
  if (value == null || String(value).trim() === "") return undefined;
  if (topic !== "general") {
    throw new DataToolError("INVALID_EXTERNAL_COUNTRY", "country is supported only when topic is general", { topic });
  }
  const requested = String(value).trim().toLowerCase();
  if (/^[a-z]{2}$/.test(requested)) {
    const resolved = COUNTRY_CODE_OVERRIDES[requested]
      || regionNames.of(requested.toUpperCase())?.toLowerCase();
    if (!resolved || resolved.toLowerCase() === requested) {
      throw new DataToolError("INVALID_EXTERNAL_COUNTRY", `Unknown ISO country code: ${value}`);
    }
    return resolved;
  }
  if (!/^[a-z][a-z .'-]{1,63}$/.test(requested)) {
    throw new DataToolError("INVALID_EXTERNAL_COUNTRY", "country must be a two-letter code or an English country name");
  }
  return requested;
}

function normalizeLanguage(value) {
  const language = String(value || "zh-cn").trim().toLowerCase().replaceAll("_", "-");
  return language === "zh" ? "zh-cn" : language;
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] >= 224;
}

export function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return null;
    if (isPrivateIpv4(hostname) || hostname === "::" || hostname === "::1" || hostname.startsWith("::ffff:") || hostname.startsWith("fe80:") || /^f[cd]/.test(hostname)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeOptions(options = {}) {
  const query = String(options.query ?? "").trim().replace(/\s+/g, " ");
  if (!query) throw new DataToolError("INVALID_EXTERNAL_QUERY", "query is required");
  if (query.length > 600) throw new DataToolError("INVALID_EXTERNAL_QUERY", "query must not exceed 600 characters");
  const topic = options.topic === "news" ? "news" : "general";
  return {
    query,
    topic,
    searchDepth: options.searchDepth === "advanced" ? "advanced" : "basic",
    maxResults: Math.min(Math.max(Number(options.maxResults) || 10, 1), 20),
    language: normalizeLanguage(options.language),
    country: normalizeCountry(options.country, topic),
    freshnessDays: options.freshnessDays == null ? undefined : Math.min(Math.max(Number(options.freshnessDays) || 1, 1), 3650),
    includeDomains: normalizeDomains(options.includeDomains),
    excludeDomains: normalizeDomains(options.excludeDomains),
    safeSearch: options.safeSearch !== false,
  };
}

function baiduQueryUnits(character) {
  return /[^\x00-\xff]/u.test(character) ? 2 : 1;
}

export function fitBaiduQuery(value, maximumUnits = 72) {
  const original = String(value ?? "").trim().replace(/\s+/g, " ");
  let query = "";
  let units = 0;
  for (const character of original) {
    const weight = baiduQueryUnits(character);
    if (units + weight > maximumUnits) break;
    query += character;
    units += weight;
  }
  return { query: query.trim(), units, truncated: query.length < original.length };
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function normalizeResult(item) {
  const url = safeExternalUrl(item?.url);
  if (!url) return null;
  const parsed = new URL(url);
  const publishedAt = item?.published_date ? new Date(item.published_date) : null;
  return {
    title: String(item?.title || parsed.hostname).trim().slice(0, 500),
    url,
    domain: parsed.hostname.toLowerCase(),
    excerpt: String(item?.content || "").trim().slice(0, MAX_CONTENT_CHARACTERS),
    providerScore: round(clamp(item?.score)),
    publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt.toISOString() : null,
  };
}

function normalizeBaiduResult(item, index, total) {
  const url = safeExternalUrl(item?.url);
  if (!url) return null;
  const parsed = new URL(url);
  const rawDate = item?.date || item?.published_date || item?.publish_time;
  const publishedAt = rawDate ? new Date(rawDate) : null;
  const providerScore = item?.score == null
    ? clamp(1 - (index / Math.max(total, 1)) * 0.5, 0.5, 1)
    : clamp(item.score);
  return {
    title: String(item?.title || parsed.hostname).trim().slice(0, 500),
    url,
    domain: parsed.hostname.toLowerCase(),
    excerpt: String(item?.content || item?.snippet || "").trim().slice(0, MAX_CONTENT_CHARACTERS),
    providerScore: round(providerScore),
    publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt.toISOString() : null,
  };
}

export class ExternalSearchProvider {
  constructor(name) {
    this.name = name;
  }

  async search() {
    throw new Error("ExternalSearchProvider.search must be implemented");
  }
}

function providerErrorCode(status) {
  if (status === 401 || status === 403) return "EXTERNAL_SEARCH_AUTH_FAILED";
  if (status === 429) return "EXTERNAL_SEARCH_RATE_LIMITED";
  return "EXTERNAL_SEARCH_PROVIDER_ERROR";
}

function providerMessage(payload) {
  const value = payload?.message ?? payload?.msg ?? payload?.error ?? payload?.detail?.error ?? payload?.detail;
  return typeof value === "string" ? value.slice(0, 500) : undefined;
}

class RetryingSearchProvider extends ExternalSearchProvider {
  constructor(name, { fetchImpl, timeoutMs, maxRetries, retryBaseDelayMs, sleep, clock } = {}) {
    super(name);
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.timeoutMs = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000), 60_000);
    this.maxRetries = Math.min(Math.max(Number.isFinite(Number(maxRetries)) ? Math.floor(Number(maxRetries)) : DEFAULT_MAX_RETRIES, 0), 5);
    this.retryBaseDelayMs = Math.min(Math.max(Number.isFinite(Number(retryBaseDelayMs)) ? Number(retryBaseDelayMs) : DEFAULT_RETRY_BASE_DELAY_MS, 0), 10_000);
    this.sleep = sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.clock = clock ?? (() => new Date());
  }

  async waitBeforeRetry(attempt, response) {
    const retryAfter = response?.headers?.get?.("retry-after");
    const retryAfterSeconds = Number(retryAfter);
    const requestedDelay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? retryAfterSeconds * 1_000
      : this.retryBaseDelayMs * (2 ** Math.max(attempt - 1, 0));
    await this.sleep(Math.min(requestedDelay, 10_000));
  }
}

export class TavilySearchProvider extends RetryingSearchProvider {
  constructor({
    apiKey = process.env.TAVILY_API_KEY,
    fetchImpl = globalThis.fetch,
    timeoutMs = Number(process.env.MANUFACTURING_EXTERNAL_SEARCH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    maxRetries = Number(process.env.MANUFACTURING_EXTERNAL_SEARCH_MAX_RETRIES ?? DEFAULT_MAX_RETRIES),
    retryBaseDelayMs = Number(process.env.MANUFACTURING_EXTERNAL_SEARCH_RETRY_BASE_DELAY_MS ?? DEFAULT_RETRY_BASE_DELAY_MS),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    clock = () => new Date(),
  } = {}) {
    super("tavily", { fetchImpl, timeoutMs, maxRetries, retryBaseDelayMs, sleep, clock });
    this.apiKey = String(apiKey || "").trim();
  }

  async search(rawOptions) {
    if (!this.apiKey) {
      throw new DataToolError("EXTERNAL_SEARCH_NOT_CONFIGURED", "TAVILY_API_KEY is not configured. Add it to the MCP server environment and restart the client.");
    }
    if (typeof this.fetchImpl !== "function") throw new DataToolError("EXTERNAL_SEARCH_UNAVAILABLE", "The Node.js fetch API is unavailable");
    const options = normalizeOptions(rawOptions);
    const now = this.clock();
    const body = {
      query: options.query,
      topic: options.topic,
      search_depth: options.searchDepth,
      max_results: options.maxResults,
      include_answer: false,
      include_raw_content: false,
      include_published_date: true,
      safe_search: options.safeSearch,
      language: options.language,
      filter_by_language: true,
    };
    if (options.country) body.country = options.country;
    if (options.includeDomains.length) body.include_domains = options.includeDomains;
    if (options.excludeDomains.length) body.exclude_domains = options.excludeDomains;
    if (options.freshnessDays) {
      const start = new Date(now);
      start.setUTCDate(start.getUTCDate() - options.freshnessDays);
      body.start_date = isoDate(start);
      body.end_date = isoDate(now);
      body.filter_by_published_date = true;
    }

    const maxAttempts = this.maxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      let response;
      try {
        response = await this.fetchImpl(TAVILY_SEARCH_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        const timedOut = error?.name === "AbortError";
        if (attempt < maxAttempts) {
          await this.waitBeforeRetry(attempt);
          continue;
        }
        throw new DataToolError(
          timedOut ? "EXTERNAL_SEARCH_TIMEOUT" : "EXTERNAL_SEARCH_NETWORK_ERROR",
          timedOut ? `Tavily search exceeded ${this.timeoutMs} ms` : `Tavily search failed: ${error instanceof Error ? error.message : String(error)}`,
          { attemptCount: attempt },
        );
      } finally {
        clearTimeout(timeout);
      }

      let payload;
      try { payload = await response.json(); }
      catch {
        if (response.status >= 500 && attempt < maxAttempts) {
          await this.waitBeforeRetry(attempt, response);
          continue;
        }
        throw new DataToolError("EXTERNAL_SEARCH_INVALID_RESPONSE", `Tavily returned non-JSON data (HTTP ${response.status})`, {
          status: response.status,
          attemptCount: attempt,
        });
      }
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < maxAttempts) {
          await this.waitBeforeRetry(attempt, response);
          continue;
        }
        const code = providerErrorCode(response.status);
        const message = providerMessage(payload);
        throw new DataToolError(code, `Tavily request failed (HTTP ${response.status})`, {
          status: response.status,
          attemptCount: attempt,
          ...(message ? { providerMessage: message } : {}),
        });
      }

      const results = Array.isArray(payload?.results) ? payload.results.map(normalizeResult).filter(Boolean) : [];
      return {
        provider: this.name,
        query: options.query,
        searchedAt: now.toISOString(),
        requestId: payload?.request_id ?? null,
        responseTimeSeconds: Number(payload?.response_time) || null,
        usage: payload?.usage ?? null,
        attemptCount: attempt,
        results,
      };
    }
    throw new DataToolError("EXTERNAL_SEARCH_NETWORK_ERROR", "Tavily search retry loop ended unexpectedly");
  }
}

export class BaiduSearchProvider extends RetryingSearchProvider {
  constructor({
    apiKey = process.env.BAIDU_AI_SEARCH_API_KEY,
    fetchImpl = globalThis.fetch,
    timeoutMs = Number(process.env.MANUFACTURING_EXTERNAL_SEARCH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    maxRetries = Number(process.env.MANUFACTURING_EXTERNAL_SEARCH_MAX_RETRIES ?? DEFAULT_MAX_RETRIES),
    retryBaseDelayMs = Number(process.env.MANUFACTURING_EXTERNAL_SEARCH_RETRY_BASE_DELAY_MS ?? DEFAULT_RETRY_BASE_DELAY_MS),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    clock = () => new Date(),
  } = {}) {
    super("baidu", { fetchImpl, timeoutMs, maxRetries, retryBaseDelayMs, sleep, clock });
    this.apiKey = String(apiKey || "").trim();
  }

  async search(rawOptions) {
    if (!this.apiKey) {
      throw new DataToolError("EXTERNAL_SEARCH_NOT_CONFIGURED", "BAIDU_AI_SEARCH_API_KEY is not configured. Add it to the MCP server environment and restart the client.");
    }
    if (typeof this.fetchImpl !== "function") throw new DataToolError("EXTERNAL_SEARCH_UNAVAILABLE", "The Node.js fetch API is unavailable");
    const options = normalizeOptions(rawOptions);
    const now = this.clock();
    const fitted = fitBaiduQuery(options.query);
    if (!fitted.query) throw new DataToolError("INVALID_EXTERNAL_QUERY", "query is empty after Baidu query normalization");
    const body = {
      messages: [{ role: "user", content: fitted.query }],
      search_source: "baidu_search_v2",
      edition: "standard",
      resource_type_filter: [{ type: "web", top_k: options.maxResults }],
      query_policy: { enable_rewrite: true },
      safe_search: options.safeSearch,
    };
    if (options.includeDomains.length || options.freshnessDays) {
      body.search_filter = {};
      if (options.includeDomains.length) body.search_filter.match = { site: options.includeDomains };
      if (options.freshnessDays) {
        const start = new Date(now);
        start.setUTCDate(start.getUTCDate() - options.freshnessDays);
        body.search_filter.range = { page_time: { gte: isoDate(start), lte: isoDate(now) } };
      }
    }
    if (options.excludeDomains.length) body.block_websites = options.excludeDomains;

    const maxAttempts = this.maxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      let response;
      try {
        response = await this.fetchImpl(BAIDU_SEARCH_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        const timedOut = error?.name === "AbortError";
        if (attempt < maxAttempts) {
          await this.waitBeforeRetry(attempt);
          continue;
        }
        throw new DataToolError(
          timedOut ? "EXTERNAL_SEARCH_TIMEOUT" : "EXTERNAL_SEARCH_NETWORK_ERROR",
          timedOut ? `Baidu AI Search exceeded ${this.timeoutMs} ms` : `Baidu AI Search failed: ${error instanceof Error ? error.message : String(error)}`,
          { attemptCount: attempt },
        );
      } finally {
        clearTimeout(timeout);
      }
      let payload;
      try { payload = await response.json(); }
      catch {
        if (response.status >= 500 && attempt < maxAttempts) {
          await this.waitBeforeRetry(attempt, response);
          continue;
        }
        throw new DataToolError("EXTERNAL_SEARCH_INVALID_RESPONSE", `Baidu AI Search returned non-JSON data (HTTP ${response.status})`, { status: response.status, attemptCount: attempt });
      }
      if (!response.ok || (payload?.code != null && Number(payload.code) !== 0)) {
        const status = Number(response.status) || 500;
        const retryable = status === 429 || status >= 500 || [501, 502].includes(Number(payload?.code));
        if (retryable && attempt < maxAttempts) {
          await this.waitBeforeRetry(attempt, response);
          continue;
        }
        const message = providerMessage(payload);
        throw new DataToolError(providerErrorCode(status), `Baidu AI Search request failed (HTTP ${status})`, {
          status,
          providerCode: payload?.code ?? null,
          attemptCount: attempt,
          ...(message ? { providerMessage: message } : {}),
        });
      }
      const references = Array.isArray(payload?.references) ? payload.references : [];
      const results = references.map((item, index) => normalizeBaiduResult(item, index, references.length)).filter(Boolean);
      return {
        provider: this.name,
        query: options.query,
        providerQuery: fitted.query,
        queryTruncated: fitted.truncated,
        searchedAt: now.toISOString(),
        requestId: payload?.request_id ?? null,
        responseTimeSeconds: null,
        usage: { calls: 1 },
        attemptCount: attempt,
        results,
      };
    }
    throw new DataToolError("EXTERNAL_SEARCH_NETWORK_ERROR", "Baidu AI Search retry loop ended unexpectedly");
  }
}

export class FallbackSearchProvider extends ExternalSearchProvider {
  constructor({ primary = new BaiduSearchProvider(), fallback = new TavilySearchProvider() } = {}) {
    super("baidu_fallback");
    this.primary = primary;
    this.fallback = fallback;
  }

  async search(options) {
    try {
      return await this.primary.search(options);
    } catch (error) {
      if (!(error instanceof DataToolError) || error.code === "INVALID_EXTERNAL_QUERY" || error.code === "INVALID_EXTERNAL_DOMAIN" || error.code === "INVALID_EXTERNAL_COUNTRY") throw error;
      const result = await this.fallback.search(options);
      return { ...result, fallback: { used: true, from: this.primary.name, to: this.fallback.name, reasonCode: error.code } };
    }
  }
}

export function createExternalSearchProviderFromEnv(environment = process.env) {
  const requested = String(environment.MANUFACTURING_EXTERNAL_SEARCH_PROVIDER || "tavily").trim().toLowerCase();
  if (requested === "tavily") return new TavilySearchProvider({ apiKey: environment.TAVILY_API_KEY });
  if (requested === "baidu") return new BaiduSearchProvider({ apiKey: environment.BAIDU_AI_SEARCH_API_KEY });
  if (["baidu_fallback", "baidu-fallback"].includes(requested)) {
    return new FallbackSearchProvider({
      primary: new BaiduSearchProvider({ apiKey: environment.BAIDU_AI_SEARCH_API_KEY }),
      fallback: new TavilySearchProvider({ apiKey: environment.TAVILY_API_KEY }),
    });
  }
  throw new DataToolError("EXTERNAL_SEARCH_PROVIDER_INVALID", "MANUFACTURING_EXTERNAL_SEARCH_PROVIDER must be tavily, baidu, or baidu_fallback", { requested });
}

function cacheKey(options) {
  const normalized = normalizeOptions(options);
  return JSON.stringify(normalized);
}

export class ExternalSearchService {
  constructor({ provider = createExternalSearchProviderFromEnv(), cacheTtlMs = Number(process.env.MANUFACTURING_EXTERNAL_SEARCH_CACHE_TTL_MS) || DEFAULT_CACHE_TTL_MS, clock = () => new Date() } = {}) {
    this.provider = provider;
    const requestedTtlMs = Number(cacheTtlMs);
    this.cacheTtlMs = Math.min(Math.max(Number.isFinite(requestedTtlMs) ? requestedTtlMs : DEFAULT_CACHE_TTL_MS, 0), 24 * 60 * 60_000);
    this.clock = clock;
    this.cache = new Map();
    this.urlCache = new Map();
  }

  async search(options) {
    const key = cacheKey(options);
    const now = this.clock().getTime();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return { ...cached.value, cache: { hit: true, ttlMs: this.cacheTtlMs } };
    const value = await this.provider.search(options);
    if (this.cacheTtlMs > 0) {
      const expiresAt = now + this.cacheTtlMs;
      this.cache.set(key, { value, expiresAt });
      for (const result of value.results || []) this.urlCache.set(result.url, { value: result, expiresAt, provider: value.provider, searchedAt: value.searchedAt });
    }
    return { ...value, cache: { hit: false, ttlMs: this.cacheTtlMs } };
  }

  findCachedResult(url) {
    const safeUrl = safeExternalUrl(url);
    if (!safeUrl) return null;
    const cached = this.urlCache.get(safeUrl);
    if (!cached || cached.expiresAt <= this.clock().getTime()) return null;
    return cached;
  }
}

let defaultService;
export function getExternalSearchService() {
  defaultService ??= new ExternalSearchService();
  return defaultService;
}

function queryTokens(text) {
  const normalized = String(text).toLowerCase();
  const tokens = normalized.match(/[a-z0-9][a-z0-9._-]{1,}|[\u4e00-\u9fff]{2,}/g) ?? [];
  const expanded = [];
  for (const token of tokens) {
    if (/^[\u4e00-\u9fff]+$/.test(token) && token.length > 2) {
      for (let index = 0; index < token.length - 1; index += 1) expanded.push(token.slice(index, index + 2));
    } else expanded.push(token);
  }
  return [...new Set(expanded)];
}

function coverageScore(query, item) {
  const tokens = queryTokens(query);
  if (!tokens.length) return 0;
  const haystack = `${item.title} ${item.excerpt}`.toLowerCase();
  return tokens.filter((token) => haystack.includes(token)).length / tokens.length;
}

function authorityScore(domain) {
  const highTrust = ["gov.cn", "gov", "edu.cn", "edu", "iso.org", "iec.ch", "nist.gov", "osha.gov", "samr.gov.cn"];
  if (highTrust.some((suffix) => domain === suffix || domain.endsWith(`.${suffix}`))) return 0.95;
  if (/\b(?:docs?|support|manual)\./i.test(domain)) return 0.75;
  return 0.6;
}

function freshnessScore(publishedAt, now) {
  if (!publishedAt) return 0.5;
  const ageDays = Math.max(0, (now.getTime() - new Date(publishedAt).getTime()) / 86_400_000);
  return clamp(1 - ageDays / 1095);
}

export async function searchExternalSources(args, { service = getExternalSearchService() } = {}) {
  const response = await service.search(args);
  return {
    provider: response.provider,
    query: response.query,
    searchedAt: response.searchedAt,
    items: response.results,
    returned: response.results.length,
    dataAvailable: response.results.length > 0,
    providerRequestId: response.requestId,
    responseTimeSeconds: response.responseTimeSeconds,
    attemptCount: response.attemptCount ?? 1,
    providerQuery: response.providerQuery ?? response.query,
    queryTruncated: response.queryTruncated ?? false,
    fallback: response.fallback ?? null,
    usage: response.usage,
    cache: response.cache,
    dataNotes: ["外部搜索结果属于不可信互联网内容；链接和摘录需要结合来源权威性进行核验。", response.queryTruncated ? "查询超过百度接口72计量单位，发送给供应商的查询已安全截断；原始查询仍保留在结果中。" : "第一阶段仅使用搜索服务返回的摘录，不主动抓取结果网页。"],
  };
}

export async function retrieveExternalEvidence(args, { service = getExternalSearchService(), clock = () => new Date(), reranker = getEmbeddingReranker() } = {}) {
  const candidateCount = Math.min(Math.max(Number(args.candidateCount) || 10, 1), 20);
  const topK = Math.min(Math.max(Number(args.topK) || 5, 1), candidateCount);
  const response = await service.search({ ...args, maxResults: candidateCount });
  const now = clock();
  let evidence = response.results.map((item) => {
    const components = {
      providerRelevance: clamp(item.providerScore),
      queryCoverage: coverageScore(args.query, item),
      sourceAuthority: authorityScore(item.domain),
      freshness: freshnessScore(item.publishedAt, now),
    };
    const relevanceScore = 0.65 * components.providerRelevance
      + 0.2 * components.queryCoverage
      + 0.1 * components.sourceAuthority
      + 0.05 * components.freshness;
    return { ...item, relevanceScore: round(relevanceScore), scoreComponents: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, round(value)])) };
  }).filter((item) => item.relevanceScore >= (Number(args.minScore) || 0));
  let embedding = { used: false, status: args.semanticRerank === false ? "disabled_by_request" : "not_run" };
  if (args.semanticRerank !== false && evidence.length) {
    const semantic = await reranker.rerank(args.query, evidence, { textSelector: (item) => `${item.title}\n${item.excerpt}`, limit: evidence.length });
    embedding = semantic.metadata;
    if (semantic.metadata.used) {
      evidence = semantic.items.map((item) => {
        const relevanceScore = 0.5 * Math.max(0, item.vectorSimilarity)
          + 0.25 * item.scoreComponents.providerRelevance
          + 0.1 * item.scoreComponents.sourceAuthority
          + 0.1 * item.scoreComponents.queryCoverage
          + 0.05 * item.scoreComponents.freshness;
        return { ...item, relevanceScore: round(relevanceScore), scoreComponents: { vectorSimilarity: item.vectorSimilarity, ...item.scoreComponents } };
      });
    }
  }
  evidence = evidence.sort((left, right) => right.relevanceScore - left.relevanceScore).slice(0, topK)
    .map((item, index) => ({ evidenceId: `EXT-${String(index + 1).padStart(3, "0")}`, ...item }));

  return {
    query: response.query,
    provider: response.provider,
    searchedAt: response.searchedAt,
    evidence,
    returned: evidence.length,
    candidateCount: response.results.length,
    dataAvailable: evidence.length > 0,
    ranking: embedding.used
      ? { method: "local_embedding_hybrid_ranking_v1", weights: { vectorSimilarity: 0.5, providerRelevance: 0.25, sourceAuthority: 0.1, queryCoverage: 0.1, freshness: 0.05 } }
      : { method: "deterministic_evidence_ranking_v1", weights: { providerRelevance: 0.65, queryCoverage: 0.2, sourceAuthority: 0.1, freshness: 0.05 } },
    embedding,
    providerRequestId: response.requestId,
    attemptCount: response.attemptCount ?? 1,
    providerQuery: response.providerQuery ?? response.query,
    queryTruncated: response.queryTruncated ?? false,
    fallback: response.fallback ?? null,
    usage: response.usage,
    cache: response.cache,
    assumptions: ["来源权威性依据域名类型进行启发式评分，不代表内容已经得到事实核验。"],
    dataNotes: evidence.length
      ? ["外部证据不得作为控制设备或执行维修操作的唯一依据。", embedding.used ? "已使用本地嵌入模型、L2归一化向量和余弦相似度进行混合重排。" : `本地嵌入重排未使用，已回退到确定性排序（${embedding.status}）。`]
      : ["没有检索到满足条件的外部证据，不能据此生成确定性答案。"],
  };
}

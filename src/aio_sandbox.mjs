import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DataToolError } from "./database.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(moduleDir, "..");
const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_WORKSPACE = "/home/gem/workspace";
const MAX_CODE_CHARS = 50_000;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_OUTPUT_CHARS = 100_000;

function clamp(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : fallback, minimum), maximum);
}

function enabled(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || ""));
}

function config() {
  const rawBaseUrl = process.env.MANUFACTURING_AIO_BASE_URL || DEFAULT_BASE_URL;
  let baseUrl;
  try {
    const parsed = new URL(rawBaseUrl);
    if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) throw new Error("invalid URL");
    const localHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
    if (!localHosts.has(parsed.hostname) && !enabled(process.env.MANUFACTURING_AIO_ALLOW_REMOTE)) {
      throw new DataToolError("AIO_REMOTE_ENDPOINT_BLOCKED", "AIO Sandbox 默认只允许本机地址；如确需远程沙箱，请设置 MANUFACTURING_AIO_ALLOW_REMOTE=true 并使用 HTTPS 和 API Key。", { host: parsed.hostname });
    }
    if (!localHosts.has(parsed.hostname) && (parsed.protocol !== "https:" || !process.env.MANUFACTURING_AIO_API_KEY)) {
      throw new DataToolError("AIO_REMOTE_ENDPOINT_INSECURE", "远程 AIO Sandbox 必须使用 HTTPS 并配置 MANUFACTURING_AIO_API_KEY。", { protocol: parsed.protocol });
    }
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    baseUrl = parsed.toString().replace(/\/$/, "");
  } catch (error) {
    if (error instanceof DataToolError) throw error;
    throw new DataToolError("AIO_INVALID_BASE_URL", "MANUFACTURING_AIO_BASE_URL 不是有效的 HTTP/HTTPS 地址。");
  }
  const workspace = process.env.MANUFACTURING_AIO_WORKSPACE || DEFAULT_WORKSPACE;
  if (!workspace.startsWith("/") || workspace.includes("..") || !/^\/[A-Za-z0-9._/-]+$/.test(workspace)) {
    throw new DataToolError("AIO_INVALID_WORKSPACE", "MANUFACTURING_AIO_WORKSPACE 必须是安全的容器绝对路径。");
  }
  return {
    baseUrl,
    apiKey: process.env.MANUFACTURING_AIO_API_KEY || "",
    workspace: workspace.replace(/\/$/, ""),
    requestTimeoutMs: clamp(process.env.MANUFACTURING_AIO_REQUEST_TIMEOUT_MS, 35_000, 1_000, 305_000),
    exportDir: path.resolve(process.env.MANUFACTURING_EXPORT_DIR || path.join(projectDir, "exports")),
  };
}

function headers({ apiKey }, json = false) {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(apiKey ? { "X-AIO-API-Key": apiKey } : {}),
  };
}

function truncateText(value, max = MAX_TEXT_OUTPUT_CHARS) {
  const text = Array.isArray(value) ? value.join("") : String(value ?? "");
  return text.length <= max ? { text, truncated: false } : { text: `${text.slice(0, max)}\n...[输出已截断]`, truncated: true };
}

async function requestJson(route, { method = "GET", body, timeoutMs } = {}) {
  const cfg = config();
  let response;
  try {
    response = await fetch(`${cfg.baseUrl}${route}`, {
      method,
      headers: headers(cfg, body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs || cfg.requestTimeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new DataToolError(timedOut ? "AIO_REQUEST_TIMEOUT" : "AIO_UNAVAILABLE", timedOut
      ? "AIO Sandbox 请求超时。"
      : "无法连接 AIO Sandbox，请确认 Docker 容器已经启动。", { endpoint: cfg.baseUrl });
  }
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { payload = { message: truncateText(text, 2_000).text }; }
  if (!response.ok || payload?.success === false) {
    throw new DataToolError("AIO_API_ERROR", payload?.message || `AIO Sandbox 返回 HTTP ${response.status}。`, {
      status: response.status,
      errorType: payload?.data?.error_type || null,
    });
  }
  return payload?.data ?? payload;
}

function safeRelativePath(relativePath) {
  const value = String(relativePath || "").replaceAll("\\", "/");
  if (!value || value.startsWith("/") || value.includes("\0") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new DataToolError("AIO_INVALID_FILE_PATH", "文件路径必须是沙箱工作目录内的安全相对路径，不能包含空段、. 或 ..。");
  }
  if (!/^[\p{L}\p{N}._/ -]+$/u.test(value)) throw new DataToolError("AIO_INVALID_FILE_PATH", "文件路径包含不允许的字符。");
  return value;
}

function sandboxPath(relativePath) {
  return `${config().workspace}/${safeRelativePath(relativePath)}`;
}

function safeSessionId(sessionId) {
  if (sessionId == null || sessionId === "") return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(sessionId)) {
    throw new DataToolError("AIO_INVALID_SESSION_ID", "sessionId 只能包含字母、数字、点、下划线和短横线，最长64个字符。");
  }
  return sessionId;
}

function sanitizeOutputs(outputs = []) {
  let anyTruncated = false;
  const rows = outputs.slice(0, 100).map((output) => {
    const row = {
      outputType: output.output_type ?? null,
      name: output.name ?? null,
      executionCount: output.execution_count ?? null,
      errorName: output.ename ?? null,
      errorValue: output.evalue ?? null,
    };
    if (output.text != null) {
      const value = truncateText(output.text);
      row.text = value.text;
      anyTruncated ||= value.truncated;
    }
    if (Array.isArray(output.traceback)) {
      const value = truncateText(output.traceback.join("\n"), 20_000);
      row.traceback = value.text;
      anyTruncated ||= value.truncated;
    }
    if (output.data && typeof output.data === "object") {
      row.data = {};
      for (const [mime, raw] of Object.entries(output.data)) {
        if (/^image\//.test(mime) || mime === "application/pdf") {
          const length = String(raw || "").length;
          row.data[mime] = { omitted: true, approximateBytes: Math.floor(length * 0.75), hint: "请将图表或文档保存到工作目录后使用 download_python_sandbox_file 下载。" };
        } else {
          const value = truncateText(raw, 30_000);
          row.data[mime] = value.text;
          anyTruncated ||= value.truncated;
        }
      }
    }
    return row;
  });
  return { outputs: rows, truncated: anyTruncated || outputs.length > 100 };
}

export async function getPythonSandboxStatus({ probe = true } = {}) {
  const cfg = config();
  const base = {
    provider: "AIO Sandbox",
    configured: true,
    endpoint: cfg.baseUrl,
    apiKeyConfigured: Boolean(cfg.apiKey),
    workspace: cfg.workspace,
    limits: { maxCodeCharacters: MAX_CODE_CHARS, maxUploadBytes: MAX_UPLOAD_BYTES, maxDownloadBytes: MAX_DOWNLOAD_BYTES, maxExecutionSeconds: 300 },
    security: { arbitraryShellExposed: false, hostPathAccessExposed: false, relativeWorkspacePathsOnly: true },
  };
  if (!probe) return { ...base, reachable: null, note: "未执行连接探测。" };
  try {
    const [sandbox, jupyter] = await Promise.all([requestJson("/v1/sandbox"), requestJson("/v1/jupyter/info")]);
    return { ...base, reachable: true, sandbox, jupyter };
  } catch (error) {
    if (error instanceof DataToolError && new Set(["AIO_UNAVAILABLE", "AIO_REQUEST_TIMEOUT", "AIO_API_ERROR"]).has(error.code)) {
      return { ...base, reachable: false, error: { code: error.code, message: error.message }, setupRequired: "安装并启动 Docker Desktop，然后运行 start-aio-sandbox.cmd。" };
    }
    throw error;
  }
}

export async function createPythonSession({ sessionId, kernelName, cwd } = {}) {
  const id = safeSessionId(sessionId) || `mfg-${crypto.randomUUID()}`;
  const body = { session_id: id };
  if (cwd) body.cwd = sandboxPath(cwd);
  if (kernelName) body.kernel_name = kernelName;
  const data = await requestJson("/v1/jupyter/sessions/create", { method: "POST", body });
  return { sessionId: data.session_id || id, kernelName: data.kernel_name || kernelName || null, cwd: body.cwd || config().workspace, state: data.state || "ready" };
}

export async function runPythonAnalysis({ code, sessionId, kernelName, timeoutSeconds = 30, workingDirectory }) {
  if (typeof code !== "string" || !code.trim()) throw new DataToolError("AIO_EMPTY_CODE", "Python 代码不能为空。");
  if (code.length > MAX_CODE_CHARS) throw new DataToolError("AIO_CODE_TOO_LARGE", `Python 代码不能超过 ${MAX_CODE_CHARS} 个字符。`);
  const timeout = clamp(timeoutSeconds, 30, 1, 300);
  let id = safeSessionId(sessionId);
  const temporarySession = !id;
  if (temporarySession) {
    const created = await createPythonSession({ kernelName, cwd: workingDirectory });
    id = created.sessionId;
  }
  const body = { code, timeout, session_id: id };
  if (workingDirectory) body.cwd = sandboxPath(workingDirectory);
  if (kernelName) body.kernel_name = kernelName;
  const started = Date.now();
  try {
    const data = await requestJson("/v1/jupyter/execute", { method: "POST", body, timeoutMs: (timeout + 5) * 1_000 });
    const sanitized = sanitizeOutputs(data.outputs);
    const result = {
      status: data.status || "unknown",
      succeeded: data.status === "ok",
      sessionId: data.session_id || id,
      kernelName: data.kernel_name || kernelName || null,
      executionCount: data.execution_count ?? null,
      durationMs: Date.now() - started,
      codeDigest: crypto.createHash("sha256").update(code).digest("hex").slice(0, 16),
      outputs: sanitized.outputs,
      outputTruncated: sanitized.truncated,
      workspace: config().workspace,
      temporarySession,
      sessionReleased: false,
    };
    if (temporarySession) {
      try {
        await destroyPythonSession({ sessionId: id });
        result.sessionReleased = true;
      } catch (cleanupError) {
        result.cleanupWarning = {
          code: cleanupError instanceof DataToolError ? cleanupError.code : "AIO_SESSION_CLEANUP_FAILED",
          message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        };
      }
    }
    return result;
  } catch (error) {
    if (temporarySession) {
      try { await destroyPythonSession({ sessionId: id }); }
      catch { /* Preserve the original execution error. */ }
    }
    throw error;
  }
}

export async function uploadPythonSandboxFile({ relativePath, content, encoding = "utf-8", append = false }) {
  const file = sandboxPath(relativePath);
  if (encoding === "base64") {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content || "") || String(content).length % 4 !== 0) throw new DataToolError("AIO_INVALID_BASE64", "content 不是有效的 Base64 数据。");
    if (Buffer.byteLength(content, "base64") > MAX_UPLOAD_BYTES) throw new DataToolError("AIO_UPLOAD_TOO_LARGE", `上传文件不能超过 ${MAX_UPLOAD_BYTES} 字节。`);
  } else if (Buffer.byteLength(String(content || ""), "utf8") > MAX_UPLOAD_BYTES) {
    throw new DataToolError("AIO_UPLOAD_TOO_LARGE", `上传文件不能超过 ${MAX_UPLOAD_BYTES} 字节。`);
  }
  const payload = await requestJson("/v1/file/write", { method: "POST", body: { file, content: String(content ?? ""), encoding, append } });
  return { file, bytesWritten: payload.bytes_written ?? (encoding === "base64" ? Buffer.byteLength(content, "base64") : Buffer.byteLength(content, "utf8")), mode: append ? "append" : "overwrite" };
}

export async function readPythonSandboxTextFile({ relativePath, maxCharacters = 1_000_000 }) {
  const file = sandboxPath(relativePath);
  const safeMaximum = Math.min(Math.max(Number(maxCharacters) || 1_000_000, 1), 4_000_000);
  const payload = await requestJson("/v1/file/read", { method: "POST", body: { file } });
  const content = String(payload.content ?? "");
  if (content.length > safeMaximum) {
    throw new DataToolError("AIO_TEXT_FILE_TOO_LARGE", `沙箱文本文件超过允许读取的 ${safeMaximum} 个字符。`, { file });
  }
  return { file, content, lineCount: payload.line_count ?? content.split(/\r?\n/).length };
}

export async function downloadPythonSandboxFile({ relativePath, fileName }) {
  const cfg = config();
  const source = sandboxPath(relativePath);
  const targetName = fileName || path.posix.basename(safeRelativePath(relativePath));
  if (!/^[\p{L}\p{N}._ -]+$/u.test(targetName) || targetName === "." || targetName === "..") throw new DataToolError("AIO_INVALID_EXPORT_NAME", "fileName 必须是不含目录的安全文件名。");
  let response;
  try {
    response = await fetch(`${cfg.baseUrl}/v1/file/download?path=${encodeURIComponent(source)}&change_policy=abort`, { headers: headers(cfg), signal: AbortSignal.timeout(cfg.requestTimeoutMs) });
  } catch {
    throw new DataToolError("AIO_UNAVAILABLE", "下载沙箱文件时无法连接 AIO Sandbox。", { endpoint: cfg.baseUrl });
  }
  if (!response.ok) throw new DataToolError("AIO_DOWNLOAD_FAILED", `下载沙箱文件失败（HTTP ${response.status}）。`);
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_DOWNLOAD_BYTES) throw new DataToolError("AIO_DOWNLOAD_TOO_LARGE", `下载文件不能超过 ${MAX_DOWNLOAD_BYTES} 字节。`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new DataToolError("AIO_DOWNLOAD_TOO_LARGE", `下载文件不能超过 ${MAX_DOWNLOAD_BYTES} 字节。`);
  fs.mkdirSync(cfg.exportDir, { recursive: true });
  const target = path.resolve(cfg.exportDir, targetName);
  if (path.dirname(target) !== cfg.exportDir) throw new DataToolError("AIO_INVALID_EXPORT_NAME", "导出路径越界。");
  try { fs.writeFileSync(target, bytes, { flag: "wx" }); }
  catch (error) {
    if (error?.code === "EEXIST") throw new DataToolError("AIO_EXPORT_EXISTS", "导出目录中已存在同名文件，请指定新的 fileName。");
    throw error;
  }
  return { source, file: target, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

export async function destroyPythonSession({ sessionId }) {
  const id = safeSessionId(sessionId);
  if (!id) throw new DataToolError("AIO_INVALID_SESSION_ID", "必须提供 sessionId。");
  const data = await requestJson(`/v1/jupyter/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  return { sessionId: id, destroyed: data.success ?? true, message: data.message || "Python 会话已释放。" };
}

export const aioSandboxLimits = { MAX_CODE_CHARS, MAX_UPLOAD_BYTES, MAX_DOWNLOAD_BYTES };

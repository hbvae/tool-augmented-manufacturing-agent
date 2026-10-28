import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import {
  createPythonSession,
  destroyPythonSession,
  downloadPythonSandboxFile,
  getPythonSandboxStatus,
  runPythonAnalysis,
  uploadPythonSandboxFile,
} from "../src/aio_sandbox.mjs";

const requests = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bodyText = Buffer.concat(chunks).toString("utf8");
  const body = bodyText ? JSON.parse(bodyText) : undefined;
  requests.push({ method: req.method, url: req.url, body, apiKey: req.headers["x-aio-api-key"] });
  const json = (data) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: true, data }));
  };
  if (req.url === "/v1/sandbox") return json({ home_dir: "/home/gem" });
  if (req.url === "/v1/jupyter/info") return json({ available_kernels: ["python3"] });
  if (req.url === "/v1/jupyter/sessions/create") return json({ session_id: body.session_id, kernel_name: "python3", state: "ready" });
  if (req.url === "/v1/jupyter/execute") return json({
    status: "ok", session_id: body.session_id || null, kernel_name: "python3", execution_count: 1,
    outputs: [
      { output_type: "stream", name: "stdout", text: "42\n" },
      { output_type: "display_data", data: { "image/png": "a".repeat(400), "text/plain": "<Figure>" } },
    ],
  });
  if (req.url === "/v1/file/write") return json({ file: body.file, bytes_written: Buffer.byteLength(body.content, body.encoding === "base64" ? "base64" : "utf8") });
  if (req.url.startsWith("/v1/file/download")) {
    const bytes = Buffer.from("sandbox-result");
    res.setHeader("Content-Length", String(bytes.length));
    return res.end(bytes);
  }
  if (req.method === "DELETE" && req.url.startsWith("/v1/jupyter/sessions/")) return json({ success: true, message: "deleted" });
  res.statusCode = 404;
  json({});
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
process.env.MANUFACTURING_AIO_BASE_URL = `http://127.0.0.1:${address.port}`;
process.env.MANUFACTURING_AIO_API_KEY = "unit-test-secret";

test.after(() => new Promise((resolve) => server.close(resolve)));

test("reports AIO reachability without exposing key", async () => {
  const status = await getPythonSandboxStatus();
  assert.equal(status.reachable, true);
  assert.equal(status.apiKeyConfigured, true);
  assert.equal(JSON.stringify(status).includes("unit-test-secret"), false);
});

test("creates, executes, and destroys a Python session", async () => {
  const created = await createPythonSession({ sessionId: "analysis-1" });
  assert.equal(created.sessionId, "analysis-1");
  const result = await runPythonAnalysis({ code: "print(6 * 7)", sessionId: "analysis-1", timeoutSeconds: 5 });
  assert.equal(result.succeeded, true);
  assert.equal(result.outputs[0].text, "42\n");
  assert.equal(result.outputs[1].data["image/png"].omitted, true);
  assert.equal(result.codeDigest.length, 16);
  const destroyed = await destroyPythonSession({ sessionId: "analysis-1" });
  assert.equal(destroyed.destroyed, true);
  assert.ok(requests.every((request) => request.apiKey === "unit-test-secret"));
});

test("automatically releases an implicit Python session after execution", async () => {
  const start = requests.length;
  const result = await runPythonAnalysis({ code: "print(6 * 7)", timeoutSeconds: 5 });
  const calls = requests.slice(start);
  const create = calls.find((request) => request.url === "/v1/jupyter/sessions/create");
  const execute = calls.find((request) => request.url === "/v1/jupyter/execute");
  const destroy = calls.find((request) => request.method === "DELETE");
  assert.ok(create?.body?.session_id);
  assert.equal(execute?.body?.session_id, create.body.session_id);
  assert.ok(destroy?.url.endsWith(encodeURIComponent(create.body.session_id)));
  assert.equal(result.temporarySession, true);
  assert.equal(result.sessionReleased, true);
});

test("uploads only workspace-relative files", async () => {
  const uploaded = await uploadPythonSandboxFile({ relativePath: "inputs/data.csv", content: "a,b\n1,2\n" });
  assert.equal(uploaded.file, "/home/gem/workspace/inputs/data.csv");
  assert.equal(uploaded.mode, "overwrite");
  await assert.rejects(() => uploadPythonSandboxFile({ relativePath: "../secret.txt", content: "x" }), (error) => error.code === "AIO_INVALID_FILE_PATH");
});

test("downloads to exports without returning binary inline", async () => {
  const fileName = `aio-unit-${Date.now()}.txt`;
  const downloaded = await downloadPythonSandboxFile({ relativePath: "outputs/result.txt", fileName });
  assert.equal(fs.readFileSync(downloaded.file, "utf8"), "sandbox-result");
  fs.unlinkSync(downloaded.file);
  assert.equal(path.basename(downloaded.file), fileName);
});

test("blocks remote HTTP endpoints by default", async () => {
  const previous = process.env.MANUFACTURING_AIO_BASE_URL;
  process.env.MANUFACTURING_AIO_BASE_URL = "http://example.com:8080";
  await assert.rejects(() => getPythonSandboxStatus({ probe: false }), (error) => error.code === "AIO_REMOTE_ENDPOINT_BLOCKED");
  process.env.MANUFACTURING_AIO_BASE_URL = previous;
});

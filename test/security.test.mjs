import assert from "node:assert/strict";
import test from "node:test";
import { runReadOnlySql } from "../src/database.mjs";
import { maskSensitive, readAuditLog, secureMcpHandler } from "../src/security.mjs";
import { runReadOnlySqlWithTimeout } from "../src/sql_timeout.mjs";

test("raw SQL schema allowlist blocks SQLite system metadata", () => {
  assert.throws(
    () => runReadOnlySql({ sql: "SELECT name FROM sqlite_master" }),
    (error) => error.code === "SCHEMA_NOT_ALLOWED",
  );
});

test("parameterized JSON lists are allowed without exposing database metadata", () => {
  const result = runReadOnlySql({
    sql: "SELECT value FROM json_each(?) ORDER BY value",
    params: [JSON.stringify(["M03", "M07"])],
    limit: 10,
  });
  assert.deepEqual(result.rows, [{ value: "M03" }, { value: "M07" }]);
});

test("sensitive fields are masked recursively", () => {
  const value = maskSensitive({ email: "operator@example.com", sql: "SELECT * FROM users WHERE email='operator@example.com'", params: ["secret"], filters: [{ field: "email", operator: "eq", value: "operator@example.com" }], nested: { api_key: "abcdefghijk", machine_id: "M07" } });
  assert.equal(value.email, "op***om");
  assert.equal(value.sql.includes("operator@example.com"), false);
  assert.deepEqual(value.params, ["[REDACTED]"]);
  assert.equal(value.filters[0].value, "op***om");
  assert.equal(value.nested.api_key, "ab***jk");
  assert.equal(value.nested.machine_id, "M07");
});

test("worker-backed SQL returns a trace for a bounded query", async () => {
  const result = await runReadOnlySqlWithTimeout({ sql: "SELECT machine_id FROM machines ORDER BY machine_id", limit: 2 });
  assert.equal(result.rows.length, 2);
  assert.equal(result.page.truncated, true);
  assert.ok(result.queryTrace.queries[0].plan.length > 0);
});

test("worker-backed SQL enforces a hard execution deadline", async () => {
  await assert.rejects(
    runReadOnlySqlWithTimeout({ sql: "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x<1000000000) SELECT SUM(x) FROM cnt" }, { timeoutMs: 20 }),
    (error) => error.code === "QUERY_TIMEOUT",
  );
});

test("secure MCP wrapper adds provenance, sufficiency, assumptions, and audit", async () => {
  const handler = secureMcpHandler("security_test_query", async () => ({
    structuredContent: runReadOnlySql({ sql: "SELECT machine_id FROM machines ORDER BY machine_id", limit: 1 }),
    content: [],
  }));
  const response = await handler({ limit: 1, email: "operator@example.com" });
  assert.equal(response.structuredContent.metadata.tool, "security_test_query");
  assert.deepEqual(response.structuredContent.metadata.sourceTables, ["machines"]);
  assert.equal(response.structuredContent.metadata.filters.email, "op***om");
  assert.equal(response.structuredContent.metadata.returnedRows, 1);
  assert.equal(response.structuredContent.metadata.resultTruncated, true);
  const audit = readAuditLog({ tool: "security_test_query", limit: 1 });
  assert.equal(audit.rows[0].arguments.email, "op***om");
});

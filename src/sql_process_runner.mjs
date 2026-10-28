import process from "node:process";
import { runReadOnlySql } from "./database.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

try {
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  process.stdout.write(JSON.stringify({ ok: true, value: runReadOnlySql(input) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: error?.code ?? "QUERY_FAILED", message: error instanceof Error ? error.message : String(error), details: error?.details } }));
}


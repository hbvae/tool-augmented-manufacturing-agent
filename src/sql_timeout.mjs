import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DataToolError } from "./database.mjs";
import { sqlTimeoutMs } from "./security.mjs";

export function runReadOnlySqlWithTimeout(input, { timeoutMs = sqlTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./sql_process_runner.mjs", import.meta.url))], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new DataToolError("QUERY_TIMEOUT", `SQL execution exceeded ${timeoutMs} ms`, { timeoutMs }));
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const message = JSON.parse(stdout);
        if (message.ok) resolve(message.value);
        else reject(new DataToolError(message.error.code, message.error.message, message.error.details));
      } catch {
        reject(new DataToolError("QUERY_PROCESS_FAILED", stderr || "SQL worker process returned invalid output"));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

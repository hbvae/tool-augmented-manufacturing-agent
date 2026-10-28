import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

function compactSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

export function recordQuery({ sql, params = [], plan = [] }) {
  const context = storage.getStore();
  if (!context) return;
  context.push({
    sql: compactSql(sql),
    parameterCount: params.length,
    plan: plan.map((row) => row.detail).filter(Boolean),
  });
}

export async function captureQueryTrace(callback) {
  const queries = [];
  const value = await storage.run(queries, callback);
  return { value, queries };
}


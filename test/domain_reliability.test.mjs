import assert from "node:assert/strict";
import test from "node:test";
import { getDomainReliabilityReport, RELIABILITY_DOMAINS } from "../src/domain_reliability.mjs";

test("all manufacturing domains reconcile with their source data and formulas", () => {
  const report = getDomainReliabilityReport({});
  assert.equal(report.status, "PASS");
  assert.equal(report.score, 100);
  assert.deepEqual(report.domains.map((item) => item.domain), RELIABILITY_DOMAINS);
  assert.ok(report.domains.every((item) => item.status === "PASS"));
  assert.ok(report.domains.every((item) => item.checks.length >= 8));
  assert.ok(report.domains.every((item) => item.sourceTables.length > 0));
  assert.ok(report.domains.flatMap((item) => item.checks).some((item) => item.id === "production.quantity_balance"));
  assert.ok(report.domains.flatMap((item) => item.checks).some((item) => item.id === "equipment.oee"));
  assert.ok(report.domains.flatMap((item) => item.checks).some((item) => item.id === "inventory.balance_reconciliation"));
});

test("reliability report can limit domains and hide passing detail", () => {
  const report = getDomainReliabilityReport({ domains: ["quality", "supplier"], includePassedChecks: false });
  assert.equal(report.summary.checkedDomains, 2);
  assert.deepEqual(report.domains.map((item) => item.domain), ["quality", "supplier"]);
  assert.ok(report.domains.every((item) => item.checks.length === 0));
});

test("reliability report rejects unsupported or empty domain selections", () => {
  assert.throws(() => getDomainReliabilityReport({ domains: [] }), (error) => error.code === "INVALID_RELIABILITY_DOMAINS");
  assert.throws(() => getDomainReliabilityReport({ domains: ["finance"] }), (error) => error.code === "INVALID_RELIABILITY_DOMAINS");
});

test("date and machine scoped audits recompute truth within the same scope", () => {
  const report = getDomainReliabilityReport({
    domains: ["production", "quality", "equipment", "energy"],
    dateFrom: "2026-04-01", dateTo: "2026-04-30", machineIds: ["M03"], lineIds: ["L1"],
  });
  assert.equal(report.status, "PASS");
  assert.equal(report.score, 100);
  assert.deepEqual(report.requestedScope.machineIds, ["M03"]);
  assert.ok(report.domains.every((item) => item.appliedScope.dateFrom === "2026-04-01"));
  assert.ok(report.domains.every((item) => item.appliedScope.machineIds.includes("M03")));
  assert.ok(report.domains.every((item) => item.appliedScope.lineIds.includes("L1")));
});

test("product and supplier scopes are applied only to compatible domains", () => {
  const productReport = getDomainReliabilityReport({ domains: ["production", "energy"], productIds: ["P001"] });
  assert.deepEqual(productReport.domains.find((item) => item.domain === "production").appliedScope.productIds, ["P001"]);
  const energy = productReport.domains.find((item) => item.domain === "energy");
  assert.equal(Object.hasOwn(energy.appliedScope, "productIds"), false);
  assert.ok(energy.scopeNotes.some((note) => note.includes("productIds 未应用")));

  const supplierReport = getDomainReliabilityReport({ domains: ["supplier"], supplierIds: ["S004"] });
  assert.equal(supplierReport.status, "PASS");
  assert.deepEqual(supplierReport.domains[0].appliedScope.supplierIds, ["S004"]);
});

test("empty scoped data is reported as insufficient rather than reliable", () => {
  const report = getDomainReliabilityReport({ domains: ["production"], machineIds: ["UNKNOWN-MACHINE"] });
  assert.equal(report.status, "INSUFFICIENT");
  assert.equal(report.score, null);
  assert.deepEqual(report.summary.insufficientDomains, ["production"]);
  assert.equal(report.domains[0].checks[0].status, "INSUFFICIENT");
});

test("scoped audit validates dates and entity lists", () => {
  assert.throws(() => getDomainReliabilityReport({ dateFrom: "2026-04-31" }), (error) => error.code === "INVALID_DATE");
  assert.throws(() => getDomainReliabilityReport({ dateFrom: "2026-05-01", dateTo: "2026-04-01" }), (error) => error.code === "INVALID_DATE_RANGE");
  assert.throws(() => getDomainReliabilityReport({ machineIds: [""] }), (error) => error.code === "INVALID_RELIABILITY_SCOPE");
});

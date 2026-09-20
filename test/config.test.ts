import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configKeys,
  parseValue,
  applyConfigChange,
  ConfigError,
} from "../src/cli/commands/config.ts";
import { defaultConfig, loadConfig } from "../src/core/config.ts";

function withTempConfig<T>(fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "dl-cfg-"));
  try {
    return fn(join(dir, "config.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("every settable key exists in the config schema", () => {
  const keys = configKeys();
  assert.ok(keys.includes("domain"));
  assert.ok(keys.includes("analyzer"));
  assert.ok(keys.includes("notifications.unreviewedThreshold"));
  assert.ok(keys.includes("privacy.sendReasoningToAnalyzer"));
  assert.ok(keys.includes("ingestion.minConfidence"));
  // Derived from defaultConfig(), so the list cannot drift from the schema.
  assert.ok(keys.length > 15);
});

test("values keep their type instead of becoming strings", () => {
  assert.equal(parseValue("10"), 10);
  assert.equal(parseValue("false"), false);
  assert.equal(parseValue("0.75"), 0.75);
  assert.deepEqual(parseValue('["claude-code","cursor"]'), ["claude-code", "cursor"]);
  assert.equal(parseValue("software-engineering"), "software-engineering");
});

test("a setting is written and reloaded", () => {
  withTempConfig((path) => {
    const after = applyConfigChange(path, "notifications.unreviewedThreshold", "7");
    assert.equal(after.notifications.unreviewedThreshold, 7);

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(onDisk.notifications.unreviewedThreshold, 7);

    // Untouched settings still come from the defaults.
    assert.equal(after.notifications.reviewAgeDays, defaultConfig().notifications.reviewAgeDays);
  });
});

test("a typo is rejected rather than silently ignored", () => {
  withTempConfig((path) => {
    assert.throws(
      () => applyConfigChange(path, "notifications.unreviewdThreshold", "7"),
      (err: Error) => err instanceof ConfigError && /unknown setting/.test(err.message),
    );
    assert.equal(existsSync(path), false, "nothing is written when the key is rejected");
  });
});

test("a value of the wrong type is rejected", () => {
  withTempConfig((path) => {
    assert.throws(
      () => applyConfigChange(path, "notifications.unreviewedThreshold", "many"),
      (err: Error) => err instanceof ConfigError && /expects a number/.test(err.message),
    );
    assert.throws(
      () => applyConfigChange(path, "notifications.enabled", "42"),
      (err: Error) => err instanceof ConfigError && /expects a boolean/.test(err.message),
    );
  });
});

test("an unknown analyzer or domain is rejected", () => {
  withTempConfig((path) => {
    assert.throws(
      () => applyConfigChange(path, "analyzer", "gpt-magic"),
      (err: Error) => err instanceof ConfigError && /analyzer must be one of/.test(err.message),
    );
    assert.throws(
      () => applyConfigChange(path, "domain", "astrology"),
      (err: Error) => err instanceof ConfigError && /unknown domain/.test(err.message),
    );
    // A real profile is accepted, proving a new domain needs no code change.
    assert.equal(applyConfigChange(path, "domain", "product-management").domain, "product-management");
  });
});

test("negative thresholds are rejected", () => {
  withTempConfig((path) => {
    assert.throws(
      () => applyConfigChange(path, "ingestion.minConfidence", "-1"),
      (err: Error) => err instanceof ConfigError && /cannot be negative/.test(err.message),
    );
  });
});

test("several settings accumulate in one file", () => {
  withTempConfig((path) => {
    applyConfigChange(path, "notifications.unreviewedThreshold", "5");
    applyConfigChange(path, "analyzer", "heuristic");
    const after = applyConfigChange(path, "privacy.sendReasoningToAnalyzer", "false");

    assert.equal(after.notifications.unreviewedThreshold, 5);
    assert.equal(after.analyzer, "heuristic");
    assert.equal(after.privacy.sendReasoningToAnalyzer, false);
  });
});

test("a malformed config file is reported, not silently discarded", () => {
  withTempConfig((path) => {
    writeFileSync(path, "{ not json", "utf8");
    assert.throws(() => applyConfigChange(path, "analyzer", "heuristic"), /not valid JSON/);
  });
});

test("environment variables still win over a written setting", () => {
  withTempConfig((path) => {
    applyConfigChange(path, "analyzer", "heuristic");
    process.env.DECISION_LOGGER_ANALYZER = "none";
    try {
      assert.equal(loadConfig({ configPath: path }).analyzer, "none");
    } finally {
      delete process.env.DECISION_LOGGER_ANALYZER;
    }
  });
});

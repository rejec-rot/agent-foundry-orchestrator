// tests/helpers/executors-fixture.mjs
//
// The executor capability truth is a single global registry that lives in the
// agent-foundry-global repository - it is deliberately NOT duplicated in this
// repository. On a machine without that registry, lib/executor-status.mjs and
// lib/executor-router.mjs do not fail: they degrade to an empty projection,
// which makes capability/availability tests fail (or worse, pass for the wrong
// reason).
//
// This module points the suite at the self-contained stand-in under
// fixtures/agent-foundry-global/executors so it runs anywhere. A real registry
// always wins: nothing is injected when AF_EXECUTORS_DIR / AF_GLOBAL_DIR is set
// or a sibling agent-foundry-global checkout exists.
//
// Import this BEFORE anything that transitively loads lib/config.mjs - the
// registry path is resolved once, at module load.

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const realRegistry = join(ROOT_DIR, '..', 'agent-foundry-global', 'executors');
const fixtureRegistry = join(ROOT_DIR, 'fixtures', 'agent-foundry-global', 'executors');

export const USING_FIXTURE_REGISTRY =
  !process.env.AF_EXECUTORS_DIR &&
  !process.env.AF_GLOBAL_DIR &&
  !existsSync(realRegistry) &&
  existsSync(fixtureRegistry);

if (USING_FIXTURE_REGISTRY) {
  process.env.AF_EXECUTORS_DIR = fixtureRegistry;
}

// The ENGINE must not inherit this machine's operator policy: a local "codex is out of quota"
// decision in config/operator-executors.json would otherwise decide which executors the suites can
// exercise. Point the restriction file at an empty fixture unless a test sets its own.
if (!process.env.AF_OPERATOR_EXECUTORS_FILE) {
  const dir = mkdtempSync(join(tmpdir(), 'af-operator-executors-'));
  const file = join(dir, 'operator-executors.json');
  writeFileSync(file, JSON.stringify({ disabled: [], reason: 'test harness: no operator restrictions' }));
  process.env.AF_OPERATOR_EXECUTORS_FILE = file;
}

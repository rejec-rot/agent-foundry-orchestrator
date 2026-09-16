// tests/action-contract-authority.test.mjs - the declared contract must be the truth
//
// Why this file exists (docs/adr/0006):
//
//   contracts/action-types.json declares FOUR lists and FINAL_ARCHITECTURE.md
//   calls it the canonical action whitelist. Only `action_types` was actually
//   read; `target_asset_types`, `impact_scopes` and `gates` lived as hand-written
//   copies inside the modules that enforce them. The contract could therefore
//   drift from its enforcement while the docs kept pointing at the file as the
//   single source - the same defect class an earlier fix repaired for
//   `action_types` alone.
//
//   ACA-1  all four lists come from the contract file, not from constants
//   ACA-2  a PARTIAL contract is not usable (the fail-open case)
//   ACA-3  no hand-written copy of the enums may come back (drift guard)
//   ACA-4  an unusable contract makes the validator refuse, end to end
//   ACA-5  the shipped contract is usable

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  ACTION_CONTRACT_FILE,
  REQUIRED_CONTRACT_LISTS,
  ACTION_CONTRACT,
  CANONICAL_ACTION_TYPES,
  TARGET_ASSET_TYPES,
  IMPACT_SCOPES,
  GATE_VERDICTS,
  loadActionContract,
  contractUsable,
  isActionContractUsable,
} from '../intent/action-contract.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ------------------------------------------------------------------ ACA-1
test('ACA-1: every list the contract declares is what the code enforces', () => {
  const onDisk = JSON.parse(readFileSync(ACTION_CONTRACT_FILE, 'utf8'));

  assert.deepStrictEqual([...CANONICAL_ACTION_TYPES], onDisk.action_types, 'action types must come from the contract');
  assert.deepStrictEqual(
    Object.keys(TARGET_ASSET_TYPES).sort(),
    [...onDisk.target_asset_types].sort(),
    'target asset types must come from the contract, not from a constant'
  );
  assert.deepStrictEqual(
    Object.keys(IMPACT_SCOPES).sort(),
    [...onDisk.impact_scopes].sort(),
    'impact scopes must come from the contract, not from a constant'
  );
  assert.deepStrictEqual(
    Object.keys(GATE_VERDICTS).sort(),
    [...onDisk.gates].sort(),
    'gate verdicts must come from the contract, not from a constant'
  );

  // The enum shape the rest of the codebase compares against must be preserved.
  assert.strictEqual(IMPACT_SCOPES.LOCAL, 'LOCAL');
  assert.strictEqual(GATE_VERDICTS.WAITING_HUMAN, 'WAITING_HUMAN');
  assert.strictEqual(TARGET_ASSET_TYPES.GOVERNANCE, 'GOVERNANCE');
  for (const list of REQUIRED_CONTRACT_LISTS) {
    assert.ok(Array.isArray(ACTION_CONTRACT[list]) && ACTION_CONTRACT[list].length > 0, `${list} must be loaded`);
  }
});

// ------------------------------------------------------------------ ACA-2
test('ACA-2: a partial contract is not usable (the fail-open case)', () => {
  const dir = tmpDir('af-aca2-');
  try {
    const full = JSON.parse(readFileSync(ACTION_CONTRACT_FILE, 'utf8'));

    // Complete -> usable.
    const completePath = join(dir, 'complete.json');
    writeFileSync(completePath, JSON.stringify(full));
    assert.strictEqual(contractUsable(loadActionContract(completePath)), true);

    // Missing ONLY `gates`. This is the dangerous case: `action_types` is intact,
    // so the schema check passes, and an empty GATE_VERDICTS would make
    // `required_gate === GATE_VERDICTS.WAITING_HUMAN` compare undefined-to-undefined
    // and fail OPEN.
    const partialPath = join(dir, 'partial.json');
    const partial = { ...full };
    delete partial.gates;
    writeFileSync(partialPath, JSON.stringify(partial));
    assert.strictEqual(
      contractUsable(loadActionContract(partialPath)),
      false,
      'a contract missing gates must be rejected, otherwise the gate comparison fails open'
    );

    // Every required list is individually load-bearing.
    for (const key of REQUIRED_CONTRACT_LISTS) {
      const missingOne = { ...full };
      delete missingOne[key];
      const p = join(dir, `missing-${key}.json`);
      writeFileSync(p, JSON.stringify(missingOne));
      assert.strictEqual(contractUsable(loadActionContract(p)), false, `a contract missing ${key} must be rejected`);
    }

    // Empty lists are as bad as missing ones.
    writeFileSync(partialPath, JSON.stringify({ ...full, gates: [] }));
    assert.strictEqual(contractUsable(loadActionContract(partialPath)), false, 'an empty gates list must be rejected');

    // Unreadable file -> rejected, never silently defaulted.
    assert.strictEqual(contractUsable(loadActionContract(join(dir, 'does-not-exist.json'))), false);
    const brokenPath = join(dir, 'broken.json');
    writeFileSync(brokenPath, '{ not json ');
    const broken = loadActionContract(brokenPath);
    assert.strictEqual(contractUsable(broken), false);
    assert.ok(broken.error, 'a parse failure must be reported, not swallowed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ ACA-3
test('ACA-3: no hand-written copy of the enums may return (drift guard)', () => {
  // Re-adding a constant here would let the contract drift from its enforcement
  // again, which is exactly how three of the four lists went unread.
  const guarded = [
    join(ROOT_DIR, 'intent', 'asset-classifier.mjs'),
    join(ROOT_DIR, 'intent', 'action-validator.mjs'),
  ];
  for (const file of guarded) {
    const source = readFileSync(file, 'utf8');
    for (const name of ['TARGET_ASSET_TYPES', 'IMPACT_SCOPES', 'GATE_VERDICTS', 'CANONICAL_ACTION_TYPES']) {
      assert.ok(
        !new RegExp(`export const ${name}\\s*=\\s*Object\\.freeze\\(\\s*\\{`).test(source),
        `${file} must not define ${name} as a constant; it belongs to contracts/action-types.json`
      );
    }
  }
  // ...and they must actually be read from the contract module.
  const validator = readFileSync(join(ROOT_DIR, 'intent', 'action-validator.mjs'), 'utf8');
  assert.ok(/from '\.\/action-contract\.mjs'/.test(validator), 'the validator must import the contract reader');
  assert.ok(/isActionContractUsable\(\)/.test(validator), 'the validator must guard on contract usability');
});

// ------------------------------------------------------------------ ACA-4
test('ACA-4: an unusable contract makes the validator refuse, end to end', () => {
  const dir = tmpDir('af-aca4-');
  try {
    const full = JSON.parse(readFileSync(ACTION_CONTRACT_FILE, 'utf8'));
    const partial = { ...full };
    delete partial.impact_scopes;
    const partialPath = join(dir, 'partial.json');
    writeFileSync(partialPath, JSON.stringify(partial));

    const probe = `
      const { validateAndComputeEffectiveAction } = await import(${JSON.stringify(join(ROOT_DIR, 'intent', 'action-validator.mjs'))});
      try {
        validateAndComputeEffectiveAction({ contract_version: '1.0', action_type: 'READ' }, {}, null);
        process.stdout.write('DECIDED');
      } catch (err) {
        process.stdout.write('THREW:' + (err.code ?? 'NO_CODE'));
      }
    `;
    const run = (contractPath) => execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      env: { ...process.env, AF_ACTION_CONTRACT: contractPath },
      encoding: 'utf8',
    }).trim();

    assert.strictEqual(
      run(partialPath),
      'THREW:ACTION_CONTRACT_UNUSABLE',
      'a contract missing a required list must refuse to decide, not decide with empty enums'
    );
    assert.strictEqual(run(ACTION_CONTRACT_FILE), 'DECIDED', 'the shipped contract must still allow a decision');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ ACA-5
test('ACA-5: the shipped contract is usable', () => {
  assert.strictEqual(isActionContractUsable(), true, `shipped contract problem: ${ACTION_CONTRACT.error ?? 'none'}`);
  assert.strictEqual(ACTION_CONTRACT.error, null, 'the shipped contract must parse');
});

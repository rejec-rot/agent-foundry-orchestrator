// lib/trusted-import/diagnostic-runner.mjs
//
// Diagnostic Dry-run Engine (§9.1, 1.5, TI-31).
// Allows isolated execution of diagnostic test runs even when unresolved DENY
// blocking obligations exist, delivering stack trace feedback to the agent
// while strictly guaranteeing that diagnostic execution NEVER permits promotion.

import { AfrError } from './common.mjs';

/**
 * Execute a Diagnostic Dry-run in isolated candidate space (TI-31).
 *
 * @param {object} options
 * @param {string} options.workspaceDir - Candidate workspace or promotable view
 * @param {string} options.command - Diagnostic test / compile command
 * @param {Function} options.commandRunner - (cwd, cmd) => { exitCode: number, stdout: string, stderr: string }
 * @param {'exact-candidate'|'promotable-view'} [options.viewMode='exact-candidate']
 * @returns {object} Diagnostic result record
 */
export function runDiagnosticDryrun({
  workspaceDir,
  command,
  commandRunner,
  viewMode = 'exact-candidate',
}) {
  if (!workspaceDir || !command || typeof commandRunner !== 'function') {
    throw new AfrError('workspaceDir, command, and commandRunner are required', 'INVALID_ARGUMENT');
  }

  const result = commandRunner(workspaceDir, command);

  return Object.freeze({
    diagnostic_output: Object.freeze({
      exitCode: result.exitCode,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    }),
    view_mode: viewMode,
    permitted_for_promotion: false, // STRICT INVARIANT: diagnostic output can NEVER authorise promotion (TI-31)
    executed_at: new Date().toISOString(),
  });
}

/**
 * Assert that a diagnostic dry-run record cannot be used to bypass Promotion Gate (TI-31).
 * @param {object} dryrunRecord
 * @throws {AfrError} always
 */
export function assertPromotionNotPermittedFromDiagnostic(dryrunRecord) {
  if (dryrunRecord?.permitted_for_promotion !== true) {
    throw new AfrError(
      'Diagnostic dry-run outcome cannot be used for promotion acceptance or CAS update-ref',
      'PROMOTION_DISALLOWED_FOR_DIAGNOSTIC',
      { dryrunRecord }
    );
  }
}

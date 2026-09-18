// real-cli.mjs - shared policy for tests that run CLIs installed on the HOST.
//
// Most of this suite is hermetic: it drives stubs and fixtures. A few tests go
// further and exercise a REAL vendor CLI, which is what makes them worth having -
// and also what makes them observe mutable host state. Concretely: `command-code`
// auto-updates itself, so `command-code --version` emitted
//     Updated 1.54.2 -> 1.56.0
//     1.56.0
// and a naive `.trim()` capture failed the assertion even though the sandbox was
// correct. The suite then reported a failure that had nothing to do with the code
// under test.
//
// Two rules follow, applied here so every real-CLI test shares them:
//
//   1. An explicit, overridable gate. Default ON, so the integration keeps being
//      proven; AF_REAL_CLI_TESTS=0 turns the real-CLI tests off for a hermetic CI.
//   2. Version output is parsed as "the last line that looks like a semver", not
//      the whole blob, so a self-updating CLI's notice cannot break the compare.

/**
 * Skip reason for host-CLI integration tests, or false to run them.
 * @returns {string|false} a skip reason, or false.
 */
export function realCliSkip() {
  const raw = String(process.env.AF_REAL_CLI_TESTS ?? '1').toLowerCase();
  return raw === '0' || raw === 'off' || raw === 'false'
    ? 'AF_REAL_CLI_TESTS=0: real host-CLI integration tests are disabled'
    : false;
}

/**
 * Extract the last semver-looking token from command output.
 *
 * Scans from the end so a self-update notice printed before the version cannot
 * win. Returns '' when nothing matches, so a caller can assert instead of
 * silently comparing empty strings.
 *
 * @param {string} text - command output.
 * @returns {string} the version, or ''.
 */
export function lastSemver(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /(?:^|\s)(\d+\.\d+\.\d+)\b/.exec(lines[index]);
    if (match) return match[1];
  }
  return '';
}

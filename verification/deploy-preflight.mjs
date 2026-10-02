#!/usr/bin/env node
// deploy-preflight.mjs - the Web/V2 delivery verification (P4).
//
// This is the "isolated deployment verification" the plan asks for, reduced to what can honestly be
// checked WITHOUT root and WITHOUT touching a real host: the deployment inputs (node path, unit
// files, env examples, directories, loopback/port agreement, credential hygiene) are validated, and
// everything that genuinely needs privileges or a live model is reported as NOT VERIFIED here rather
// than implied to work.
//
// Usage: node verification/deploy-preflight.mjs [--port <n>] [--host <addr>]
// Exit:  0 = every checkable item passed; 1 = at least one failure.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fallback = null) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const note = (text) => console.log(`NOTE  ${text}`);

// ---------------------------------------------------------------- 1. runtime prerequisites
const nodePath = process.execPath;
check('the interpreter running this check is an absolute path (systemd cannot use a bare `node`)', nodePath.startsWith('/'), nodePath);
check('that interpreter exists and is executable', existsSync(nodePath) && (statSync(nodePath).mode & 0o111) !== 0, nodePath);

const major = Number(process.versions.node.split('.')[0]);
check('node major version satisfies the engines requirement (>=20)', major >= 20, process.versions.node);

// ---------------------------------------------------------------- 2. the workbench itself
const webFiles = ['web/index.html', 'web/app.js', 'web/styles.css'];
for (const rel of webFiles) check(`the workbench asset exists: ${rel}`, existsSync(join(ROOT, rel)));
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
// Only REAL fetch targets count: a `data:` favicon legitimately embeds the SVG XML namespace
// (`xmlns='http://www.w3.org/2000/svg'`), which is a name, not a network reference.
const externalRefs = [
  ...[...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1]),
  ...[...readFileSync(join(ROOT, 'web', 'styles.css'), 'utf8').matchAll(/url\(\s*['"]?([^'")]+)/g)].map((m) => m[1]),
  ...[...readFileSync(join(ROOT, 'web', 'app.js'), 'utf8').matchAll(/(?:fetch|import)\(\s*['"`](https?:\/\/[^'"`]+)/g)].map((m) => m[1]),
].filter((v) => /^https?:\/\//i.test(v) && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(v));
check('the page never fetches an external origin (works offline)', externalRefs.length === 0, externalRefs.join(', ') || 'no remote src/href/url()/fetch');
check('every control the page shows has an id the script binds', (() => {
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  const ids = [...app.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`));
  check('  (ids present in the markup)', missing.length === 0, missing.join(', ') || 'all present');
  return missing.length === 0;
})());

// ---------------------------------------------------------------- 3. write-path hygiene
const apiSource = readFileSync(join(ROOT, 'server', 'read-api.mjs'), 'utf8');
check('the API never calls executeTask directly (the request must not own a run)', !/executeTask\s*\(/.test(apiSource));
check('the API never calls the legacy submitTask', !/submitTask\s*\(/.test(apiSource));
check('the API never echoes the write token', !/token\.token/.test(apiSource));
const authSource = readFileSync(join(ROOT, 'server', 'web-auth.mjs'), 'utf8');
check('token comparison is constant time', /timingSafeEqual/.test(authSource));
check('a missing token configuration disables writes instead of opening them', /writes are disabled/.test(authSource));

// ---------------------------------------------------------------- 4. systemd units (A1a / notify)
const unitDir = join(ROOT, 'deploy', 'systemd');
if (existsSync(unitDir)) {
  for (const name of readdirSync(unitDir).filter((f) => f.endsWith('.service'))) {
    const body = readFileSync(join(unitDir, name), 'utf8');
    check(`${name}: ExecStart uses the absolute-interpreter placeholder, not /usr/bin/env`, /ExecStart=__AF_NODE__/.test(body) && !/ExecStart=\/usr\/bin\/env/.test(body));
    check(`${name}: the service itself is not enable-able (only its timer is)`, !/^WantedBy=/m.test(body), 'no [Install] WantedBy');
    check(`${name}: no credential values are embedded`, !/(API_KEY|TOKEN|SECRET|PASSWORD)=/i.test(body));
  }
  for (const name of readdirSync(unitDir).filter((f) => f.endsWith('.timer'))) {
    const body = readFileSync(join(unitDir, name), 'utf8');
    check(`${name}: the timer is the enable-able half`, /WantedBy=/.test(body));
  }
} else {
  check('deploy/systemd exists', false, 'missing');
}

// ---------------------------------------------------------------- 5. env examples carry no secrets
const envDir = join(ROOT, 'deploy', 'env');
if (existsSync(envDir)) {
  for (const name of readdirSync(envDir)) {
    const body = readFileSync(join(envDir, name), 'utf8');
    const suspicious = body.split('\n').filter((l) => /(=|:\s*)(sk-|ghp_|xox|eyJ|Bearer\s)/.test(l));
    check(`${name}: contains no credential-looking value`, suspicious.length === 0, suspicious.join(' ').slice(0, 80));
  }
}

// ---------------------------------------------------------------- 6. listener agreement
const port = Number(valueOf('--port', 8787));
const host = valueOf('--host', '127.0.0.1');
check('the default bind address is loopback', host === '127.0.0.1' || host === '::1' || host === 'localhost', host);
check('the port is in the unprivileged range', port > 1024 && port < 65536, String(port));
const afAdmin = readFileSync(join(ROOT, 'af-admin.mjs'), 'utf8');
check('non-loopback binding still requires an explicit flag', /--allow-non-loopback/.test(afAdmin));
check('write mode refuses to start without a token', /--allow-write needs an operator token/.test(afAdmin));
check('the token file is suggested with mode 600', /umask 077/.test(afAdmin));

// ---------------------------------------------------------------- 7. what this check CANNOT prove
note('NOT VERIFIED HERE (and not claimed):');
note(`  - a real systemd install/enable of the units (needs root): sudo sh deploy/af-exec/provision.sh --apply`);
note('  - a live model run through the V2 pipeline (needs an authorised executor and budget)');
note('  - the unprivileged-executor isolation (needs the /etc/af-exec/claim.json a root provision writes)');
note('  - TLS/reverse-proxy termination: this server speaks plain HTTP and expects to stay on loopback');

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} deployment checks passed${failed.length ? `; FAILED: ${failed.map((c) => c.name).join(', ')}` : ''}`);
process.exit(failed.length === 0 ? 0 : 1);

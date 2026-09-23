# Deployment preparation (U4) — templates only

**Status: not deployed.** This directory ships *inert templates* for the two unattended
schedulers. Nothing here is installed, enabled or started, no real credentials are included, and
no service is running as a result of this batch. Enabling either scheduler is a separate,
explicitly authorised step (plan batches U5/U6).

## Two independent schedulers

The automatic boundary recovery (A1a) and the notification retry (`notify-flush`) are **two
separate responsibilities** (A1A-AUTO-RECOVERY-DESIGN.md §7). They deliberately share no success
field, no exit code and no scheduling loop, and they are installed as separate units with
separate state:

| | Boundary recovery (A1a) | Notification retry |
|---|---|---|
| Unit | `systemd/af-a1a-recovery.{service,timer}` | `systemd/af-boundary-notify.{service,timer}` |
| Config | `env/a1a.env.example` → `<config>/a1a.env` | `env/notify.env.example` → `<config>/notify.env` |
| Command | `af-admin a1a sweep` | `af-admin boundary notify-flush --confirm` |
| State | `<AF_A1A_QUEUE_FILE>` (`a1a/state.json`) | `<alerts file>.notify-pending.json` |
| Purpose | release a **real** retained boundary | deliver an **already-raised** alert |
| Exit codes | 0 none / 1 needs-human or exhausted / 3 unverifiable | 0 clear / 1 pending or exhausted / 3 unverifiable |

Neither unit's success is a condition for the other's. A delivered notification does **not** mean
the boundary was recovered, and a completed recovery does **not** mean any notification was
delivered. Do not merge the two into one unit, one loop or one status.

## Files

```
deploy/
  README.md
  systemd/af-a1a-recovery.service     systemd/af-a1a-recovery.timer
  systemd/af-boundary-notify.service  systemd/af-boundary-notify.timer
  env/a1a.env.example                 env/notify.env.example
```

Templates contain placeholders that **must** be replaced before use:

- `__AF_NODE__` — **absolute** path of the node binary (e.g. the output of `command -v node`).
  A systemd unit does not inherit your shell PATH, so a version-managed node (nvm/asdf/volta) is
  not found by a bare `node` and the unit fails with `203/EXEC`. Use the absolute path, or set an
  explicit `Environment=PATH=…` in the unit.
- `__AF_ROOT__` — absolute path of this repository checkout.
- `__AF_CONFIG_DIR__` — absolute path of the operator-owned private config directory
  (e.g. `/etc/agent-foundry`), **not** inside the repository.

## Private configuration (never committed with real values)

1. `install -d -m 700 <config dir>`
2. Copy the example(s): `install -m 600 deploy/env/a1a.env.example <config dir>/a1a.env`
   (and/or `notify.env`).
3. Edit the **private copy only**. Both examples default to `off`, so a copied-but-unedited file
   changes nothing.
4. Never commit webhook URLs, tokens or signing secrets. The examples contain placeholders on
   purpose (`__SET_IN_THE_PRIVATE_FILE__`).

The advisory decision model (TypeSafe / Jev) uses the same rule: copy
`env/decision.env.example` to `<config dir>/decision.env`, put the key there, `chmod 600`, and
keep it **outside the repository** (or rely on the repository's `*.env` ignore rule). With
`AF_DECISION_MODEL=off` (the default) the adapter never calls the network.

## Status queries (read-only, safe to run any time)

```
AF_BOUNDARY_AUDIT_DIR=<audit dir> node af-admin.mjs a1a status [--json]
AF_BOUNDARY_AUDIT_DIR=<audit dir> node af-admin.mjs a1a explain --canonical <dir> --cas <dir> [--json]
node af-admin.mjs boundary notify-status [--json]
```

- `a1a status` exit codes: `0` nothing to do, `1` an asset needs a human or is exhausted,
  `3` the scheduler state is unverifiable (**not** "empty").
- `notify-status` exit codes: `0` queue clear, `1` pending/exhausted, `3` unverifiable.

## Install / enable (manual; NOT done by this batch)

```sh
# 1. Fill the placeholders in the unit files (or copy them to /etc/systemd/system with the
#    placeholders already substituted).
# 2. Install the units:
#    install -m 644 deploy/systemd/af-*.service deploy/systemd/af-*.timer /etc/systemd/system/
systemctl daemon-reload
# 3. Enable ONLY the timer(s) you intend to run:
#    systemctl enable --now af-a1a-recovery.timer
#    systemctl enable --now af-boundary-notify.timer
```

## Authorising `live` (deliberate, separate step)

The A1a unit runs `a1a sweep` **without** `--confirm` on purpose, so enabling the timer by itself
can never perform a real recovery. To authorise live recovery:

1. Set `AF_A1A_MODE=live` in the private `a1a.env` **and** add `--confirm` to the unit's
   `ExecStart` — two deliberate edits, after the U5 authorisation checklist is signed off.
2. Keep the allowlist explicit and minimal.
3. Notification live mode is likewise a separate edit (`AF_BOUNDARY_NOTIFY_MODE=live`); the
   notify unit already carries `--confirm`.

Until then, `off` (default) makes every sweep a no-op with exit 0.

## Stop and restart

```sh
# Pause without losing evidence (recommended first step):
systemctl stop af-a1a-recovery.timer af-boundary-notify.timer
# Or freeze one asset by removing it from the allowlist (leave the unit running).
# A restart re-reads the private config and re-arms the timer:
systemctl restart af-a1a-recovery.timer
```

A stop does not delete any state or audit file. An in-flight recovery is not interrupted by
stopping the timer (it is a one-shot pass); do not kill a running `a1a sweep` mid-release.

## Rollback

1. `systemctl disable --now af-a1a-recovery.timer af-boundary-notify.timer`
2. Set `AF_A1A_MODE=off` (and `AF_BOUNDARY_NOTIFY_MODE=off`) in the private config.
3. Keep `a1a/`, `epochs/` and the recovery records — they are the evidence. Do not delete them.

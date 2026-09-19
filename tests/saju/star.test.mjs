// star.test.mjs — consent-gated GitHub Star helper contract.
//
// Exercises skills/saju/scripts/star-repo.sh and its install.sh wiring with
// real subprocesses against a STATEFUL fake `gh` on a PATH-scoped temp bin
// dir — the host's real gh (authenticated as min9lin9) is never invoked.
// The fixture reproduces `HTTP/2 <code>` status lines for --include parsing,
// gh's exit codes, and failure modes (noauth / forbidden / netfail /
// putnoop). It starts "unstarred": GET reflects the state file, only the
// exact authorized PUT mutates it, and a final independent GET — never the
// invocation log alone — proves the write.
//
// TTY coverage uses an embedded Python-stdlib PTY driver (test-only, no new
// runtime dependency): select()-driven reads under a bounded monotonic
// deadline, no sleeps, no polling for output. The fake-gh invocation log
// proves no gh call — including `auth status` — happens before consent.
//
// Every temp dir is removed in try/finally with a logged cleanup receipt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const HELPER = join(repoRoot, 'skills', 'saju', 'scripts', 'star-repo.sh');
const INSTALLER = join(repoRoot, 'install.sh');
const STARRED_PATH = '/user/starred/min9lin9/saju-agent';
const REPO_URL = 'https://github.com/min9lin9/saju-agent';

const which = (name) => {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
};
const BASH = which('bash') ?? '/usr/bin/bash';
const PYTHON3 = which('python3');

// --- stateful fake gh fixture ------------------------------------------------
// Env contract: FAKE_GH_LOG (append-only invocation log, one "$*" line per
// call), FAKE_GH_STATE (file holding "starred"/"unstarred"), FAKE_GH_MODE
// (ok | noauth | forbidden | netfail | putnoop). GET reflects the state file;
// only PUT on the exact starred endpoint mutates it — putnoop returns 204
// without mutating so the helper's confirming GET must catch it.
const FAKE_GH = `#!/bin/bash
# fake-gh — STATEFUL fixture for star-repo.sh tests. Never the real gh.
# Absolute /bin/bash shebang: the fixture bin dir is the whole PATH.
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
MODE="$FAKE_GH_MODE"

respond() {
  # $1 = numeric status, $2 = body ('' for none), $3 = process exit code.
  # Reproduces gh api --include: HTTP status line + headers on stdout,
  # gh-style error line on stderr for non-2xx.
  printf 'HTTP/2 %s\\n' "$1"
  printf 'date: Fri, 19 Sep 2026 00:00:00 GMT\\n'
  printf 'server: fake-gh-fixture\\n'
  printf '\\n'
  [ -n "$2" ] && printf '%s\\n' "$2"
  if [ "$3" -ne 0 ]; then
    printf 'gh: fixture response (HTTP %s)\\n' "$1" >&2
  fi
  exit "$3"
}

case "$1" in
  auth)
    if [ "$2" = "status" ] && [ "$MODE" != "noauth" ]; then
      printf 'github.com\\n' >&2
      printf '  - Logged in to github.com account fixture-user (keyring)\\n' >&2
      exit 0
    fi
    printf 'gh: not logged in to github.com\\n' >&2
    exit 1
    ;;
  api)
    shift
    method="GET"
    endpoint=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --method|-X) method="$2"; shift 2 ;;
        --hostname) shift 2 ;;
        -*) shift ;;
        *) endpoint="$1"; shift ;;
      esac
    done
    if [ "$MODE" = "netfail" ]; then
      printf 'gh: error connecting to api.github.com: dial tcp: lookup api.github.com: no such host\\n' >&2
      exit 1
    fi
    if [ "$endpoint" != "/user/starred/min9lin9/saju-agent" ]; then
      respond 404 '{"message":"Not Found"}' 1
    fi
    if [ "$MODE" = "forbidden" ]; then
      respond 403 '{"message":"Forbidden"}' 1
    fi
    case "$method" in
      GET)
        if [ "$(<"$FAKE_GH_STATE")" = "starred" ]; then
          respond 204 '' 0
        fi
        respond 404 '{"message":"Not Found"}' 1
        ;;
      PUT)
        if [ "$MODE" != "putnoop" ]; then
          printf 'starred\\n' > "$FAKE_GH_STATE"
        fi
        respond 204 '' 0
        ;;
      *)
        printf 'gh: unsupported method %s\\n' "$method" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    printf 'gh: unknown command %s\\n' "$1" >&2
    exit 1
    ;;
esac
`;

// --- embedded Python-stdlib PTY driver ---------------------------------------
// Spawns a child with stdin/stdout attached to a PTY or a pipe independently
// (stderr follows stdout), writes the optional --input bytes to child stdin,
// captures all output bytes to --output, and exits with the child's status.
// Reads are select()-driven under a monotonic deadline; on expiry the child
// is SIGKILLed and the driver exits 124. No sleeps, no third-party deps.
const PY_DRIVER = `#!/usr/bin/env python3
import errno
import os
import select
import subprocess
import sys
import time


def main():
    args = sys.argv[1:]
    opt = {"output": None, "input": None, "stdin": "pty",
           "stdout": "pty", "timeout": "30"}
    cmd = None
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            cmd = args[i + 1:]
            break
        if a in ("--output", "--input", "--stdin", "--stdout", "--timeout"):
            if i + 1 >= len(args):
                sys.stderr.write("pty-driver: %s needs a value\\n" % a)
                return 2
            opt[a[2:]] = args[i + 1]
            i += 2
            continue
        sys.stderr.write("pty-driver: bad arg %s\\n" % a)
        return 2
    if not cmd or opt["output"] is None:
        sys.stderr.write("pty-driver: need --output FILE and -- argv\\n")
        return 2
    if opt["stdin"] not in ("pty", "pipe", "devnull"):
        sys.stderr.write("pty-driver: bad --stdin mode\\n")
        return 2
    if opt["stdout"] not in ("pty", "pipe"):
        sys.stderr.write("pty-driver: bad --stdout mode\\n")
        return 2
    timeout = float(opt["timeout"])
    data = b""
    if opt["input"]:
        with open(opt["input"], "rb") as f:
            data = f.read()

    master = None
    slave = None
    if opt["stdin"] == "pty" or opt["stdout"] == "pty":
        master, slave = os.openpty()

    if opt["stdin"] == "pty":
        stdin_arg = slave
    elif opt["stdin"] == "pipe":
        stdin_arg = subprocess.PIPE
    else:
        stdin_arg = subprocess.DEVNULL
    stdout_arg = slave if opt["stdout"] == "pty" else subprocess.PIPE
    stderr_arg = slave if opt["stdout"] == "pty" else subprocess.STDOUT

    proc = subprocess.Popen(cmd, stdin=stdin_arg, stdout=stdout_arg,
                            stderr=stderr_arg, close_fds=True)
    if slave is not None:
        os.close(slave)

    if data:
        try:
            if opt["stdin"] == "pty" and master is not None:
                os.write(master, data)
            elif opt["stdin"] == "pipe" and proc.stdin is not None:
                proc.stdin.write(data)
                proc.stdin.flush()
        except OSError:
            pass

    captured = bytearray()
    fds = []
    if master is not None:
        fds.append(master)
    if opt["stdout"] == "pipe" and proc.stdout is not None:
        fds.append(proc.stdout.fileno())

    deadline = time.monotonic() + timeout
    timed_out = False
    while True:
        if proc.poll() is not None and not fds:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            timed_out = True
            proc.kill()
            proc.wait()
            break
        if not fds:
            try:
                proc.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                pass
            continue
        try:
            rlist, _, _ = select.select(fds, [], [], min(remaining, 0.25))
        except InterruptedError:
            continue
        for fd in rlist:
            try:
                chunk = os.read(fd, 65536)
            except OSError as e:
                if e.errno == errno.EIO:
                    chunk = b""
                else:
                    raise
            if chunk:
                captured += chunk
            else:
                fds.remove(fd)
                try:
                    os.close(fd)
                except OSError:
                    pass

    if proc.stdin is not None:
        try:
            proc.stdin.close()
        except OSError:
            pass
    if master is not None:
        try:
            os.close(master)
        except OSError:
            pass
    with open(opt["output"], "wb") as f:
        f.write(bytes(captured))
    if timed_out:
        sys.stderr.write("pty-driver: deadline exceeded; child killed\\n")
        return 124
    return proc.returncode if proc.returncode is not None else 124


if __name__ == "__main__":
    sys.exit(main())
`;

const CALL_AUTH = 'auth status --hostname github.com';
const CALL_GET = `api --hostname github.com --include --method GET ${STARRED_PATH}`;
const CALL_PUT = `api --hostname github.com --include --method PUT ${STARRED_PATH}`;

const cleanup = (t, dir) => {
  rmSync(dir, { recursive: true, force: true });
  t.diagnostic(`cleanup receipt: removed ${dir} (exists=${existsSync(dir)})`);
};

// Isolated fixture root: bin/ holds symlinked host tools plus the fake gh;
// env is PATH-scoped to bin/ so the real gh can never be reached.
const makeFixture = (t, { mode = 'ok', starred = false, tools = ['awk'], withGh = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'saju-star-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const tool of tools) {
    const src = which(tool);
    assert.ok(src, `test requires host tool: ${tool}`);
    symlinkSync(src, join(bin, tool));
  }
  const state = join(root, 'gh-state');
  writeFileSync(state, starred ? 'starred\n' : 'unstarred\n');
  const log = join(root, 'gh-invocations.log');
  if (withGh) {
    writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  }
  const env = {
    ...process.env,
    PATH: bin,
    HOME: root,
    FAKE_GH_LOG: log,
    FAKE_GH_STATE: state,
    FAKE_GH_MODE: mode,
  };
  return { root, bin, log, state, env };
};

const ghCalls = (log) =>
  existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter((l) => l.length > 0)
    : [];

// Non-TTY helper run: stdin is /dev/null, stdout/stderr are pipes.
const runHelper = (env, args = []) =>
  spawnSync(BASH, [HELPER, ...args], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  });

// PTY/pipe run via the embedded driver. Returns {status, output, stderr}.
const runPty = (root, { tag, argv, env, input, stdin = 'pty', stdout = 'pty', timeout = 30 }) => {
  const driver = join(root, 'pty-driver.py');
  if (!existsSync(driver)) writeFileSync(driver, PY_DRIVER);
  const outFile = join(root, `${tag}.out`);
  const args = [
    driver, '--output', outFile,
    '--stdin', stdin, '--stdout', stdout, '--timeout', String(timeout),
  ];
  if (input !== undefined) {
    const inFile = join(root, `${tag}.in`);
    writeFileSync(inFile, input);
    args.push('--input', inFile);
  }
  args.push('--', ...argv);
  const proc = spawnSync(PYTHON3, args, {
    encoding: 'utf8', env, timeout: (timeout + 30) * 1000,
  });
  assert.equal(proc.error, undefined, `pty driver spawn error: ${proc.error}`);
  const output = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  return { status: proc.status, output, stderr: proc.stderr };
};

// Independent write proof: a fresh GET straight at the fixture, outside the
// helper under test.
const independentGet = (bin, env) =>
  spawnSync(join(bin, 'gh'), [
    'api', '--hostname', 'github.com', '--include', '--method', 'GET', STARRED_PATH,
  ], { encoding: 'utf8', env, timeout: 15000 });

// --- consent gate ------------------------------------------------------------

test('non-TTY: STAR_CONSENT_REQUIRED, no prompt, zero gh calls', (t) => {
  const fx = makeFixture(t);
  try {
    const p = runHelper(fx.env);
    assert.equal(p.error, undefined, `spawn error: ${p.error}`);
    assert.equal(p.status, 0, `exit ${p.status}; stderr: ${p.stderr}`);
    assert.equal(p.stdout.trim(), `STAR_CONSENT_REQUIRED ${REPO_URL}`);
    assert.ok(!p.stderr.includes('남길까요'), 'prompt must not appear without TTY');
    assert.deepEqual(ghCalls(fx.log), []);
  } finally {
    cleanup(t, fx.root);
  }
});

test('half-TTY: stdin TTY + stdout pipe → STAR_CONSENT_REQUIRED without reading', (t) => {
  const fx = makeFixture(t);
  try {
    // 'y' is waiting on the terminal: a wrong implementation that reads stdin
    // would consume it and proceed to gh calls — the log catches that.
    const r = runPty(fx.root, {
      tag: 'half-stdin', argv: [BASH, HELPER], env: fx.env,
      input: 'y\n', stdin: 'pty', stdout: 'pipe',
    });
    assert.equal(r.status, 0, `driver stderr: ${r.stderr}\noutput: ${r.output}`);
    assert.ok(r.output.includes(`STAR_CONSENT_REQUIRED ${REPO_URL}`), r.output);
    assert.ok(!r.output.includes('남길까요'), 'prompt must not appear without both TTYs');
    assert.deepEqual(ghCalls(fx.log), []);
  } finally {
    cleanup(t, fx.root);
  }
});

test('half-TTY: stdout TTY + stdin pipe → STAR_CONSENT_REQUIRED without waiting', (t) => {
  const fx = makeFixture(t);
  try {
    // 'y' sits on the held-open stdin pipe: a read would consume it (gh calls
    // in the log) and a blocking wait would hit the driver deadline (124).
    const r = runPty(fx.root, {
      tag: 'half-stdout', argv: [BASH, HELPER], env: fx.env,
      input: 'y\n', stdin: 'pipe', stdout: 'pty',
    });
    assert.equal(r.status, 0, `driver stderr: ${r.stderr}\noutput: ${r.output}`);
    assert.ok(r.output.includes(`STAR_CONSENT_REQUIRED ${REPO_URL}`), r.output);
    assert.ok(!r.output.includes('남길까요'), 'prompt must not appear without both TTYs');
    assert.deepEqual(ghCalls(fx.log), []);
  } finally {
    cleanup(t, fx.root);
  }
});

test('PTY consent "y" → STAR_ADDED; state mutated; confirming GET 204', (t) => {
  const fx = makeFixture(t);
  try {
    const r = runPty(fx.root, {
      tag: 'pty-y', argv: [BASH, HELPER], env: fx.env, input: 'y\n',
    });
    assert.equal(r.status, 0, `driver stderr: ${r.stderr}\noutput: ${r.output}`);
    assert.ok(r.output.includes('GitHub Star를 남길까요? [y/N]'), `prompt missing:\n${r.output}`);
    assert.ok(r.output.includes(`STAR_ADDED ${REPO_URL}`), r.output);
    // Every gh call happened after consent, in exactly this order.
    assert.deepEqual(ghCalls(fx.log), [CALL_AUTH, CALL_GET, CALL_PUT, CALL_GET]);
    // Write proof beyond the log: state file + independent GET.
    assert.equal(readFileSync(fx.state, 'utf8').trim(), 'starred');
    const get = independentGet(fx.bin, fx.env);
    assert.equal(get.status, 0, `independent GET: ${get.stderr}`);
    assert.match(get.stdout, /^HTTP\/2 204/m);
  } finally {
    cleanup(t, fx.root);
  }
});

test('PTY consent "YeS" (case-insensitive yes) → STAR_ADDED', (t) => {
  const fx = makeFixture(t);
  try {
    const r = runPty(fx.root, {
      tag: 'pty-yes', argv: [BASH, HELPER], env: fx.env, input: 'YeS\n',
    });
    assert.equal(r.status, 0, `driver stderr: ${r.stderr}\noutput: ${r.output}`);
    assert.ok(r.output.includes(`STAR_ADDED ${REPO_URL}`), r.output);
    assert.equal(readFileSync(fx.state, 'utf8').trim(), 'starred');
  } finally {
    cleanup(t, fx.root);
  }
});

for (const [label, input] of [
  ['n', 'n\n'],
  ['empty line', '\n'],
  ['EOF (Ctrl-D)', '\x04'],
]) {
  test(`PTY decline via ${label} → STAR_SKIPPED, zero gh calls`, (t) => {
    const fx = makeFixture(t);
    try {
      const r = runPty(fx.root, {
        tag: `decline-${label.replace(/[^a-z]+/gi, '-')}`,
        argv: [BASH, HELPER], env: fx.env, input,
      });
      assert.equal(r.status, 0, `driver stderr: ${r.stderr}\noutput: ${r.output}`);
      assert.ok(r.output.includes('GitHub Star를 남길까요? [y/N]'), `prompt missing:\n${r.output}`);
      assert.ok(r.output.includes(`STAR_SKIPPED ${REPO_URL}`), r.output);
      assert.deepEqual(ghCalls(fx.log), []);
      assert.equal(readFileSync(fx.state, 'utf8').trim(), 'unstarred');
    } finally {
      cleanup(t, fx.root);
    }
  });
}

// --- gh flow -----------------------------------------------------------------

test('already starred → STAR_ALREADY_PRESENT, no PUT', (t) => {
  const fx = makeFixture(t, { starred: true });
  try {
    const p = runHelper(fx.env, ['--consent']);
    assert.equal(p.error, undefined, `spawn error: ${p.error}`);
    assert.equal(p.status, 0, `exit ${p.status}; stderr: ${p.stderr}`);
    assert.equal(p.stdout.trim(), `STAR_ALREADY_PRESENT ${REPO_URL}`);
    assert.deepEqual(ghCalls(fx.log), [CALL_AUTH, CALL_GET]);
    const get = independentGet(fx.bin, fx.env);
    assert.equal(get.status, 0, `independent GET: ${get.stderr}`);
    assert.match(get.stdout, /^HTTP\/2 204/m);
  } finally {
    cleanup(t, fx.root);
  }
});

test('--consent non-interactive → STAR_ADDED + state + confirming GET', (t) => {
  const fx = makeFixture(t);
  try {
    const p = runHelper(fx.env, ['--consent']);
    assert.equal(p.error, undefined, `spawn error: ${p.error}`);
    assert.equal(p.status, 0, `exit ${p.status}; stderr: ${p.stderr}`);
    assert.equal(p.stdout.trim(), `STAR_ADDED ${REPO_URL}`);
    assert.deepEqual(ghCalls(fx.log), [CALL_AUTH, CALL_GET, CALL_PUT, CALL_GET]);
    assert.equal(readFileSync(fx.state, 'utf8').trim(), 'starred');
    const get = independentGet(fx.bin, fx.env);
    assert.equal(get.status, 0, `independent GET: ${get.stderr}`);
    assert.match(get.stdout, /^HTTP\/2 204/m);
  } finally {
    cleanup(t, fx.root);
  }
});

test('gh CLI missing → STAR_UNAVAILABLE exit 1, zero gh calls', (t) => {
  const fx = makeFixture(t, { withGh: false });
  try {
    const p = runHelper(fx.env, ['--consent']);
    assert.equal(p.error, undefined, `spawn error: ${p.error}`);
    assert.equal(p.status, 1, `exit ${p.status}; stdout: ${p.stdout}`);
    assert.equal(p.stdout.trim(), `STAR_UNAVAILABLE ${REPO_URL}`);
    assert.deepEqual(ghCalls(fx.log), []);
  } finally {
    cleanup(t, fx.root);
  }
});

test('gh auth missing → STAR_UNAVAILABLE exit 1, no api calls', (t) => {
  const fx = makeFixture(t, { mode: 'noauth' });
  try {
    const p = runHelper(fx.env, ['--consent']);
    assert.equal(p.error, undefined, `spawn error: ${p.error}`);
    assert.equal(p.status, 1, `exit ${p.status}; stdout: ${p.stdout}`);
    assert.equal(p.stdout.trim(), `STAR_UNAVAILABLE ${REPO_URL}`);
    assert.deepEqual(ghCalls(fx.log), [CALL_AUTH]);
  } finally {
    cleanup(t, fx.root);
  }
});

test('GET 403 → STAR_FAILED exit 1, no PUT, state unchanged', (t) => {
  const fx = makeFixture(t, { mode: 'forbidden' });
  try {
    const p = runHelper(fx.env, ['--consent']);
    assert.equal(p.error, undefined, `spawn error: ${p.error}`);
    assert.equal(p.status, 1, `exit ${p.status}; stdout: ${p.stdout}`);
    assert.equal(p.stdout.trim(), `STAR_FAILED ${REPO_URL}`);
    assert.match(p.stderr, /HTTP\/2 403/, 'gh diagnostics must reach stderr');
    assert.deepEqual(ghCalls(fx.log), [CALL_AUTH, CALL_GET]);
    assert.equal(readFileSync(fx.state, 'utf8').trim(), 'unstarred');
  } finally {
    cleanup(t, fx.root);
  }
});

test('network failure → STAR_FAILED exit 1 (no HTTP status parsed)', (t) => {
  const fx = makeFixture(t, { mode: 'netfail' });
  try {
    const p = runHelper(fx.env, ['--consent']);
    assert.equal(p.error, undefined, `spawn error: ${p.error}`);
    assert.equal(p.status, 1, `exit ${p.status}; stdout: ${p.stdout}`);
    assert.equal(p.stdout.trim(), `STAR_FAILED ${REPO_URL}`);
    assert.deepEqual(ghCalls(fx.log), [CALL_AUTH, CALL_GET]);
    assert.equal(readFileSync(fx.state, 'utf8').trim(), 'unstarred');
  } finally {
    cleanup(t, fx.root);
  }
});

test('PUT 204 but unconfirmed → STAR_FAILED, no false success', (t) => {
  const fx = makeFixture(t, { mode: 'putnoop' });
  try {
    const p = runHelper(fx.env, ['--consent']);
    assert.equal(p.error, undefined, `spawn error: ${p.error}`);
    assert.equal(p.status, 1, `exit ${p.status}; stdout: ${p.stdout}`);
    assert.equal(p.stdout.trim(), `STAR_FAILED ${REPO_URL}`);
    assert.deepEqual(ghCalls(fx.log), [CALL_AUTH, CALL_GET, CALL_PUT, CALL_GET]);
    assert.equal(readFileSync(fx.state, 'utf8').trim(), 'unstarred');
  } finally {
    cleanup(t, fx.root);
  }
});

test('unknown arguments → exit 2, zero gh calls', (t) => {
  const fx = makeFixture(t);
  try {
    for (const args of [['--bogus'], ['consent'], ['--consent', '--bogus']]) {
      const p = runHelper(fx.env, args);
      assert.equal(p.error, undefined, `spawn error: ${p.error}`);
      assert.equal(p.status, 2, `args ${args}: exit ${p.status}; stdout: ${p.stdout}`);
    }
    assert.deepEqual(ghCalls(fx.log), []);
  } finally {
    cleanup(t, fx.root);
  }
});

// --- install.sh wiring -------------------------------------------------------

// Tools install.sh needs on PATH beyond the fake gh (node/npm/openclaw are
// deliberately absent → fast PROVIDER-ONLY path, no npm ci, no network).
const INSTALL_TOOLS = [
  'bash', 'sh', 'cat', 'mkdir', 'tar', 'find', 'sed', 'rm', 'mktemp',
  'dirname', 'grep', 'awk',
];

test('install non-TTY: helper runs once → STAR_CONSENT_REQUIRED, zero gh calls, exit 0', (t) => {
  const fx = makeFixture(t, { tools: [...INSTALL_TOOLS, 'curl'] });
  const ws = join(fx.root, 'workspace');
  try {
    const p = spawnSync(BASH, [INSTALLER], {
      encoding: 'utf8',
      env: { ...fx.env, OPENCLAW_WORKSPACE: ws },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    assert.equal(p.error, undefined, `spawn error: ${p.error}`);
    const out = p.stdout + p.stderr;
    assert.match(out, /STATUS: PROVIDER-ONLY/);
    assert.equal(p.status, 0, `install.sh exit ${p.status}\noutput:\n${out}`);
    assert.ok(existsSync(join(ws, 'skills', 'saju', 'scripts', 'star-repo.sh')),
      'helper must be copied into the destination');
    const starLines = out.split('\n').filter((l) => l.includes('STAR_'));
    assert.deepEqual(starLines, [`STAR_CONSENT_REQUIRED ${REPO_URL}`],
      'helper must emit the consent-required token exactly once');
    assert.deepEqual(ghCalls(fx.log), []);
  } finally {
    cleanup(t, fx.root);
  }
});

test('PTY install + consent y → STAR_ADDED once at end, install exit 0', (t) => {
  const fx = makeFixture(t, { tools: [...INSTALL_TOOLS, 'curl'] });
  const ws = join(fx.root, 'workspace');
  try {
    const r = runPty(fx.root, {
      tag: 'install-y', argv: [BASH, INSTALLER],
      env: { ...fx.env, OPENCLAW_WORKSPACE: ws },
      input: 'y\n', timeout: 120,
    });
    assert.equal(r.status, 0, `driver stderr: ${r.stderr}\noutput: ${r.output}`);
    assert.match(r.output, /STATUS: PROVIDER-ONLY/);
    assert.ok(r.output.includes('GitHub Star를 남길까요? [y/N]'), `prompt missing:\n${r.output}`);
    assert.ok(r.output.includes(`STAR_ADDED ${REPO_URL}`), r.output);
    assert.equal((r.output.match(/STAR_/g) ?? []).length, 1,
      'helper must run exactly once per install');
    assert.deepEqual(ghCalls(fx.log), [CALL_AUTH, CALL_GET, CALL_PUT, CALL_GET]);
    assert.equal(readFileSync(fx.state, 'utf8').trim(), 'starred');
    const get = independentGet(fx.bin, fx.env);
    assert.equal(get.status, 0, `independent GET: ${get.stderr}`);
    assert.match(get.stdout, /^HTTP\/2 204/m);
  } finally {
    cleanup(t, fx.root);
  }
});

test('PTY install + consent y + gh 403 → STAR_FAILED but install still exit 0', (t) => {
  const fx = makeFixture(t, { mode: 'forbidden', tools: [...INSTALL_TOOLS, 'curl'] });
  const ws = join(fx.root, 'workspace');
  try {
    const r = runPty(fx.root, {
      tag: 'install-403', argv: [BASH, INSTALLER],
      env: { ...fx.env, OPENCLAW_WORKSPACE: ws },
      input: 'y\n', timeout: 120,
    });
    assert.match(r.output, /STATUS: PROVIDER-ONLY/);
    assert.ok(r.output.includes(`STAR_FAILED ${REPO_URL}`), r.output);
    assert.equal(r.status, 0,
      `helper failure must not fail the install\noutput: ${r.output}`);
    assert.deepEqual(ghCalls(fx.log), [CALL_AUTH, CALL_GET]);
    assert.equal(readFileSync(fx.state, 'utf8').trim(), 'unstarred');
  } finally {
    cleanup(t, fx.root);
  }
});

test('PTY install + decline n → STAR_SKIPPED, zero gh calls, install exit 0', (t) => {
  const fx = makeFixture(t, { tools: [...INSTALL_TOOLS, 'curl'] });
  const ws = join(fx.root, 'workspace');
  try {
    const r = runPty(fx.root, {
      tag: 'install-n', argv: [BASH, INSTALLER],
      env: { ...fx.env, OPENCLAW_WORKSPACE: ws },
      input: 'n\n', timeout: 120,
    });
    assert.equal(r.status, 0, `driver stderr: ${r.stderr}\noutput: ${r.output}`);
    assert.match(r.output, /STATUS: PROVIDER-ONLY/);
    assert.ok(r.output.includes(`STAR_SKIPPED ${REPO_URL}`), r.output);
    assert.deepEqual(ghCalls(fx.log), []);
    assert.equal(readFileSync(fx.state, 'utf8').trim(), 'unstarred');
  } finally {
    cleanup(t, fx.root);
  }
});

test('failed install never invokes the star helper', (t) => {
  // No curl, no node, no npm → FILES-ONLY exit 1 before the helper is reached.
  const fx = makeFixture(t, { tools: INSTALL_TOOLS });
  const ws = join(fx.root, 'workspace');
  try {
    const p = spawnSync(BASH, [INSTALLER], {
      encoding: 'utf8',
      env: { ...fx.env, OPENCLAW_WORKSPACE: ws },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    assert.equal(p.error, undefined, `spawn error: ${p.error}`);
    const out = p.stdout + p.stderr;
    assert.match(out, /STATUS: FILES-ONLY/);
    assert.equal(p.status, 1, `expected FILES-ONLY exit 1\noutput:\n${out}`);
    assert.ok(!out.includes('STAR_'),
      `star helper must not run on a failed install:\n${out}`);
    assert.deepEqual(ghCalls(fx.log), []);
  } finally {
    cleanup(t, fx.root);
  }
});

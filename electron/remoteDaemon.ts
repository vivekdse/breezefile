// Remote breezed daemon: install + lifecycle + connect (breezed plan P3).
//
// Each machine owns its own tasks. This module installs the headless
// `breezed` bundle on an ssh target, runs it under a persistent
// systemd --user service (linger so it survives logout AND reboot —
// self-linger needs no sudo on modern systemd), and opens a forward
// ssh tunnel so the laptop can talk to that machine's task store.
//
// Distribution reality (verified on the field server): npm's
// prebuild-install does NOT reliably fetch a better-sqlite3 prebuilt
// there, so we DON'T trust it — `npm install --ignore-scripts` lays
// down JS only (~1s), then we fetch the exact official prebuilt tarball
// for the server's Node ABI ourselves and drop in build/Release. gcc/
// make exist as a last resort but are never hit on the happy path.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { stateDir } from './core/profile.mjs';
import path from 'node:path';
import net from 'node:net';
import { app } from 'electron';

const STATE_DIR = stateDir();
const STATE_FILE = path.join(STATE_DIR, 'remote-daemon-installs.json');

/** better-sqlite3 semver from the app's package.json, normalized to the
 *  bare version used in the prebuilt asset filename. */
function betterSqliteVersion(): string {
  const pkgPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'package.json')
    : path.join(app.getAppPath(), 'package.json');
  const dep = (JSON.parse(readFileSync(pkgPath, 'utf8')).dependencies?.[
    'better-sqlite3'
  ] ?? '') as string;
  return dep.replace(/^[^\d]*/, '');
}

/** The bundled headless daemon source (built by `npm run build:daemon`).
 *  Packaged → resources; dev → repo daemon/dist. */
function readDaemonBundle(): string {
  const p = app.isPackaged
    ? path.join(process.resourcesPath, 'breezed.mjs')
    : path.join(app.getAppPath(), 'daemon', 'dist', 'breezed.mjs');
  return readFileSync(p, 'utf8');
}

function bundleHash(): string {
  return crypto
    .createHash('sha256')
    .update(readDaemonBundle())
    .update('\0')
    .update(betterSqliteVersion())
    .digest('hex');
}

type State = Record<string, { hash: string; at: number }>;
function loadState(): State {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
  } catch {
    return {};
  }
}
function saveState(s: State) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// Remote bash installer. Runs under `ssh <target> bash -s`. The daemon
// bundle is delivered base64 on a marker line (newline-safe). Steps:
// resolve a Node >=18 (prefer v20 LTS — best better-sqlite3 prebuilt
// coverage), stage files, npm install --ignore-scripts, fetch the exact
// prebuilt, write+enable a lingering systemd --user unit. Idempotent.
function makeInstaller(bundleB64: string, sqliteVer: string): string {
  return `
set -e
NODE=$(ls -d "$HOME"/.nvm/versions/node/v20*/bin/node 2>/dev/null | sort -V | tail -1)
[ -z "$NODE" ] && NODE=$(for d in "$HOME"/.nvm/versions/node/*/bin/node; do
  [ -x "$d" ] && v=$("$d" -p 'process.versions.node.split(".")[0]' 2>/dev/null) && [ "$v" -ge 18 ] && echo "$v $d"
done | sort -V | tail -1 | awk '{print $2}')
[ -z "$NODE" ] && { echo "BREEZED_ERR no Node >=18 on host" >&2; exit 3; }
NBIN=$(dirname "$NODE"); export PATH="$NBIN:$PATH"
ABI=$("$NODE" -e 'console.log(process.versions.modules)')
ARCH=$("$NODE" -e 'console.log(process.platform+"-"+process.arch)')
D="$HOME/.breezefile/daemon"
mkdir -p "$D/node_modules/better-sqlite3"
printf '%s' '${bundleB64}' | base64 -d > "$D/breezed.mjs"
cat > "$D/package.json" <<'PKG'
{ "name": "breezed-host", "private": true, "type": "module",
  "dependencies": { "better-sqlite3": "^${sqliteVer}" } }
PKG
cd "$D"
npm install --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null 2>&1
URL="https://github.com/WiseLibs/better-sqlite3/releases/download/v${sqliteVer}/better-sqlite3-v${sqliteVer}-node-v\${ABI}-\${ARCH}.tar.gz"
curl -fsSL -m 60 "$URL" -o /tmp/bsq.tgz
tar -xzf /tmp/bsq.tgz -C "$D/node_modules/better-sqlite3"
rm -f /tmp/bsq.tgz
"$NODE" -e 'new (require("better-sqlite3"))(":memory:").close()' \
  || { echo "BREEZED_ERR better-sqlite3 load failed" >&2; exit 4; }
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/breezed.service" <<UNIT
[Unit]
Description=Breeze task daemon
After=default.target
[Service]
ExecStart=$NODE $D/breezed.mjs
Restart=always
RestartSec=3
[Install]
WantedBy=default.target
UNIT
loginctl enable-linger "$USER" >/dev/null 2>&1 || true
systemctl --user daemon-reload
systemctl --user enable --now breezed >/dev/null 2>&1
systemctl --user restart breezed >/dev/null 2>&1
sleep 1
systemctl --user is-active breezed >/dev/null 2>&1 \
  && echo "BREEZED_OK node=$NODE abi=$ABI" \
  || { echo "BREEZED_ERR service not active" >&2; journalctl --user -u breezed -n 20 --no-pager >&2 || true; exit 5; }
`;
}

function ssh(target: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, ...args],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let so = '';
    let se = '';
    child.stdout.on('data', (d) => (so += d));
    child.stderr.on('data', (d) => (se += d));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve(so) : reject(new Error(`ssh exit ${code}: ${se.trim() || so.trim()}`)),
    );
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

const inflight = new Map<string, Promise<boolean>>();

/** Install (or confirm cached install of) breezed on `target` and make
 *  sure its lingering systemd --user service is running. Idempotent;
 *  cached by bundle+sqlite-version hash. */
export async function ensureRemoteDaemon(target: string): Promise<boolean> {
  const want = bundleHash();
  const state = loadState();
  if (state[target]?.hash === want) {
    // Bundle unchanged — just make sure the service is up.
    try {
      await ssh(target, ['systemctl', '--user', 'is-active', 'breezed']);
      return true;
    } catch {
      try {
        await ssh(target, ['systemctl', '--user', 'restart', 'breezed']);
        return true;
      } catch {
        /* fall through to full reinstall */
      }
    }
  }
  if (inflight.has(target)) return inflight.get(target)!;
  const p = (async () => {
    try {
      const b64 = Buffer.from(readDaemonBundle(), 'utf8').toString('base64');
      const out = await ssh(
        target,
        ['bash', '-s'],
        makeInstaller(b64, betterSqliteVersion()),
      );
      if (!/BREEZED_OK/.test(out)) {
        console.warn('[remote-daemon] unexpected installer output:', out.trim());
        return false;
      }
      state[target] = { hash: want, at: Date.now() };
      saveState(state);
      return true;
    } catch (e) {
      console.warn('[remote-daemon] install failed for', target, (e as Error).message);
      return false;
    }
  })();
  inflight.set(target, p);
  try {
    return await p;
  } finally {
    inflight.delete(target);
  }
}

type ResolvedSsh = {
  hostname: string;
  user: string;
  port: string;
  identityFiles: string[];
};

/** Resolve `~/.ssh/config` for `target` via `ssh -G` and pluck the connection
 *  settings the tunnel needs. We re-pass these explicitly under `-F /dev/null`
 *  so user-level `LocalForward` lines on the Host block don't take down our
 *  forward — see the call site in connectRemoteDaemon for the full rationale. */
async function resolveSshConfig(target: string): Promise<ResolvedSsh> {
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn('ssh', ['-G', target], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let so = '';
    let se = '';
    child.stdout.on('data', (d) => (so += d));
    child.stderr.on('data', (d) => (se += d));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve(so) : reject(new Error(`ssh -G exit ${code}: ${se}`)),
    );
  });
  const res: ResolvedSsh = {
    hostname: target,
    user: os.userInfo().username,
    port: '22',
    identityFiles: [],
  };
  for (const line of out.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const k = line.slice(0, sp).toLowerCase();
    const v = line.slice(sp + 1).trim();
    if (k === 'hostname') res.hostname = v;
    else if (k === 'user') res.user = v;
    else if (k === 'port') res.port = v;
    else if (k === 'identityfile') {
      // ssh -G emits ~ literally; expand it so -F /dev/null doesn't lose it.
      res.identityFiles.push(v.replace(/^~(?=\/|$)/, os.homedir()));
    }
  }
  return res;
}

function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export type RemoteConnection = {
  target: string;
  base: string; // http://127.0.0.1:<localPort>
  token: string;
  tunnel: ReturnType<typeof spawn>;
};

/** Open a forward ssh tunnel to `target`'s breezed and return an HTTP
 *  client base + token. Caller holds the connection and kills
 *  `tunnel` to disconnect. */
export async function connectRemoteDaemon(
  target: string,
): Promise<RemoteConnection> {
  const apiRaw = await ssh(target, ['cat', '.breezefile/api.json']);
  const api = JSON.parse(apiRaw) as { port: number; token: string };
  if (typeof api.port !== 'number' || typeof api.token !== 'string') {
    throw new Error(`bad api.json on ${target}`);
  }
  const localPort = await freeLocalPort();
  // Bypass ~/.ssh/config for the tunnel via `-F /dev/null`, then re-supply
  // the user's resolved connection settings (HostName/User/Port/IdentityFile)
  // from `ssh -G <target>`. We do this because a `Host <target>` block that
  // declares LocalForward entries (very common for dev boxes: 3000, 5173,
  // 8000, etc.) will try to apply ALL of those on every connection. If any
  // of them is already bound on the laptop, our `-L` would be dropped too
  // (ExitOnForwardFailure=yes), surfacing as a misleading "tunnel did not
  // come up". `-o ClearAllForwardings=yes` is not a fix — per OpenSSH it
  // also clears the command-line `-L`. `-F /dev/null` is the clean answer.
  const resolved = await resolveSshConfig(target);
  const sshArgs = [
    '-F',
    '/dev/null',
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    `HostName=${resolved.hostname}`,
    '-o',
    `User=${resolved.user}`,
    '-o',
    `Port=${resolved.port}`,
    ...resolved.identityFiles.flatMap((f) => ['-o', `IdentityFile=${f}`]),
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-N',
    '-L',
    `${localPort}:127.0.0.1:${api.port}`,
    target,
  ];
  const tunnel = spawn('ssh', sshArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  // Wait until the forwarded port accepts a connection (tunnel ready).
  const base = `http://127.0.0.1:${localPort}`;
  const deadline = Date.now() + 8000;
  for (;;) {
    if (Date.now() > deadline) {
      tunnel.kill();
      throw new Error(`tunnel to ${target} did not come up`);
    }
    try {
      const r = await fetch(`${base}/healthz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { target, base, token: api.token, tunnel };
}

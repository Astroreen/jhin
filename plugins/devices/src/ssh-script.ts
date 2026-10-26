// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/device/sshDeviceScript.ts.
// Jhin installs each tool with `npm ci` from the lockfile the plugin ships (preview.md D1330,
// D1495) into `~/.jhin/tools/<package>/<version>`, where T3 runs `npm install` into `~/.t3`.
import { AGENT_DEVICE_SPEC, HUB_SPEC, TOOL_LOCKS, type ToolSpec } from "./toolchain.ts";

export type RemoteMode = "probe" | "start" | "agent-start" | "stop-agent" | "stop";

/** T3's `quoteRemoteArg`: one argument for the host's POSIX shell. */
export const quoteRemoteArg = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

/** T3's environment of the host's non-interactive shell: the SDKs' usual places on PATH. */
export const remoteDeviceEnvironment = `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -z "$ANDROID_HOME" ]; then
  if [ -d "$HOME/Library/Android/sdk" ]; then export ANDROID_HOME="$HOME/Library/Android/sdk";
  elif [ -d "$HOME/Android/Sdk" ]; then export ANDROID_HOME="$HOME/Android/Sdk"; fi
fi
if [ -n "$ANDROID_HOME" ]; then export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"; fi
if [ -z "$JAVA_HOME" ] && ! command -v java >/dev/null 2>&1; then
  for device_java_home in "$HOME/.local/opt/android-studio/jbr" /opt/android-studio/jbr /Applications/Android\\ Studio.app/Contents/jbr "$HOME/Applications/Android Studio.app/Contents/jbr"; do
    if [ -x "$device_java_home/bin/java" ]; then export JAVA_HOME="$device_java_home"; break; fi
  done
fi
if [ -n "$JAVA_HOME" ]; then export PATH="$JAVA_HOME/bin:$PATH"; fi
`;

const tool = (spec: ToolSpec) => ({
  name: spec.name,
  version: spec.version,
  entry: spec.entry.join("/"),
  manifest: TOOL_LOCKS[spec.name].manifest,
  lock: TOOL_LOCKS[spec.name].lock,
});

/** What the node runs with the host's Node.js; every path it reports is the host's. */
export const remoteDeviceScript = (owner: string, mode: RemoteMode): string =>
  `
const owner = ${JSON.stringify(owner)};
const mode = ${JSON.stringify(mode)};
const hubTool = ${JSON.stringify(tool(HUB_SPEC))};
const agentTool = ${JSON.stringify(tool(AGENT_DEVICE_SPEC))};
` +
  String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const root = path.join(os.homedir(), '.jhin');
const state = path.join(root, 'device', 'hosts', owner);
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', timeout: 30000, ...options });
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const write = (file, value) => { const tmp = file + '.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(tmp, file); };
const toolDir = (t) => path.join(root, 'tools', t.name, t.version);
const entryOf = (t) => path.join(toolDir(t), 'node_modules', t.name, ...t.entry.split('/'));
const installed = (t) => { try { return fs.existsSync(entryOf(t)) && fs.readFileSync(path.join(toolDir(t), '.install-complete'), 'utf8').trim() === t.version; } catch { return false; } };
const stopHub = hub => {
  if (!hub || hub.owner !== owner) return;
  const command = run('ps', ['-p', String(hub.pid), '-o', 'command=']).stdout || '';
  if (command.includes(hub.entryPath) && command.includes(String(hub.port))) {
    try { process.kill(hub.pid, 'SIGTERM'); } catch {}
  }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const healthy = async (port, route) => { try { return (await fetch('http://127.0.0.1:' + port + route, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
const port = () => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
async function acquireLock(lock, complete = () => false) {
  const deadline = Date.now() + 600000;
  const token = process.pid + ':' + require('node:crypto').randomUUID();
  const holder = () => { try { return fs.readlinkSync(lock); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  while (true) {
    try {
      // Publishing the PID and token is atomic; suspension cannot leave an incomplete owner.
      fs.symlinkSync(token, lock);
      return () => { if (holder() === token) fs.unlinkSync(lock); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (complete()) return null;
      const previous = holder();
      if (previous === null) continue;
      const pid = Number(previous.split(':')[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Invalid device lock at ' + lock);
      try { process.kill(pid, 0); } catch (error) {
        if (error.code === 'ESRCH' && holder() === previous) {
          try { fs.unlinkSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          continue;
        }
      }
      if (Date.now() > deadline) throw Error('Device operation is locked at ' + lock + '. Check the other installer before removing the lock.');
      await sleep(500);
    }
  }
}
async function install(t) {
  const dir = toolDir(t);
  const file = entryOf(t);
  if (installed(t)) return file;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const release = await acquireLock(dir + '.lock', () => installed(t));
  if (!release) return file;
  let staging;
  try {
    if (installed(t)) return file;
    staging = fs.mkdtempSync(path.join(path.dirname(dir), '.staging-'));
    // The plugin's lockfile: npm installs exactly that tree or fails (D1330).
    fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(t.manifest));
    fs.writeFileSync(path.join(staging, 'package-lock.json'), JSON.stringify(t.lock));
    const result = run('npm', ['ci', '--prefix', staging, '--no-fund', '--no-audit'], { timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) throw Error('Installing ' + t.name + ' failed while running npm ci' + (result.status === null ? '' : ' (exit code ' + result.status + ')') + '.');
    if (!fs.existsSync(path.join(staging, 'node_modules', t.name, ...t.entry.split('/')))) throw Error('Missing installed entry for ' + t.name);
    fs.writeFileSync(path.join(staging, '.install-complete'), t.version);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
    staging = undefined;
    return file;
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    release();
  }
}
(async () => {
  const ios = process.platform === 'darwin' && run('xcrun', ['simctl', 'help']).status === 0;
  const android = run('adb', ['version']).status === 0;
  const platforms = [
    { platform: 'ios', available: ios, ...(!ios ? { reason: 'iOS needs macOS with Xcode and working xcrun simctl.' } : {}) },
    { platform: 'android', available: android, ...(!android ? { reason: 'Android SDK missing. Set ANDROID_HOME or put adb on the SSH PATH.' } : {}) },
  ];
  const tools = { hubInstalled: installed(hubTool), agentDeviceInstalled: installed(agentTool) };
  if (mode === 'probe') {
    if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node 22 or newer is required on the device host.');
    if (run('npm', ['--version']).status !== 0) throw Error('npm is missing from the non-interactive SSH PATH.');
    console.log(JSON.stringify({ nodePath: process.execPath, platforms, ...tools })); return;
  }
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  // Serialize starts and stops for this node/host owner, including agent startup.
  const releaseHost = await acquireLock(path.join(state, 'runtime.lock'));
  try {
  const hubFile = path.join(state, 'hub.json');
  const daemonFile = path.join(state, 'daemon.json');
  const agentFile = path.join(state, 'agent.json');
  if (mode === 'stop' || mode === 'stop-agent') {
    const hub = read(hubFile);
    if (mode === 'stop' && hub && hub.owner === owner) {
      stopHub(hub);
      fs.rmSync(hubFile, { force: true });
    }
    const entry = read(agentFile)?.entryPath || entryOf(agentTool);
    if (fs.existsSync(entry)) run(process.execPath, [entry, 'daemon', 'stop', '--state-dir', state]);
    return;
  }
  if (!ios && !android) throw Error(platforms.map(p => p.reason).join(' '));
  const hubEntry = await install(hubTool);
  // Only a Mac can list Apple simulators. Recording the filter replaces hubs started without it.
  const hubPlatform = process.platform === 'darwin' ? undefined : 'android';
  let hub = read(hubFile);
  if (!hub || hub.owner !== owner || hub.entryPath !== hubEntry || hub.platform !== hubPlatform || !await healthy(hub.port, '/readyz')) {
    stopHub(hub);
    for (let attempt = 0; attempt < 5; attempt++) {
      const hubPort = await port();
      const log = fs.openSync(path.join(state, 'hub.log'), 'a');
      const child = spawn(process.execPath, [hubEntry, '--port', String(hubPort), '--host', '127.0.0.1', '--hide-sidebar', '--hide-boot-device', ...(hubPlatform ? ['--platform', hubPlatform] : [])], {
        cwd: state, detached: true, stdio: ['ignore', log, log], env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      try { await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); }
      finally { fs.closeSync(log); }
      child.unref();
      hub = { owner, pid: child.pid, port: hubPort, entryPath: hubEntry, platform: hubPlatform };
      write(hubFile, hub);
      const deadline = Date.now() + 30000;
      let listening = false;
      while (child.exitCode === null && child.signalCode === null) {
        if (await healthy(hub.port, '/readyz')) { listening = true; break; }
        if (Date.now() > deadline) { stopHub(hub); throw Error('Device hub did not become ready. See ' + path.join(state, 'hub.log')); }
        await sleep(200);
      }
      if (listening) break;
      // Port reservation and binding happen in different processes. Retry an early exit with a fresh port.
      fs.rmSync(hubFile, { force: true });
      if (attempt === 4) throw Error('Device hub exited before becoming ready. See ' + path.join(state, 'hub.log'));
    }
  }
  let agentResult = {};
  if (mode === 'agent-start') {
  const agentEntry = await install(agentTool);
  const previousAgent = read(agentFile)?.entryPath;
  let daemon = read(daemonFile);
  if (daemon && (previousAgent !== agentEntry || !await healthy(daemon.httpPort, '/health'))) {
    const stopped = run(process.execPath, [previousAgent || agentEntry, 'daemon', 'stop', '--state-dir', state]);
    if (stopped.status !== 0) throw Error('Could not stop the previous agent-device version.');
    fs.rmSync(daemonFile, { force: true });
    daemon = null;
  }
  if (!daemon) {
    fs.rmSync(daemonFile, { force: true });
    const env = { ...process.env, AGENT_DEVICE_STATE_DIR: state, AGENT_DEVICE_DAEMON_SERVER_MODE: 'http', AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0', AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' };
    delete env.AGENT_DEVICE_DAEMON_BASE_URL; delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN; delete env.AGENT_DEVICE_CONFIG;
    run(process.execPath, [agentEntry, 'devices', '--json'], { env });
    daemon = read(daemonFile);
  }
  if (!daemon || !await healthy(daemon.httpPort, '/health')) throw Error('agent-device daemon did not become ready in ' + state);
  write(agentFile, { entryPath: agentEntry });
  agentResult = { daemonPort: daemon.httpPort, token: daemon.token, entryPath: agentEntry, stateDir: state };
  }
  const vendor = path.resolve(path.dirname(hubEntry), '../../vendor/serve-sim/dist');
  const optional = file => fs.existsSync(file) ? file : null;
  console.log(JSON.stringify({ nodePath: process.execPath, platforms, hubInstalled: true, agentDeviceInstalled: installed(agentTool), hubPort: hub.port, ...agentResult,
    helpers: { serveSimAxSettings: optional(path.join(vendor, 'simax/serve-sim-ax-settings')), serveSimCli: optional(path.join(vendor, 'serve-sim.js')) } }));
  } finally { releaseHost(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;

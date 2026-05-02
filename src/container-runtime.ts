/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/**
 * True iff the runtime is rootless podman using pasta as its userspace
 * network forwarder. Result is cached — `podman info` is non-trivial.
 *
 * Safe to call against real Docker: the `RootlessNetworkCmd` template
 * field is podman-only, so `docker info` returns an empty string and
 * the check returns false.
 */
let cachedRootlessPodmanPasta: boolean | undefined;
function isRootlessPodmanWithPasta(): boolean {
  if (cachedRootlessPodmanPasta !== undefined) return cachedRootlessPodmanPasta;
  try {
    const out = execSync(`${CONTAINER_RUNTIME_BIN} info --format '{{.Host.RootlessNetworkCmd}}'`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    cachedRootlessPodmanPasta = out.trim() === 'pasta';
  } catch {
    cachedRootlessPodmanPasta = false;
  }
  return cachedRootlessPodmanPasta;
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  if (os.platform() !== 'linux') return [];
  // On Linux, host.docker.internal isn't built-in — add it explicitly.
  const args = ['--add-host=host.docker.internal:host-gateway'];
  if (isRootlessPodmanWithPasta()) {
    // Pasta does not by default forward host loopback into containers, so
    // services bound to 127.0.0.1 (e.g. an OneCLI gateway) are unreachable
    // from agent containers. --map-host-loopback redirects traffic destined
    // for 169.254.1.2 — pasta's default gateway IP, which is what
    // host.docker.internal resolves to — through to host 127.0.0.1.
    // 169.254.1.2 is pasta's documented default; if a future pasta release
    // changes it, this is where to update.
    args.push('--network=pasta:--map-host-loopback,169.254.1.2');
  }
  return args;
}

/**
 * True iff SELinux is currently enforcing. Result is cached.
 *
 * On non-SELinux systems (Ubuntu, macOS, etc.) `getenforce` is missing
 * and the helper returns false, so callers leave their bind mount flags
 * unchanged.
 */
let cachedSELinuxEnforcing: boolean | undefined;
export function isSELinuxEnforcing(): boolean {
  if (cachedSELinuxEnforcing !== undefined) return cachedSELinuxEnforcing;
  try {
    const out = execSync('getenforce', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 2000,
    });
    cachedSELinuxEnforcing = out.trim() === 'Enforcing';
  } catch {
    cachedSELinuxEnforcing = false;
  }
  return cachedSELinuxEnforcing;
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  // Under SELinux enforcing, podman needs ,z to relabel the host path to
  // container_file_t — a fresh home dir keeps user_home_t and the container
  // can't read it. ,z (lowercase) is shared-mount safe; ,Z would be
  // exclusive and break sibling sessions sharing the same source. On
  // non-SELinux systems the suffix is omitted to match prior behavior.
  const suffix = isSELinuxEnforcing() ? ':ro,z' : ':ro';
  return ['-v', `${hostPath}:${containerPath}${suffix}`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}

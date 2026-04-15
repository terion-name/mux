import * as path from "node:path";
import { shellQuote } from "@/common/utils/shell";
import type { ExecOptions, Runtime } from "@/node/runtime/Runtime";

const LSP_PROBE_TIMEOUT_SECONDS = 5;

// These helpers expose runtime-level probing primitives so future managed installs can
// resolve absolute executables without teaching Runtime about LSP-specific policy.
export async function probeCommandOnPath(
  runtime: Runtime,
  command: string,
  cwd: string,
  env?: Readonly<Record<string, string>>
): Promise<string | null> {
  const result = await execProbe(runtime, `command -v ${shellQuote(command)}`, {
    cwd,
    ...(env ? { env: { ...env } } : {}),
    timeout: LSP_PROBE_TIMEOUT_SECONDS,
  });
  if (result.exitCode !== 0) {
    return null;
  }

  const resolvedCommand = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return resolvedCommand ?? null;
}

export async function resolveExecutablePathCandidate(
  runtime: Runtime,
  candidatePath: string,
  cwd: string,
  env?: Readonly<Record<string, string>>
): Promise<string | null> {
  const normalizedCandidatePath = runtime.normalizePath(candidatePath, cwd);

  try {
    const resolvedCandidatePath = await runtime.resolvePath(normalizedCandidatePath);
    const stat = await runtime.stat(resolvedCandidatePath);
    if (stat.isDirectory) {
      return null;
    }

    return (await isRunnablePath(runtime, resolvedCandidatePath, cwd, env))
      ? resolvedCandidatePath
      : null;
  } catch {
    return null;
  }
}

export async function probeWorkspaceLocalExecutable(
  runtime: Runtime,
  workspacePath: string,
  relativeCandidates: readonly string[]
): Promise<string | null> {
  for (const relativeCandidate of relativeCandidates) {
    const resolvedCandidate = await resolveExecutablePathCandidate(
      runtime,
      relativeCandidate,
      workspacePath
    );
    if (resolvedCandidate) {
      return resolvedCandidate;
    }
  }

  return null;
}

export async function probeWorkspaceLocalExecutableForWorkspace(
  runtime: Runtime,
  projectPath: string,
  workspaceName: string,
  relativeCandidates: readonly string[]
): Promise<string | null> {
  return await probeWorkspaceLocalExecutable(
    runtime,
    runtime.getWorkspacePath(projectPath, workspaceName),
    relativeCandidates
  );
}

export function getManagedLspToolsDir(runtime: Runtime, ...segments: string[]): string {
  return joinRuntimePath(runtime.getMuxHome(), "tools", "lsp", ...segments);
}

export async function ensureManagedLspToolsDir(
  runtime: Runtime,
  ...segments: string[]
): Promise<string> {
  const directoryPath = getManagedLspToolsDir(runtime, ...segments);
  await runtime.ensureDir(directoryPath);
  return directoryPath;
}

async function execProbe(
  runtime: Runtime,
  command: string,
  options: ExecOptions
): Promise<{ stdout: string; exitCode: number }> {
  const stream = await runtime.exec(command, options);
  try {
    await stream.stdin.close();
  } catch {
    // Probes do not write to stdin, and some runtimes can close the stream before callers do.
  }

  const [stdout, , exitCode] = await Promise.all([
    streamToString(stream.stdout),
    streamToString(stream.stderr),
    stream.exitCode,
  ]);
  return { stdout, exitCode };
}

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) {
      chunks.push(tail);
    }
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

async function isRunnablePath(
  runtime: Runtime,
  filePath: string,
  cwd: string,
  env?: Readonly<Record<string, string>>
): Promise<boolean> {
  const result = await execProbe(runtime, `test -x ${shellQuote(filePath)}`, {
    cwd,
    ...(env ? { env: { ...env } } : {}),
    timeout: LSP_PROBE_TIMEOUT_SECONDS,
  });
  return result.exitCode === 0;
}

function joinRuntimePath(basePath: string, ...segments: string[]): string {
  const pathModule = selectPathModule(basePath);
  return pathModule.join(basePath, ...segments);
}

type PathModule = typeof path.posix;

function selectPathModule(filePath: string): PathModule {
  if (/^[A-Za-z]:[\\/]/u.test(filePath) || filePath.includes("\\")) {
    return path.win32;
  }
  return path.posix;
}

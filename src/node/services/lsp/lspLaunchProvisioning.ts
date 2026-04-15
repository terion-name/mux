import * as path from "node:path";
import { shellQuote } from "@/common/utils/shell";
import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered } from "@/node/utils/runtime/helpers";

// These helpers expose runtime-level probing primitives so future managed installs can
// resolve absolute executables without teaching Runtime about LSP-specific policy.
export async function probeCommandOnPath(
  runtime: Runtime,
  command: string,
  cwd: string
): Promise<string | null> {
  const result = await execBuffered(runtime, `command -v ${shellQuote(command)}`, {
    cwd,
    timeout: 5,
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
  cwd: string
): Promise<string | null> {
  const normalizedCandidatePath = runtime.normalizePath(candidatePath, cwd);

  try {
    const resolvedCandidatePath = await runtime.resolvePath(normalizedCandidatePath);
    const stat = await runtime.stat(resolvedCandidatePath);
    return stat.isDirectory ? null : resolvedCandidatePath;
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

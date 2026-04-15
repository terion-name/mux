import * as path from "node:path";
import { shellQuote } from "@/common/utils/shell";
import type { ExecOptions, Runtime } from "@/node/runtime/Runtime";
import { readFileString } from "@/node/utils/runtime/helpers";
import type {
  LspGoManagedInstallStrategy,
  LspNodePackageExecStrategy,
  LspNodePackageManager,
  LspPolicyContext,
} from "./types";

const LSP_PROBE_TIMEOUT_SECONDS = 5;
const DEFAULT_NODE_PACKAGE_MANAGERS: readonly LspNodePackageManager[] = ["bunx", "pnpm", "npm"];

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

export async function probeWorkspaceLocalPath(
  runtime: Runtime,
  workspacePath: string,
  relativeCandidates: readonly string[]
): Promise<string | null> {
  for (const relativeCandidate of relativeCandidates) {
    const normalizedCandidatePath = runtime.normalizePath(relativeCandidate, workspacePath);

    try {
      const resolvedCandidatePath = await runtime.resolvePath(normalizedCandidatePath);
      await runtime.stat(resolvedCandidatePath);
      return resolvedCandidatePath;
    } catch {
      // Keep scanning candidates until one resolves.
    }
  }

  return null;
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

export async function resolveNodePackageManagerOrder(
  runtime: Runtime,
  rootPath: string,
  explicitManagers?: readonly LspNodePackageManager[]
): Promise<readonly LspNodePackageManager[]> {
  if (explicitManagers && explicitManagers.length > 0) {
    return explicitManagers;
  }

  const preferredManagers: LspNodePackageManager[] = [];
  const packageManagerField = await readWorkspacePackageManagerField(runtime, rootPath);
  if (packageManagerField) {
    preferredManagers.push(packageManagerField);
  }

  for (const [lockfileName, manager] of [
    ["bun.lock", "bunx"],
    ["bun.lockb", "bunx"],
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
  ] as const) {
    if (await pathExists(runtime, runtime.normalizePath(lockfileName, rootPath))) {
      preferredManagers.push(manager);
    }
  }

  return dedupeNodePackageManagers([...preferredManagers, ...DEFAULT_NODE_PACKAGE_MANAGERS]);
}

export async function resolveNodePackageExecCommand(
  runtime: Runtime,
  rootPath: string,
  cwd: string,
  env: Readonly<Record<string, string>> | undefined,
  strategy: LspNodePackageExecStrategy,
  policyContext: LspPolicyContext
): Promise<{ command: string; args: readonly string[] } | { reason: string }> {
  if (policyContext.provisioningMode !== "auto") {
    return {
      reason: `automatic package-manager provisioning is disabled in ${policyContext.provisioningMode} mode`,
    };
  }

  const packageManagers = await resolveNodePackageManagerOrder(
    runtime,
    rootPath,
    strategy.packageManagers
  );

  for (const packageManager of packageManagers) {
    const packageManagerCommand = await resolveNodePackageManagerCommand(
      runtime,
      packageManager,
      cwd,
      env
    );
    if (!packageManagerCommand) {
      continue;
    }

    return {
      command: packageManagerCommand,
      args: buildNodePackageManagerExecArgs(packageManager, strategy),
    };
  }

  return {
    reason: `none of the supported package managers are available on PATH (${packageManagers.join(", ")})`,
  };
}

export async function ensureManagedGoTool(
  runtime: Runtime,
  cwd: string,
  env: Readonly<Record<string, string>> | undefined,
  strategy: LspGoManagedInstallStrategy,
  policyContext: LspPolicyContext
): Promise<{ command: string } | { reason: string }> {
  if (policyContext.provisioningMode !== "auto") {
    return {
      reason: `managed Go installs are disabled in ${policyContext.provisioningMode} mode`,
    };
  }

  const goCommand = await probeCommandOnPath(runtime, "go", cwd, env);
  if (!goCommand) {
    return { reason: "go is not available on PATH for managed gopls installation" };
  }

  const installDirectory = await ensureManagedLspToolsDir(
    runtime,
    ...(strategy.installSubdirectory ?? ["go", "bin"])
  );
  const resolvedInstallDirectory = await runtime
    .resolvePath(installDirectory)
    .catch(() => installDirectory);
  const installEnv = {
    ...(env ?? {}),
    GOBIN: resolvedInstallDirectory,
  };

  const installResult = await execProbe(
    runtime,
    `${shellQuote(goCommand)} install ${shellQuote(strategy.module)}`,
    {
      cwd,
      env: installEnv,
      timeout: 120,
    }
  );
  if (installResult.exitCode !== 0) {
    const detail = installResult.stderr.trim() || installResult.stdout.trim();
    return {
      reason: detail
        ? `failed to install ${strategy.binaryName} via go install: ${detail}`
        : `failed to install ${strategy.binaryName} via go install`,
    };
  }

  const installedBinaryPath = joinRuntimePath(resolvedInstallDirectory, strategy.binaryName);
  const resolvedBinaryPath = await resolveExecutablePathCandidate(
    runtime,
    installedBinaryPath,
    cwd,
    installEnv
  );
  if (!resolvedBinaryPath) {
    return {
      reason: `${strategy.binaryName} was installed but the managed binary is not runnable at ${installedBinaryPath}`,
    };
  }

  return { command: resolvedBinaryPath };
}

async function resolveNodePackageManagerCommand(
  runtime: Runtime,
  packageManager: LspNodePackageManager,
  cwd: string,
  env?: Readonly<Record<string, string>>
): Promise<string | null> {
  switch (packageManager) {
    case "bunx":
      return await probeCommandOnPath(runtime, "bunx", cwd, env);
    case "pnpm":
      return await probeCommandOnPath(runtime, "pnpm", cwd, env);
    case "npm":
      return await probeCommandOnPath(runtime, "npm", cwd, env);
  }
}

function buildNodePackageManagerExecArgs(
  packageManager: LspNodePackageManager,
  strategy: LspNodePackageExecStrategy
): readonly string[] {
  switch (packageManager) {
    case "bunx":
      return ["--package", strategy.packageName, strategy.binaryName];
    case "pnpm":
      return ["--package", strategy.packageName, "dlx", strategy.binaryName];
    case "npm":
      return ["exec", `--package=${strategy.packageName}`, "--", strategy.binaryName];
  }
}

async function readWorkspacePackageManagerField(
  runtime: Runtime,
  rootPath: string
): Promise<LspNodePackageManager | null> {
  const packageJsonPath = runtime.normalizePath("package.json", rootPath);
  if (!(await pathExists(runtime, packageJsonPath))) {
    return null;
  }

  try {
    const packageJson = JSON.parse(await readFileString(runtime, packageJsonPath)) as {
      packageManager?: unknown;
    };
    return parseNodePackageManager(packageJson.packageManager);
  } catch {
    return null;
  }
}

function parseNodePackageManager(value: unknown): LspNodePackageManager | null {
  if (typeof value !== "string") {
    return null;
  }

  const [name] = value.trim().toLowerCase().split("@");
  if (name === "bun") {
    return "bunx";
  }
  if (name === "pnpm") {
    return "pnpm";
  }
  if (name === "npm") {
    return "npm";
  }
  return null;
}

function dedupeNodePackageManagers(
  managers: readonly LspNodePackageManager[]
): readonly LspNodePackageManager[] {
  const deduped: LspNodePackageManager[] = [];
  for (const manager of managers) {
    if (!deduped.includes(manager)) {
      deduped.push(manager);
    }
  }
  return deduped;
}

async function execProbe(
  runtime: Runtime,
  command: string,
  options: ExecOptions
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stream = await runtime.exec(command, options);
  try {
    await stream.stdin.close();
  } catch {
    // Probes do not write to stdin, and some runtimes can close the stream before callers do.
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    streamToString(stream.stdout),
    streamToString(stream.stderr),
    stream.exitCode,
  ]);
  return { stdout, stderr, exitCode };
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

async function pathExists(runtime: Runtime, candidatePath: string): Promise<boolean> {
  try {
    await runtime.stat(candidatePath);
    return true;
  } catch {
    return false;
  }
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

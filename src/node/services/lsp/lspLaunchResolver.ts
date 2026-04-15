import type { Runtime } from "@/node/runtime/Runtime";
import {
  ensureManagedGoTool,
  probeCommandOnPath,
  probeWorkspaceLocalExecutable,
  probeWorkspaceLocalPath,
  resolveExecutablePathCandidate,
  resolveNodePackageExecCommand,
} from "./lspLaunchProvisioning";
import type {
  LspManualLaunchPolicy,
  LspPolicyContext,
  LspProvisionedLaunchPolicy,
  LspServerDescriptor,
  ResolvedLspLaunchPlan,
} from "./types";

// Keep launch policy resolution outside LspClient so manager-side provisioning can evolve
// without mixing discovery/installation concerns into stdio transport code.
export interface ResolveLspLaunchPlanOptions {
  descriptor: LspServerDescriptor;
  runtime: Runtime;
  rootPath: string;
  policyContext: LspPolicyContext;
}

export async function resolveLspLaunchPlan(
  options: ResolveLspLaunchPlanOptions
): Promise<ResolvedLspLaunchPlan> {
  switch (options.descriptor.launch.type) {
    case "manual":
      return await resolveManualLaunchPlan(
        options.runtime,
        options.rootPath,
        options.descriptor.launch
      );
    case "provisioned":
      return await resolveProvisionedLaunchPlan(options);
  }
}

async function resolveManualLaunchPlan(
  runtime: Runtime,
  rootPath: string,
  launchPolicy: LspManualLaunchPolicy
): Promise<ResolvedLspLaunchPlan> {
  const launchCwd = await resolveLaunchCwd(runtime, rootPath, launchPolicy.cwd);
  const resolvedCommand = await resolveManualCommand(
    runtime,
    launchCwd,
    launchPolicy.command,
    launchPolicy.env
  );

  return {
    command: resolvedCommand,
    args: launchPolicy.args ?? [],
    cwd: launchCwd,
    env: launchPolicy.env,
    initializationOptions: launchPolicy.initializationOptions,
  };
}

async function resolveProvisionedLaunchPlan(
  options: ResolveLspLaunchPlanOptions
): Promise<ResolvedLspLaunchPlan> {
  const launchPolicy = options.descriptor.launch;
  if (launchPolicy.type !== "provisioned") {
    throw new Error(`Expected a provisioned launch policy for ${options.descriptor.id}`);
  }

  const launchCwd = await resolveLaunchCwd(options.runtime, options.rootPath, launchPolicy.cwd);
  const workspaceTsserverPath = await resolveWorkspaceTsserverPath(
    options.runtime,
    options.rootPath,
    launchPolicy,
    options.policyContext
  );
  const initializationOptions = mergeInitializationOptions(
    launchPolicy.initializationOptions,
    workspaceTsserverPath ? { tsserver: { path: workspaceTsserverPath } } : undefined
  );

  const failureReasons: string[] = [];
  for (const strategy of launchPolicy.strategies) {
    switch (strategy.type) {
      case "workspaceLocalExecutable": {
        if (!options.policyContext.trustedWorkspaceExecution) {
          failureReasons.push(
            `skipped trusted workspace-local executable probe (${strategy.relativeCandidates.join(", ")})`
          );
          break;
        }

        const resolvedCommand = await probeWorkspaceLocalExecutable(
          options.runtime,
          options.rootPath,
          strategy.relativeCandidates
        );
        if (resolvedCommand) {
          return {
            command: resolvedCommand,
            args: launchPolicy.args ?? [],
            cwd: launchCwd,
            env: launchPolicy.env,
            initializationOptions,
          };
        }
        failureReasons.push(
          `workspace-local executable not found (${strategy.relativeCandidates.join(", ")})`
        );
        break;
      }

      case "pathCommand": {
        const resolvedCommand = await probeCommandOnPath(
          options.runtime,
          strategy.command,
          launchCwd,
          launchPolicy.env
        );
        if (resolvedCommand) {
          return {
            command: resolvedCommand,
            args: launchPolicy.args ?? [],
            cwd: launchCwd,
            env: launchPolicy.env,
            initializationOptions,
          };
        }
        failureReasons.push(`${strategy.command} is not available on PATH`);
        break;
      }

      case "nodePackageExec": {
        const result = await resolveNodePackageExecCommand(
          options.runtime,
          options.rootPath,
          launchCwd,
          launchPolicy.env,
          strategy,
          options.policyContext
        );
        if ("command" in result) {
          return {
            command: result.command,
            args: [...result.args, ...(launchPolicy.args ?? [])],
            cwd: launchCwd,
            env: launchPolicy.env,
            initializationOptions,
          };
        }
        failureReasons.push(result.reason);
        break;
      }

      case "goManagedInstall": {
        const result = await ensureManagedGoTool(
          options.runtime,
          launchCwd,
          launchPolicy.env,
          strategy,
          options.policyContext
        );
        if ("command" in result) {
          return {
            command: result.command,
            args: launchPolicy.args ?? [],
            cwd: launchCwd,
            env: launchPolicy.env,
            initializationOptions,
          };
        }
        failureReasons.push(result.reason);
        break;
      }

      case "unsupported":
        failureReasons.push(strategy.message);
        break;
    }
  }

  throw new Error(
    `Unable to resolve launch plan for ${options.descriptor.id} LSP server: ${failureReasons.join("; ")}`
  );
}

async function resolveWorkspaceTsserverPath(
  runtime: Runtime,
  rootPath: string,
  launchPolicy: LspProvisionedLaunchPolicy,
  policyContext: LspPolicyContext
): Promise<string | undefined> {
  if (!policyContext.trustedWorkspaceExecution) {
    return undefined;
  }
  if (!launchPolicy.workspaceTsserverPathCandidates) {
    return undefined;
  }

  return (
    (await probeWorkspaceLocalPath(
      runtime,
      rootPath,
      launchPolicy.workspaceTsserverPathCandidates
    )) ?? undefined
  );
}

async function resolveLaunchCwd(
  runtime: Runtime,
  rootPath: string,
  launchCwd: string | undefined
): Promise<string> {
  const normalizedLaunchCwd =
    launchCwd == null ? rootPath : runtime.normalizePath(launchCwd, rootPath);

  try {
    return await runtime.resolvePath(normalizedLaunchCwd);
  } catch {
    return normalizedLaunchCwd;
  }
}

async function resolveManualCommand(
  runtime: Runtime,
  launchCwd: string,
  command: string,
  env?: Readonly<Record<string, string>>
): Promise<string> {
  if (looksLikePathCandidate(command)) {
    return (await resolveExecutablePathCandidate(runtime, command, launchCwd, env)) ?? command;
  }

  return (await probeCommandOnPath(runtime, command, launchCwd, env)) ?? command;
}

function mergeInitializationOptions(base: unknown, extra: unknown): unknown {
  if (extra == null) {
    return base;
  }
  if (base == null) {
    return extra;
  }
  if (!isPlainObject(base) || !isPlainObject(extra)) {
    return extra;
  }

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const existingValue = merged[key];
    merged[key] =
      isPlainObject(existingValue) && isPlainObject(value)
        ? (mergeInitializationOptions(existingValue, value) as Record<string, unknown>)
        : value;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function looksLikePathCandidate(command: string): boolean {
  return (
    command.includes("/") ||
    command.includes("\\") ||
    command.startsWith(".") ||
    command.startsWith("~")
  );
}

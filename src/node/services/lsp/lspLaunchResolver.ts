import type { Runtime } from "@/node/runtime/Runtime";
import { probeCommandOnPath, resolveExecutablePathCandidate } from "./lspLaunchProvisioning";
import type { LspManualLaunchPolicy, LspServerDescriptor, ResolvedLspLaunchPlan } from "./types";

// Keep launch policy resolution outside LspClient so manager-side provisioning can evolve
// without mixing discovery/installation concerns into stdio transport code.
export interface ResolveLspLaunchPlanOptions {
  descriptor: LspServerDescriptor;
  runtime: Runtime;
  rootPath: string;
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
  }
}

async function resolveManualLaunchPlan(
  runtime: Runtime,
  rootPath: string,
  launchPolicy: LspManualLaunchPolicy
): Promise<ResolvedLspLaunchPlan> {
  const launchCwd = await resolveLaunchCwd(runtime, rootPath, launchPolicy.cwd);
  const resolvedCommand = await resolveManualCommand(runtime, launchCwd, launchPolicy.command);

  return {
    command: resolvedCommand,
    args: launchPolicy.args ?? [],
    cwd: launchCwd,
    env: launchPolicy.env,
    initializationOptions: launchPolicy.initializationOptions,
  };
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
  command: string
): Promise<string> {
  if (looksLikePathCandidate(command)) {
    return (await resolveExecutablePathCandidate(runtime, command, launchCwd)) ?? command;
  }

  return (await probeCommandOnPath(runtime, command, launchCwd)) ?? command;
}

function looksLikePathCandidate(command: string): boolean {
  return (
    command.includes("/") ||
    command.includes("\\") ||
    command.startsWith(".") ||
    command.startsWith("~")
  );
}

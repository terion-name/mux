import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import {
  getManagedLspToolsDir,
  probeWorkspaceLocalExecutable,
  probeWorkspaceLocalExecutableForWorkspace,
} from "./lspLaunchProvisioning";
import { resolveLspLaunchPlan } from "./lspLaunchResolver";
import type { LspServerDescriptor } from "./types";

function createDescriptor(command: string): LspServerDescriptor {
  return {
    id: "typescript",
    extensions: [".ts"],
    launch: {
      type: "manual",
      command,
      args: ["--stdio"],
    },
    rootMarkers: ["package.json", ".git"],
    languageIdForPath: () => "typescript",
  };
}

function prependToPath(entry: string): string {
  return [entry, process.env.PATH]
    .filter((value): value is string => value != null && value.length > 0)
    .join(path.delimiter);
}

describe("resolveLspLaunchPlan", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lsp-launch-"));
    await fs.mkdir(path.join(workspacePath, "subdir"), { recursive: true });
    await fs.mkdir(path.join(workspacePath, "tools", "bin"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "tools", "bin", "fake-lsp"), "#!/bin/sh\nexit 0\n");
    await fs.chmod(path.join(workspacePath, "tools", "bin", "fake-lsp"), 0o755);
  });

  afterEach(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it("resolves explicit relative executables and launch cwd before client creation", async () => {
    const descriptor: LspServerDescriptor = {
      ...createDescriptor("../tools/bin/fake-lsp"),
      launch: {
        type: "manual",
        command: "../tools/bin/fake-lsp",
        args: ["--stdio"],
        cwd: "./subdir",
        env: { LSP_TRACE: "verbose" },
        initializationOptions: { preferences: { quoteStyle: "single" } },
      },
    };

    const launchPlan = await resolveLspLaunchPlan({
      descriptor,
      runtime: new LocalRuntime(workspacePath),
      rootPath: workspacePath,
    });

    expect(launchPlan).toEqual({
      command: path.join(workspacePath, "tools", "bin", "fake-lsp"),
      args: ["--stdio"],
      cwd: path.join(workspacePath, "subdir"),
      env: { LSP_TRACE: "verbose" },
      initializationOptions: { preferences: { quoteStyle: "single" } },
    });
  });

  it("resolves PATH lookups against the same env that will be used for launch", async () => {
    const launchPath = prependToPath(path.join(workspacePath, "tools", "bin"));
    const descriptor: LspServerDescriptor = {
      ...createDescriptor("fake-lsp"),
      launch: {
        type: "manual",
        command: "fake-lsp",
        args: ["--stdio"],
        env: {
          PATH: launchPath,
          LSP_TRACE: "verbose",
        },
      },
    };

    const launchPlan = await resolveLspLaunchPlan({
      descriptor,
      runtime: new LocalRuntime(workspacePath),
      rootPath: workspacePath,
    });

    expect(launchPlan).toEqual({
      command: path.join(workspacePath, "tools", "bin", "fake-lsp"),
      args: ["--stdio"],
      cwd: workspacePath,
      env: {
        PATH: launchPath,
        LSP_TRACE: "verbose",
      },
      initializationOptions: undefined,
    });
  });

  it("falls back to the raw path command when the candidate is not runnable", async () => {
    const nonRunnableCommand = "../tools/bin/non-runnable-lsp";
    await fs.writeFile(path.join(workspacePath, "tools", "bin", "non-runnable-lsp"), "#!/bin/sh\n");

    const launchPlan = await resolveLspLaunchPlan({
      descriptor: {
        ...createDescriptor(nonRunnableCommand),
        launch: {
          type: "manual",
          command: nonRunnableCommand,
          args: ["--stdio"],
          cwd: "./subdir",
        },
      },
      runtime: new LocalRuntime(workspacePath),
      rootPath: workspacePath,
    });

    expect(launchPlan).toEqual({
      command: nonRunnableCommand,
      args: ["--stdio"],
      cwd: path.join(workspacePath, "subdir"),
      env: undefined,
      initializationOptions: undefined,
    });
  });

  it("falls back to the raw command when path probing cannot resolve it", async () => {
    const launchPlan = await resolveLspLaunchPlan({
      descriptor: createDescriptor("mux-test-missing-lsp"),
      runtime: new LocalRuntime(workspacePath),
      rootPath: workspacePath,
    });

    expect(launchPlan).toEqual({
      command: "mux-test-missing-lsp",
      args: ["--stdio"],
      cwd: workspacePath,
      env: undefined,
      initializationOptions: undefined,
    });
  });
});

describe("lspLaunchProvisioning helpers", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lsp-provisioning-"));
    await fs.mkdir(path.join(workspacePath, "node_modules", ".bin"), { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, "node_modules", ".bin", "fake-lsp"),
      "#!/bin/sh\nexit 0\n"
    );
    await fs.chmod(path.join(workspacePath, "node_modules", ".bin", "fake-lsp"), 0o755);
  });

  afterEach(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it("probes workspace-local executable candidates with either workspace locator input", async () => {
    const runtime = new LocalRuntime(workspacePath);
    const relativeCandidates = ["node_modules/.bin/fake-lsp", "vendor/bin/fake-lsp"] as const;

    expect(await probeWorkspaceLocalExecutable(runtime, workspacePath, relativeCandidates)).toBe(
      path.join(workspacePath, "node_modules", ".bin", "fake-lsp")
    );
    expect(
      await probeWorkspaceLocalExecutableForWorkspace(
        runtime,
        "/unused/project",
        "feature",
        relativeCandidates
      )
    ).toBe(path.join(workspacePath, "node_modules", ".bin", "fake-lsp"));
  });

  it("derives managed tool directories from mux home without touching PATH", () => {
    const runtime = new LocalRuntime(workspacePath);

    expect(getManagedLspToolsDir(runtime, "typescript")).toEndWith(
      path.join(".mux", "tools", "lsp", "typescript")
    );
  });
});

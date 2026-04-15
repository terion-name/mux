import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { WorkspaceLspDiagnosticsSnapshot } from "@/common/orpc/types";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type {
  CreateLspClientOptions,
  LspClientInstance,
  LspDiagnostic,
  LspServerDescriptor,
} from "./types";
import { LspManager } from "./lspManager";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function createRegistry(): readonly LspServerDescriptor[] {
  return [
    {
      id: "typescript",
      extensions: [".ts"],
      launch: {
        type: "manual",
        command: "mux-test-fake-lsp",
        args: ["--stdio"],
      },
      rootMarkers: ["package.json", ".git"],
      languageIdForPath: () => "typescript",
    },
  ];
}

function createDiagnostic(message: string): LspDiagnostic {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 },
    },
    severity: 1,
    source: "tsserver",
    message,
  };
}

describe("LspManager", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lsp-manager-"));
    await fs.mkdir(path.join(workspacePath, ".git"));
    await fs.mkdir(path.join(workspacePath, "src"), { recursive: true });
    await fs.mkdir(path.join(workspacePath, "packages", "pkg", "src"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "package.json"), "{}\n");
    await fs.writeFile(path.join(workspacePath, "src", "example.ts"), "export const value = 1;\n");
    await fs.writeFile(path.join(workspacePath, "packages", "pkg", "package.json"), "{}\n");
    await fs.writeFile(
      path.join(workspacePath, "packages", "pkg", "src", "nested.ts"),
      "export const nested = 1;\n"
    );
  });

  afterEach(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  test("reuses clients for the same workspace root and forwards normalized positions", async () => {
    const ensureFile = mock(() => Promise.resolve(1));
    let lastQueryRequest: Parameters<LspClientInstance["query"]>[0] | undefined;
    const query = mock((request: Parameters<LspClientInstance["query"]>[0]) => {
      lastQueryRequest = request;
      return Promise.resolve({
        operation: "hover" as const,
        hover: "const value: 1",
      });
    });
    const close = mock(() => Promise.resolve(undefined));
    const client: LspClientInstance = {
      isClosed: false,
      ensureFile,
      query,
      close,
    };
    let clientFactoryOptions: CreateLspClientOptions | undefined;
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientFactoryOptions = options;
      return Promise.resolve(client);
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    const firstResult = await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      operation: "hover",
      line: 2,
      column: 3,
    });
    const secondResult = await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      operation: "hover",
      line: 2,
      column: 3,
    });

    expect(firstResult.hover).toBe("const value: 1");
    expect(secondResult.hover).toBe("const value: 1");
    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(ensureFile).toHaveBeenCalledTimes(2);
    expect(clientFactoryOptions).toBeDefined();
    if (!clientFactoryOptions) {
      throw new Error("Expected the LSP client factory to receive a call");
    }
    expect(clientFactoryOptions.rootPath).toBe(workspacePath);
    expect(clientFactoryOptions.launchPlan).toEqual({
      command: "mux-test-fake-lsp",
      args: ["--stdio"],
      cwd: workspacePath,
      env: undefined,
      initializationOptions: undefined,
    });

    expect(lastQueryRequest).toBeDefined();
    if (!lastQueryRequest) {
      throw new Error("Expected the LSP client to receive a query");
    }
    expect(lastQueryRequest.line).toBe(1);
    expect(lastQueryRequest.character).toBe(2);

    await manager.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("deduplicates concurrent client creation for the same workspace root", async () => {
    const ensureFile = mock(() => Promise.resolve(1));
    const query = mock(() =>
      Promise.resolve({
        operation: "hover" as const,
        hover: "const value: 1",
      })
    );
    const close = mock(() => Promise.resolve(undefined));
    const client: LspClientInstance = {
      isClosed: false,
      ensureFile,
      query,
      close,
    };
    const clientReady = createDeferred<LspClientInstance>();
    const clientFactoryStarted = createDeferred<void>();
    const clientFactory = mock((_options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientFactoryStarted.resolve();
      return clientReady.promise;
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    const firstQuery = manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      operation: "hover",
      line: 1,
      column: 1,
    });
    await clientFactoryStarted.promise;

    const secondQuery = manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      operation: "hover",
      line: 1,
      column: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(clientFactory).toHaveBeenCalledTimes(1);

    clientReady.resolve(client);
    const [firstResult, secondResult] = await Promise.all([firstQuery, secondQuery]);

    expect(firstResult.hover).toBe("const value: 1");
    expect(secondResult.hover).toBe("const value: 1");
    expect(ensureFile).toHaveBeenCalledTimes(2);

    await manager.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("collects post-mutation diagnostics, clears empty publishes, and clears workspace cache on dispose", async () => {
    const ensureFile = mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
      const version = ensureFile.mock.calls.length;
      const diagnostics = version === 1 ? [createDiagnostic("first pass")] : [];
      clientOptions?.onPublishDiagnostics?.({
        uri: file.uri,
        version,
        diagnostics,
        rawDiagnosticCount: diagnostics.length,
      });
      return Promise.resolve(version);
    });
    const close = mock(() => Promise.resolve(undefined));
    let clientOptions: CreateLspClientOptions | undefined;
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientOptions = options;
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    const first = await manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      timeoutMs: 20,
    });
    expect(first).toHaveLength(1);
    expect(first[0]?.diagnostics[0]?.message).toBe("first pass");

    const second = await manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      timeoutMs: 20,
    });
    expect(second).toEqual([]);

    const workspaceDiagnostics = (
      manager as unknown as {
        workspaceDiagnostics: Map<string, Map<string, Map<string, unknown>>>;
      }
    ).workspaceDiagnostics;
    expect(workspaceDiagnostics.get("ws-1")?.values().next().value?.size ?? 0).toBe(0);

    await manager.disposeWorkspace("ws-1");
    expect(workspaceDiagnostics.has("ws-1")).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("ignores malformed publishes so they do not clear cached diagnostics or satisfy waits", async () => {
    const ensureFile = mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
      const version = ensureFile.mock.calls.length;
      clientOptions?.onPublishDiagnostics?.({
        uri: file.uri,
        version,
        diagnostics: version === 1 ? [createDiagnostic("first pass")] : [],
        rawDiagnosticCount: 1,
      });
      return Promise.resolve(version);
    });
    const close = mock(() => Promise.resolve(undefined));
    let clientOptions: CreateLspClientOptions | undefined;
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientOptions = options;
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    const first = await manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      timeoutMs: 20,
    });
    expect(first).toHaveLength(1);
    expect(first[0]?.diagnostics[0]?.message).toBe("first pass");

    const second = await manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      timeoutMs: 20,
    });
    expect(second).toEqual([]);

    const workspaceDiagnostics = (
      manager as unknown as {
        workspaceDiagnostics: Map<
          string,
          Map<string, Map<string, { diagnostics: LspDiagnostic[] }>>
        >;
      }
    ).workspaceDiagnostics;
    const cachedDiagnostics = [
      ...(workspaceDiagnostics.get("ws-1")?.values().next().value?.values() ?? []),
    ];
    expect(cachedDiagnostics).toHaveLength(1);
    expect(cachedDiagnostics[0]?.diagnostics[0]?.message).toBe("first pass");

    await manager.disposeWorkspace("ws-1");
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("collects post-mutation diagnostics across roots without serial waits", async () => {
    const secondEnsureStarted = createDeferred<void>();
    const publishByUri = new Map<string, () => void>();
    let secondEnsureResolved = false;
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      const ensureFile = mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
        publishByUri.set(file.uri, () => {
          options.onPublishDiagnostics?.({
            uri: file.uri,
            version: 1,
            diagnostics: [createDiagnostic(`diagnostic for ${file.uri}`)],
            rawDiagnosticCount: 1,
          });
        });
        if (publishByUri.size === 2 && !secondEnsureResolved) {
          secondEnsureResolved = true;
          secondEnsureStarted.resolve();
        }
        return Promise.resolve(1);
      });

      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close: mock(() => Promise.resolve(undefined)),
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    const diagnosticsPromise = manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts", "packages/pkg/src/nested.ts"],
      timeoutMs: 200,
    });

    await Promise.race([
      secondEnsureStarted.promise,
      new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(new Error("Expected both files to start waiting before diagnostics publish")),
          50
        );
      }),
    ]);

    for (const publish of publishByUri.values()) {
      publish();
    }

    const diagnostics = await diagnosticsPromise;
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((entry) => entry.path)).toEqual([
      path.join(workspacePath, "packages", "pkg", "src", "nested.ts"),
      path.join(workspacePath, "src", "example.ts"),
    ]);
  });

  test("keeps diagnostics isolated by root uri within the same workspace", async () => {
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      const ensureFile = mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
        options.onPublishDiagnostics?.({
          uri: file.uri,
          version: 1,
          diagnostics: [createDiagnostic(`diagnostic for ${options.rootPath}`)],
          rawDiagnosticCount: 1,
        });
        return Promise.resolve(1);
      });

      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close: mock(() => Promise.resolve(undefined)),
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    const diagnostics = await manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts", "packages/pkg/src/nested.ts"],
      timeoutMs: 20,
    });

    expect(diagnostics).toHaveLength(2);
    expect(new Set(diagnostics.map((entry) => entry.rootUri)).size).toBe(2);
    expect(diagnostics.map((entry) => entry.path)).toEqual([
      path.join(workspacePath, "packages", "pkg", "src", "nested.ts"),
      path.join(workspacePath, "src", "example.ts"),
    ]);
  });

  test("returns cloned sorted snapshots and notifies listeners on publish and clear", async () => {
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      const ensureFile = mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
        options.onPublishDiagnostics?.({
          uri: file.uri,
          version: 1,
          diagnostics: [createDiagnostic(`diagnostic for ${file.runtimePath}`)],
          rawDiagnosticCount: 1,
        });
        return Promise.resolve(1);
      });

      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close: mock(() => Promise.resolve(undefined)),
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);
    const snapshots: WorkspaceLspDiagnosticsSnapshot[] = [];
    const unsubscribe = manager.subscribeWorkspaceDiagnostics("ws-1", (snapshot) => {
      snapshots.push(snapshot);
    });

    await manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts", "packages/pkg/src/nested.ts"],
      timeoutMs: 20,
    });

    const snapshot = manager.getWorkspaceDiagnosticsSnapshot("ws-1");
    expect(snapshot.diagnostics.map((entry) => entry.path)).toEqual([
      path.join(workspacePath, "packages", "pkg", "src", "nested.ts"),
      path.join(workspacePath, "src", "example.ts"),
    ]);
    const firstDiagnostic = snapshot.diagnostics[0];
    expect(firstDiagnostic).toBeDefined();
    if (!firstDiagnostic) {
      throw new Error("Expected the first diagnostics entry to exist");
    }
    const firstMessage = firstDiagnostic.diagnostics[0];
    expect(firstMessage).toBeDefined();
    if (!firstMessage) {
      throw new Error("Expected the first diagnostic message to exist");
    }
    firstMessage.message = "mutated";
    const refreshedSnapshot = manager.getWorkspaceDiagnosticsSnapshot("ws-1");
    expect(refreshedSnapshot.diagnostics[0]?.diagnostics[0]?.message).toBe(
      `diagnostic for ${path.join(workspacePath, "packages", "pkg", "src", "nested.ts")}`
    );

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.diagnostics).toHaveLength(1);
    expect(snapshots[1]?.diagnostics).toHaveLength(2);

    await manager.disposeWorkspace("ws-1");
    expect(manager.getWorkspaceDiagnosticsSnapshot("ws-1").diagnostics).toEqual([]);
    expect(snapshots.at(-1)?.diagnostics).toEqual([]);

    unsubscribe();
  });

  test("ignores late diagnostics publishes from disposed clients", async () => {
    let clientOptions: CreateLspClientOptions | undefined;
    let ensuredFile: Parameters<LspClientInstance["ensureFile"]>[0] | undefined;
    const ensureFile = mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
      ensuredFile = file;
      clientOptions?.onPublishDiagnostics?.({
        uri: file.uri,
        version: 1,
        diagnostics: [createDiagnostic("first pass")],
        rawDiagnosticCount: 1,
      });
      return Promise.resolve(1);
    });
    const close = mock(() => Promise.resolve(undefined));
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientOptions = options;
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    const diagnostics = await manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      timeoutMs: 20,
    });
    expect(diagnostics).toHaveLength(1);

    await manager.disposeWorkspace("ws-1");
    expect(manager.getWorkspaceDiagnosticsSnapshot("ws-1").diagnostics).toEqual([]);

    if (!clientOptions || !ensuredFile) {
      throw new Error("Expected the LSP client to publish diagnostics for the test file");
    }

    clientOptions.onPublishDiagnostics?.({
      uri: ensuredFile.uri,
      version: 2,
      diagnostics: [createDiagnostic("late publish")],
      rawDiagnosticCount: 1,
    });

    expect(manager.getWorkspaceDiagnosticsSnapshot("ws-1").diagnostics).toEqual([]);
    const workspaceDiagnostics = (
      manager as unknown as {
        workspaceDiagnostics: Map<string, Map<string, Map<string, unknown>>>;
      }
    ).workspaceDiagnostics;
    expect(workspaceDiagnostics.has("ws-1")).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("collectPostMutationDiagnostics exits promptly when disposal wins before waiter registration", async () => {
    const ensureFile = mock(() => Promise.resolve(1));
    const close = mock(() => Promise.resolve(undefined));
    const clientFactory = mock((_options: CreateLspClientOptions): Promise<LspClientInstance> => {
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);
    const managerWithInternals = manager as unknown as {
      diagnosticWaiters: Map<string, Map<string, Map<string, Set<unknown>>>>;
      waitForFreshDiagnostics: (params: {
        workspaceId: string;
        workspaceGeneration: number;
        clientKey: string;
        uri: string;
        previousReceivedAtMs?: number;
        expectedVersion: number;
        timeoutMs: number;
      }) => Promise<unknown>;
    };
    const originalWaitForFreshDiagnostics =
      managerWithInternals.waitForFreshDiagnostics.bind(managerWithInternals);
    managerWithInternals.waitForFreshDiagnostics = async (params) => {
      await manager.disposeWorkspace("ws-1");
      return await originalWaitForFreshDiagnostics(params);
    };

    const diagnosticsPromise = manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      timeoutMs: 10_000,
    });

    const completion = await Promise.race([
      diagnosticsPromise.then((diagnostics) => ({ type: "resolved" as const, diagnostics })),
      new Promise<{ type: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ type: "timeout" }), 200);
      }),
    ]);
    expect(completion.type).toBe("resolved");
    if (completion.type !== "resolved") {
      throw new Error("Expected diagnostics collection to resolve after workspace disposal");
    }
    expect(completion.diagnostics).toEqual([]);
    expect(managerWithInternals.diagnosticWaiters.has("ws-1")).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("disposeWorkspace settles pending diagnostics waits promptly", async () => {
    const ensureFile = mock(() => Promise.resolve(1));
    const close = mock(() => Promise.resolve(undefined));
    const clientFactory = mock((_options: CreateLspClientOptions): Promise<LspClientInstance> => {
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    const diagnosticsPromise = manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      timeoutMs: 10_000,
    });

    const diagnosticWaiters = (
      manager as unknown as {
        diagnosticWaiters: Map<string, Map<string, Map<string, Set<unknown>>>>;
      }
    ).diagnosticWaiters;
    const waiterRegistered = await waitUntil(() => {
      const workspaceWaiters = diagnosticWaiters.get("ws-1");
      if (!workspaceWaiters) {
        return false;
      }
      for (const clientWaiters of workspaceWaiters.values()) {
        for (const waiters of clientWaiters.values()) {
          if (waiters.size > 0) {
            return true;
          }
        }
      }
      return false;
    });
    expect(waiterRegistered).toBe(true);

    await manager.disposeWorkspace("ws-1");

    const completion = await Promise.race([
      diagnosticsPromise.then((diagnostics) => ({ type: "resolved" as const, diagnostics })),
      new Promise<{ type: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ type: "timeout" }), 200);
      }),
    ]);
    expect(completion.type).toBe("resolved");
    if (completion.type !== "resolved") {
      throw new Error("Expected diagnostics wait to resolve after workspace disposal");
    }
    expect(completion.diagnostics).toEqual([]);
    expect(diagnosticWaiters.has("ws-1")).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("ignores malformed publishes in workspace snapshots", async () => {
    const ensureFile = mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
      const version = ensureFile.mock.calls.length;
      clientOptions?.onPublishDiagnostics?.({
        uri: file.uri,
        version,
        diagnostics: version === 1 ? [createDiagnostic("first pass")] : [],
        rawDiagnosticCount: 1,
      });
      return Promise.resolve(version);
    });
    const close = mock(() => Promise.resolve(undefined));
    let clientOptions: CreateLspClientOptions | undefined;
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientOptions = options;
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    await manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      timeoutMs: 20,
    });

    await manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      timeoutMs: 20,
    });

    expect(manager.getWorkspaceDiagnosticsSnapshot("ws-1").diagnostics).toHaveLength(1);
    expect(
      manager.getWorkspaceDiagnosticsSnapshot("ws-1").diagnostics[0]?.diagnostics[0]?.message
    ).toBe("first pass");

    await manager.disposeWorkspace("ws-1");
    expect(close).toHaveBeenCalledTimes(1);
  });
});

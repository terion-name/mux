import * as path from "node:path";
import { execBuffered, readFileString } from "@/node/utils/runtime/helpers";
import {
  LSP_DIAGNOSTICS_POLL_INTERVAL_MS,
  LSP_IDLE_CHECK_INTERVAL_MS,
  LSP_IDLE_TIMEOUT_MS,
  LSP_MAX_LOCATIONS,
  LSP_MAX_SYMBOLS,
  LSP_MAX_WORKSPACE_SYMBOL_QUERY_ROOTS,
  LSP_POST_MUTATION_DIAGNOSTICS_TIMEOUT_MS,
  LSP_PREVIEW_CONTEXT_LINES,
} from "@/constants/lsp";
import type { Runtime } from "@/node/runtime/Runtime";
import { shellQuote } from "@/common/utils/shell";
import type { WorkspaceLspDiagnosticsSnapshot } from "@/common/orpc/types";
import { log } from "@/node/services/log";
import { LspClient } from "./lspClient";
import { resolveLspLaunchPlan } from "./lspLaunchResolver";
import { LspPathMapper } from "./lspPathMapper";
import { BUILTIN_LSP_SERVERS, findLspServerForFile } from "./lspServerRegistry";
import type {
  CreateLspClientOptions,
  LspClientFileHandle,
  LspClientInstance,
  LspClientQueryResult,
  LspDocumentSymbol,
  LspFileDiagnostics,
  LspLocation,
  LspManagerQueryResult,
  LspPolicyContext,
  LspPublishDiagnosticsParams,
  LspQueryOperation,
  LspRange,
  LspServerDescriptor,
  LspSymbolInformation,
  LspSymbolResult,
  ResolvedLspLaunchPlan,
} from "./types";

interface WorkspaceClients {
  clients: Map<string, LspClientInstance>;
  pendingClients: Map<string, Promise<LspClientInstance>>;
  launchPlans: Map<string, Promise<ResolvedLspLaunchPlan>>;
  lastActivity: number;
}

interface ResolvedLspClientContext {
  client: LspClientInstance;
  clientKey: string;
  workspaceGeneration: number;
  descriptor: LspServerDescriptor;
  fileHandle?: LspClientFileHandle;
  pathMapper: LspPathMapper;
  rootUri: string;
}

interface ResolvedRootMatch {
  rootPath: string;
  matchedMarker: string | null;
}

interface ResolvedDirectoryDescriptorMatch {
  descriptor: LspServerDescriptor;
  rootPath: string;
  matchedMarker: string | null;
}

interface WorkspaceSymbolsQueryRootDiscovery {
  matches: ResolvedDirectoryDescriptorMatch[];
  truncated: boolean;
}

interface WorkspaceSymbolsQueryFailure {
  match: ResolvedDirectoryDescriptorMatch;
  reason: string;
}

type ResolvedDirectoryDescriptorSelection =
  | { kind: "none" }
  | { kind: "selected"; match: ResolvedDirectoryDescriptorMatch }
  | { kind: "ambiguous"; matches: ResolvedDirectoryDescriptorMatch[] };

interface LspTrackedFileRefreshEntry {
  filePath: string;
  fileHandle: LspClientFileHandle;
}

interface LspDiagnosticPublishReceipt {
  version?: number;
  receivedAtMs: number;
}

type LspDiagnosticWaiter = (publish?: LspDiagnosticPublishReceipt) => void;
type WorkspaceDiagnosticsListener = (snapshot: WorkspaceLspDiagnosticsSnapshot) => void;
type LspClientFactory = (options: CreateLspClientOptions) => Promise<LspClientInstance>;

export interface LspManagerOptions {
  registry?: readonly LspServerDescriptor[];
  clientFactory?: LspClientFactory;
  idleTimeoutMs?: number;
  idleCheckIntervalMs?: number;
  diagnosticPollIntervalMs?: number;
}

export interface LspManagerQueryOptions {
  workspaceId: string;
  runtime: Runtime;
  workspacePath: string;
  filePath: string;
  policyContext: LspPolicyContext;
  operation: LspQueryOperation;
  line?: number;
  column?: number;
  query?: string;
  includeDeclaration?: boolean;
}

interface ResolveLspClientContextOptions {
  workspaceId: string;
  runtime: Runtime;
  workspacePath: string;
  filePath: string;
  policyContext: LspPolicyContext;
  operation?: LspQueryOperation;
}

export interface LspManagerCollectDiagnosticsOptions {
  workspaceId: string;
  runtime: Runtime;
  workspacePath: string;
  filePaths: string[];
  policyContext: LspPolicyContext;
  timeoutMs?: number;
}

export class LspManager {
  private readonly workspaceClients = new Map<string, WorkspaceClients>();
  // Disposal bumps the generation so late publishes from closing clients and stale
  // post-mutation waits cannot recreate diagnostics for an already-cleared workspace.
  private readonly workspaceGenerations = new Map<string, number>();
  private readonly workspaceLeases = new Map<string, number>();
  private readonly workspaceDiagnostics = new Map<
    string,
    Map<string, Map<string, LspFileDiagnostics>>
  >();
  private readonly workspaceDiagnosticPublishes = new Map<
    string,
    Map<string, Map<string, LspDiagnosticPublishReceipt>>
  >();
  private readonly diagnosticWaiters = new Map<
    string,
    Map<string, Map<string, Set<LspDiagnosticWaiter>>>
  >();
  private readonly workspaceDiagnosticListeners = new Map<
    string,
    Set<WorkspaceDiagnosticsListener>
  >();
  private readonly registry: readonly LspServerDescriptor[];
  private readonly clientFactory: LspClientFactory;
  private readonly idleTimeoutMs: number;
  private readonly idleCheckIntervalMs: number;
  private readonly diagnosticPollIntervalMs: number;
  private readonly idleInterval: ReturnType<typeof setInterval>;
  private readonly diagnosticPollInterval: ReturnType<typeof setInterval>;
  private readonly diagnosticPollsInFlight = new Map<string, symbol>();
  private readonly trackedFileRefreshesInFlight = new Map<string, Promise<unknown>>();

  constructor(options?: LspManagerOptions) {
    this.registry = options?.registry ?? BUILTIN_LSP_SERVERS;
    this.clientFactory =
      options?.clientFactory ?? ((clientOptions) => LspClient.create(clientOptions));
    this.idleTimeoutMs = options?.idleTimeoutMs ?? LSP_IDLE_TIMEOUT_MS;
    this.idleCheckIntervalMs = options?.idleCheckIntervalMs ?? LSP_IDLE_CHECK_INTERVAL_MS;
    this.diagnosticPollIntervalMs =
      options?.diagnosticPollIntervalMs ?? LSP_DIAGNOSTICS_POLL_INTERVAL_MS;
    this.idleInterval = setInterval(() => {
      void this.cleanupIdleWorkspaces();
    }, this.idleCheckIntervalMs);
    this.idleInterval.unref?.();
    this.diagnosticPollInterval = setInterval(() => {
      void this.refreshTrackedDiagnostics();
    }, this.diagnosticPollIntervalMs);
    this.diagnosticPollInterval.unref?.();
  }

  acquireLease(workspaceId: string): void {
    const currentLeaseCount = this.workspaceLeases.get(workspaceId) ?? 0;
    this.workspaceLeases.set(workspaceId, currentLeaseCount + 1);
    this.markActivity(workspaceId);
  }

  releaseLease(workspaceId: string): void {
    const currentLeaseCount = this.workspaceLeases.get(workspaceId) ?? 0;
    if (currentLeaseCount <= 1) {
      this.workspaceLeases.delete(workspaceId);
      return;
    }

    this.workspaceLeases.set(workspaceId, currentLeaseCount - 1);
  }

  getWorkspaceDiagnosticsSnapshot(workspaceId: string): WorkspaceLspDiagnosticsSnapshot {
    const diagnostics = Array.from(this.workspaceDiagnostics.get(workspaceId)?.values() ?? [])
      .flatMap((diagnosticsForClient) => [...diagnosticsForClient.values()])
      .sort(compareFileDiagnostics)
      .map(cloneFileDiagnostics);

    return {
      workspaceId,
      diagnostics,
    };
  }

  subscribeWorkspaceDiagnostics(
    workspaceId: string,
    listener: WorkspaceDiagnosticsListener
  ): () => void {
    const listeners =
      this.workspaceDiagnosticListeners.get(workspaceId) ?? new Set<WorkspaceDiagnosticsListener>();
    listeners.add(listener);
    this.workspaceDiagnosticListeners.set(workspaceId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.workspaceDiagnosticListeners.delete(workspaceId);
      }
    };
  }

  async query(options: LspManagerQueryOptions): Promise<LspManagerQueryResult> {
    this.acquireLease(options.workspaceId);

    try {
      const directoryWorkspaceSymbolsResult =
        await this.queryWorkspaceSymbolsForDirectory(options);
      if (directoryWorkspaceSymbolsResult) {
        return directoryWorkspaceSymbolsResult;
      }

      const context = await this.resolveClientContext(options);
      if (context.fileHandle && shouldTrackQueryFile(options.operation)) {
        await context.client.ensureFile(context.fileHandle);
      }

      const rawResult = await context.client.query({
        operation: options.operation,
        ...(context.fileHandle ? { file: context.fileHandle } : {}),
        line: options.line != null ? Math.max(0, options.line - 1) : undefined,
        character: options.column != null ? Math.max(0, options.column - 1) : undefined,
        query: options.query,
        includeDeclaration: options.includeDeclaration,
      });

      this.markActivity(options.workspaceId);
      return await this.normalizeQueryResult(
        context.pathMapper,
        options.runtime,
        context.fileHandle,
        context.descriptor.id,
        context.rootUri,
        rawResult
      );
    } finally {
      this.releaseLease(options.workspaceId);
    }
  }

  async collectPostMutationDiagnostics(
    options: LspManagerCollectDiagnosticsOptions
  ): Promise<LspFileDiagnostics[]> {
    this.acquireLease(options.workspaceId);

    try {
      const fileContextsByClientKey = new Map<
        string,
        {
          client: LspClientInstance;
          workspaceGeneration: number;
          fileEntries: LspTrackedFileRefreshEntry[];
        }
      >();
      const uniqueFilePaths = [...new Set(options.filePaths)];

      await Promise.all(
        uniqueFilePaths.map(async (filePath) => {
          try {
            const context = await this.resolveClientContext({
              workspaceId: options.workspaceId,
              runtime: options.runtime,
              workspacePath: options.workspacePath,
              filePath,
              policyContext: options.policyContext,
            });
            const entriesForClient = fileContextsByClientKey.get(context.clientKey) ?? {
              client: context.client,
              workspaceGeneration: context.workspaceGeneration,
              fileEntries: [],
            };
            entriesForClient.fileEntries.push({
              filePath,
              fileHandle: requireQueryFileHandle(context.fileHandle, "document_symbols"),
            });
            fileContextsByClientKey.set(context.clientKey, entriesForClient);
          } catch (error) {
            log.debug("Skipping post-mutation LSP diagnostics for file", {
              workspaceId: options.workspaceId,
              filePath,
              error,
            });
          }
        })
      );

      const diagnostics = (
        await Promise.all(
          [...fileContextsByClientKey.entries()].map(async ([clientKey, fileContext]) => {
            return await this.refreshTrackedFilesForClient({
              workspaceId: options.workspaceId,
              workspaceGeneration: fileContext.workspaceGeneration,
              clientKey,
              client: fileContext.client,
              fileEntries: fileContext.fileEntries,
              waitForDiagnostics: true,
              timeoutMs: options.timeoutMs ?? LSP_POST_MUTATION_DIAGNOSTICS_TIMEOUT_MS,
              logReason: "post-mutation LSP diagnostics",
            });
          })
        )
      ).flat();

      this.markActivity(options.workspaceId);
      return diagnostics.sort((left, right) => left.path.localeCompare(right.path));
    } finally {
      this.releaseLease(options.workspaceId);
    }
  }

  private refreshTrackedDiagnostics(): void {
    for (const [workspaceId, entry] of this.workspaceClients) {
      if (!this.hasWorkspaceDiagnosticsListeners(workspaceId)) {
        continue;
      }

      const workspaceGeneration = this.getWorkspaceGeneration(workspaceId);
      for (const [clientKey, client] of entry.clients) {
        if (client.isClosed) {
          continue;
        }

        const trackedFiles = client.getTrackedFiles?.();
        if (!trackedFiles || trackedFiles.length === 0) {
          continue;
        }

        const pollKey = `${workspaceId}:${clientKey}`;
        if (this.diagnosticPollsInFlight.has(pollKey)) {
          continue;
        }

        // Poll-driven diagnostics refreshes are the only activity for already-open files,
        // so they need to keep the workspace warm between idle-cleanup passes.
        this.markActivity(workspaceId);
        const pollToken = Symbol(pollKey);
        this.diagnosticPollsInFlight.set(pollKey, pollToken);
        void this.refreshTrackedFilesForClient({
          workspaceId,
          workspaceGeneration,
          clientKey,
          client,
          fileEntries: trackedFiles.map((fileHandle) => ({
            filePath: fileHandle.readablePath,
            fileHandle,
          })),
          waitForDiagnostics: false,
          logReason: "polled LSP diagnostics",
        }).finally(() => {
          if (this.diagnosticPollsInFlight.get(pollKey) === pollToken) {
            this.diagnosticPollsInFlight.delete(pollKey);
          }
        });
      }
    }
  }

  private async refreshTrackedFilesForClient(options: {
    workspaceId: string;
    workspaceGeneration: number;
    clientKey: string;
    client: LspClientInstance;
    fileEntries: LspTrackedFileRefreshEntry[];
    waitForDiagnostics: boolean;
    timeoutMs?: number;
    logReason: string;
  }): Promise<LspFileDiagnostics[]> {
    const diagnostics = await Promise.all(
      options.fileEntries.map(async ({ filePath, fileHandle }) => {
        return await this.serializeTrackedFileRefresh(
          options.workspaceId,
          options.clientKey,
          fileHandle.uri,
          async () => {
            try {
              if (
                options.workspaceGeneration !== this.getWorkspaceGeneration(options.workspaceId)
              ) {
                return undefined;
              }

              const previousPublish = this.getLatestDiagnosticPublish(
                options.workspaceId,
                options.clientKey,
                fileHandle.uri
              );
              const expectedVersion = await options.client.ensureFile(fileHandle);
              if (!options.waitForDiagnostics) {
                return undefined;
              }

              const freshPublish = await this.waitForFreshDiagnostics({
                workspaceId: options.workspaceId,
                workspaceGeneration: options.workspaceGeneration,
                clientKey: options.clientKey,
                uri: fileHandle.uri,
                previousReceivedAtMs: previousPublish?.receivedAtMs,
                expectedVersion,
                timeoutMs: options.timeoutMs ?? LSP_POST_MUTATION_DIAGNOSTICS_TIMEOUT_MS,
              });

              if (!freshPublish) {
                return undefined;
              }

              const snapshot = this.getCachedDiagnostics(
                options.workspaceId,
                options.clientKey,
                fileHandle.uri
              );
              if (snapshot && snapshot.receivedAtMs === freshPublish.receivedAtMs) {
                return snapshot;
              }

              return undefined;
            } catch (error) {
              if (isTrackedFileMissingError(error)) {
                await this.handleMissingTrackedFile({
                  workspaceId: options.workspaceId,
                  clientKey: options.clientKey,
                  client: options.client,
                  filePath,
                  fileHandle,
                });
                return undefined;
              }

              log.debug(`Skipping ${options.logReason} for file`, {
                workspaceId: options.workspaceId,
                filePath,
                error,
              });
              return undefined;
            }
          }
        );
      })
    );

    return diagnostics.filter((snapshot): snapshot is LspFileDiagnostics => snapshot !== undefined);
  }

  private async serializeTrackedFileRefresh<T>(
    workspaceId: string,
    clientKey: string,
    uri: string,
    refresh: () => Promise<T>
  ): Promise<T> {
    const refreshKey = `${workspaceId}:${clientKey}:${uri}`;
    const previousRefresh = this.trackedFileRefreshesInFlight.get(refreshKey) ?? Promise.resolve();
    const nextRefresh = previousRefresh.catch(() => undefined).then(refresh);
    this.trackedFileRefreshesInFlight.set(refreshKey, nextRefresh);

    try {
      return await nextRefresh;
    } finally {
      if (this.trackedFileRefreshesInFlight.get(refreshKey) === nextRefresh) {
        this.trackedFileRefreshesInFlight.delete(refreshKey);
      }
    }
  }

  private async handleMissingTrackedFile(options: {
    workspaceId: string;
    clientKey: string;
    client: LspClientInstance;
    filePath: string;
    fileHandle: LspClientFileHandle;
  }): Promise<void> {
    try {
      await options.client.closeTrackedFile?.(options.fileHandle.uri);
    } catch (error) {
      log.debug("Failed to close disappeared tracked LSP file", {
        workspaceId: options.workspaceId,
        filePath: options.filePath,
        error,
      });
    }

    this.clearCachedDiagnostics(options.workspaceId, options.clientKey, options.fileHandle.uri);
  }

  async disposeWorkspace(workspaceId: string): Promise<void> {
    this.workspaceGenerations.set(workspaceId, this.getWorkspaceGeneration(workspaceId) + 1);
    this.clearWorkspaceRefreshBookkeeping(workspaceId);

    const entry = this.workspaceClients.get(workspaceId);
    if (!entry) {
      this.clearWorkspaceDiagnostics(workspaceId);
      return;
    }

    this.workspaceClients.delete(workspaceId);
    this.clearWorkspaceDiagnostics(workspaceId);
    const pendingClients = await Promise.allSettled(entry.pendingClients.values());
    const clientsToClose = new Set(entry.clients.values());
    for (const result of pendingClients) {
      if (result.status === "fulfilled") {
        clientsToClose.add(result.value);
      }
    }

    await Promise.all(
      [...clientsToClose].map(async (client) => {
        try {
          await client.close();
        } catch (error) {
          log.debug("Failed to close LSP client during workspace disposal", {
            workspaceId,
            error,
          });
        }
      })
    );
  }

  async dispose(): Promise<void> {
    clearInterval(this.idleInterval);
    clearInterval(this.diagnosticPollInterval);
    const workspaceIds = new Set([
      ...this.workspaceClients.keys(),
      ...this.workspaceDiagnostics.keys(),
      ...this.workspaceDiagnosticListeners.keys(),
    ]);
    await Promise.all(
      [...workspaceIds].map(async (workspaceId) => this.disposeWorkspace(workspaceId))
    );
    this.diagnosticPollsInFlight.clear();
    this.workspaceDiagnosticListeners.clear();
  }

  // Reset per-workspace refresh state on disposal so a later workspace with the same id
  // never inherits stale poll or serialization bookkeeping from the disposed instance.
  private clearWorkspaceRefreshBookkeeping(workspaceId: string): void {
    const workspaceKeyPrefix = `${workspaceId}:`;

    for (const pollKey of [...this.diagnosticPollsInFlight.keys()]) {
      if (pollKey.startsWith(workspaceKeyPrefix)) {
        this.diagnosticPollsInFlight.delete(pollKey);
      }
    }

    for (const refreshKey of [...this.trackedFileRefreshesInFlight.keys()]) {
      if (refreshKey.startsWith(workspaceKeyPrefix)) {
        this.trackedFileRefreshesInFlight.delete(refreshKey);
      }
    }
  }

  private hasDiagnosticPollInFlight(workspaceId: string): boolean {
    const workspaceKeyPrefix = `${workspaceId}:`;
    return [...this.diagnosticPollsInFlight.keys()].some((pollKey) =>
      pollKey.startsWith(workspaceKeyPrefix)
    );
  }

  private hasWorkspaceDiagnosticsListeners(workspaceId: string): boolean {
    return (this.workspaceDiagnosticListeners.get(workspaceId)?.size ?? 0) > 0;
  }

  private async getOrCreateClient(
    workspaceId: string,
    descriptor: LspServerDescriptor,
    runtime: Runtime,
    pathMapper: LspPathMapper,
    rootPath: string,
    rootUri: string,
    policyContext: LspPolicyContext
  ): Promise<{ client: LspClientInstance; clientKey: string; workspaceGeneration: number }> {
    const workspaceEntry = this.workspaceClients.get(workspaceId) ?? {
      clients: new Map<string, LspClientInstance>(),
      pendingClients: new Map<string, Promise<LspClientInstance>>(),
      launchPlans: new Map<string, Promise<ResolvedLspLaunchPlan>>(),
      lastActivity: Date.now(),
    };
    this.workspaceClients.set(workspaceId, workspaceEntry);

    const clientKey = this.getClientKey(descriptor.id, rootUri, policyContext);
    const workspaceGeneration = this.getWorkspaceGeneration(workspaceId);
    const existingClient = workspaceEntry.clients.get(clientKey);
    if (existingClient && !existingClient.isClosed) {
      workspaceEntry.lastActivity = Date.now();
      return { client: existingClient, clientKey, workspaceGeneration };
    }

    if (existingClient?.isClosed) {
      workspaceEntry.clients.delete(clientKey);
      // Re-resolve launch plans when a client restarts so executable/path changes do not
      // stay pinned to a stale absolute command across the workspace lifetime.
      workspaceEntry.launchPlans.delete(clientKey);
    }

    const pendingClient = workspaceEntry.pendingClients.get(clientKey);
    if (pendingClient) {
      return {
        client: await pendingClient,
        clientKey,
        workspaceGeneration,
      };
    }

    const launchPlanPromise = this.getOrCreateLaunchPlan(
      workspaceEntry,
      clientKey,
      descriptor,
      runtime,
      rootPath,
      pathMapper.getWorkspaceRuntimePath(),
      policyContext
    );

    // Deduplicate concurrent queries for the same workspace/root so we never spawn
    // orphaned LSP processes that escape manager tracking.
    const clientPromise = launchPlanPromise
      .then(async (launchPlan) => {
        if (this.workspaceClients.get(workspaceId) !== workspaceEntry) {
          throw new Error(
            `LSP workspace ${workspaceId} was disposed while starting ${descriptor.id}`
          );
        }

        return await this.clientFactory({
          descriptor,
          launchPlan,
          runtime,
          rootPath,
          rootUri,
          onPublishDiagnostics: (params) =>
            this.handlePublishDiagnostics({
              workspaceId,
              workspaceGeneration,
              clientKey,
              serverId: descriptor.id,
              rootUri,
              pathMapper,
              params,
            }),
        });
      })
      .then(async (client) => {
        const currentWorkspaceEntry = this.workspaceClients.get(workspaceId);
        if (currentWorkspaceEntry !== workspaceEntry) {
          try {
            await client.close();
          } catch (error) {
            log.debug("Failed to close LSP client created after workspace disposal", {
              workspaceId,
              clientKey,
              error,
            });
          }
          throw new Error(
            `LSP workspace ${workspaceId} was disposed while starting ${descriptor.id}`
          );
        }

        workspaceEntry.clients.set(clientKey, client);
        workspaceEntry.lastActivity = Date.now();
        return client;
      })
      .finally(() => {
        const currentWorkspaceEntry = this.workspaceClients.get(workspaceId);
        if (currentWorkspaceEntry === workspaceEntry) {
          workspaceEntry.pendingClients.delete(clientKey);
        }
      });

    workspaceEntry.pendingClients.set(clientKey, clientPromise);
    return {
      client: await clientPromise,
      clientKey,
      workspaceGeneration,
    };
  }

  private getOrCreateLaunchPlan(
    workspaceEntry: WorkspaceClients,
    clientKey: string,
    descriptor: LspServerDescriptor,
    runtime: Runtime,
    rootPath: string,
    workspacePath: string,
    policyContext: LspPolicyContext
  ): Promise<ResolvedLspLaunchPlan> {
    const existingLaunchPlan = workspaceEntry.launchPlans.get(clientKey);
    if (existingLaunchPlan) {
      return existingLaunchPlan;
    }

    const launchPlanPromise = resolveLspLaunchPlan({
      descriptor,
      runtime,
      rootPath,
      workspacePath,
      policyContext,
    }).catch((error) => {
      workspaceEntry.launchPlans.delete(clientKey);
      throw error;
    });

    workspaceEntry.launchPlans.set(clientKey, launchPlanPromise);
    return launchPlanPromise;
  }

  private async resolveClientContext(
    options: ResolveLspClientContextOptions
  ): Promise<ResolvedLspClientContext> {
    const pathMapper = new LspPathMapper({
      runtime: options.runtime,
      workspacePath: options.workspacePath,
    });
    const runtimeFilePath = pathMapper.toRuntimePath(options.filePath ?? "");
    if (!pathMapper.isWithinWorkspace(runtimeFilePath)) {
      throw new Error(`LSP paths must stay inside the workspace (got ${options.filePath})`);
    }

    const runtimePathStat = await statOrNull(options.runtime, runtimeFilePath);
    const shouldInferFromDirectory =
      "operation" in options &&
      options.operation === "workspace_symbols" &&
      runtimePathStat?.isDirectory === true;
    const workspaceRuntimePath = pathMapper.getWorkspaceRuntimePath();

    let descriptor: LspServerDescriptor;
    let rootPath: string;
    let fileHandle: LspClientFileHandle | undefined;

    if (shouldInferFromDirectory) {
      const inferredDescriptor = await this.inferDescriptorForDirectory(
        options.runtime,
        runtimeFilePath,
        workspaceRuntimePath,
        options.filePath
      );
      descriptor = inferredDescriptor.descriptor;
      rootPath = inferredDescriptor.rootPath;
    } else {
      descriptor =
        findLspServerForFile(runtimeFilePath, this.registry) ??
        failForUnsupportedFile(runtimeFilePath);
      rootPath = await this.resolveRootPath(
        options.runtime,
        runtimeFilePath,
        workspaceRuntimePath,
        descriptor.rootMarkers
      );
      fileHandle = {
        runtimePath: runtimeFilePath,
        readablePath: pathMapper.toReadablePath(runtimeFilePath),
        uri: pathMapper.toUri(runtimeFilePath),
        languageId: descriptor.languageIdForPath(runtimeFilePath),
      };
    }

    const rootUri = pathMapper.toUri(rootPath);
    const clientResult = await this.getOrCreateClient(
      options.workspaceId,
      descriptor,
      options.runtime,
      pathMapper,
      rootPath,
      rootUri,
      options.policyContext
    );

    return {
      client: clientResult.client,
      clientKey: clientResult.clientKey,
      workspaceGeneration: clientResult.workspaceGeneration,
      descriptor,
      ...(fileHandle ? { fileHandle } : {}),
      pathMapper,
      rootUri,
    };
  }

  private async queryWorkspaceSymbolsForDirectory(
    options: LspManagerQueryOptions
  ): Promise<LspManagerQueryResult | undefined> {
    if (options.operation !== "workspace_symbols") {
      return undefined;
    }

    const pathMapper = new LspPathMapper({
      runtime: options.runtime,
      workspacePath: options.workspacePath,
    });
    const runtimeFilePath = pathMapper.toRuntimePath(options.filePath ?? "");
    if (!pathMapper.isWithinWorkspace(runtimeFilePath)) {
      throw new Error(`LSP paths must stay inside the workspace (got ${options.filePath})`);
    }

    const runtimePathStat = await statOrNull(options.runtime, runtimeFilePath);
    if (runtimePathStat?.isDirectory !== true) {
      return undefined;
    }

    const workspaceRuntimePath = pathMapper.getWorkspaceRuntimePath();
    const queryRootDiscovery = await this.discoverWorkspaceSymbolsQueryRoots(
      options.runtime,
      runtimeFilePath,
      workspaceRuntimePath
    );
    if (queryRootDiscovery.matches.length === 0) {
      throw new Error(
        `Could not infer a built-in LSP server for directory ${options.filePath}. Provide a representative source file path or use a directory with a language-specific project marker.`
      );
    }

    const mergedSymbols = new Map<string, LspSymbolResult>();
    const queryFailures: WorkspaceSymbolsQueryFailure[] = [];
    let firstSuccessfulRoot:
      | {
          serverId: string;
          rootUri: string;
        }
      | undefined;

    for (const match of queryRootDiscovery.matches) {
      const rootUri = pathMapper.toUri(match.rootPath);
      try {
        const clientResult = await this.getOrCreateClient(
          options.workspaceId,
          match.descriptor,
          options.runtime,
          pathMapper,
          match.rootPath,
          rootUri,
          options.policyContext
        );
        const rawResult = await clientResult.client.query({
          operation: options.operation,
          query: options.query,
          includeDeclaration: options.includeDeclaration,
        });
        const symbols = await this.buildWorkspaceSymbolResults(
          pathMapper,
          options.runtime,
          rawResult.symbols ?? []
        );
        firstSuccessfulRoot ??= {
          serverId: match.descriptor.id,
          rootUri,
        };
        for (const symbol of symbols) {
          mergedSymbols.set(getWorkspaceSymbolIdentity(symbol), symbol);
        }
      } catch (error) {
        queryFailures.push({
          match,
          reason: getErrorMessage(error),
        });
      }
    }

    if (!firstSuccessfulRoot) {
      throw new Error(
        buildWorkspaceSymbolsDirectorySearchError(
          options.filePath,
          queryFailures.map((failure) =>
            describeWorkspaceSymbolsQueryFailure(pathMapper, failure)
          ),
          queryRootDiscovery.truncated
        )
      );
    }

    this.markActivity(options.workspaceId);
    const dedupedSymbols = [...mergedSymbols.values()];
    const warning = joinWarnings([
      queryRootDiscovery.truncated
        ? `Directory root scan was truncated to the first ${LSP_MAX_WORKSPACE_SYMBOL_QUERY_ROOTS} matching LSP roots`
        : undefined,
      queryFailures.length > 0
        ? `Skipped ${queryFailures.length} failing LSP root${queryFailures.length === 1 ? "" : "s"}: ${queryFailures
            .map((failure) => describeWorkspaceSymbolsQueryFailure(pathMapper, failure))
            .join("; ")}`
        : undefined,
      dedupedSymbols.length > LSP_MAX_SYMBOLS
        ? `Results truncated to the first ${LSP_MAX_SYMBOLS} symbols`
        : undefined,
    ]);

    return {
      operation: "workspace_symbols",
      serverId: firstSuccessfulRoot.serverId,
      rootUri: firstSuccessfulRoot.rootUri,
      symbols: dedupedSymbols.slice(0, LSP_MAX_SYMBOLS),
      ...(warning ? { warning } : {}),
    };
  }

  private async discoverWorkspaceSymbolsQueryRoots(
    runtime: Runtime,
    directoryPath: string,
    workspaceRuntimePath: string
  ): Promise<WorkspaceSymbolsQueryRootDiscovery> {
    const queryRootsByKey = new Map<string, ResolvedDirectoryDescriptorMatch>();
    const descriptorSelection = await this.resolveDirectoryDescriptorSelection(
      runtime,
      directoryPath,
      workspaceRuntimePath
    );
    if (descriptorSelection.kind === "selected") {
      addDirectoryDescriptorMatch(queryRootsByKey, descriptorSelection.match);
    } else if (descriptorSelection.kind === "ambiguous") {
      for (const match of descriptorSelection.matches) {
        addDirectoryDescriptorMatch(queryRootsByKey, match);
      }
    }

    const descendantMatches = await this.findDescendantDirectoryDescriptorMatches(
      runtime,
      directoryPath,
      workspaceRuntimePath
    );
    for (const match of descendantMatches) {
      addDirectoryDescriptorMatch(queryRootsByKey, match);
    }

    const sortedMatches = sortWorkspaceSymbolsQueryRoots(
      [...queryRootsByKey.values()],
      directoryPath,
      this.registry
    );

    return {
      matches: sortedMatches.slice(0, LSP_MAX_WORKSPACE_SYMBOL_QUERY_ROOTS),
      truncated: sortedMatches.length > LSP_MAX_WORKSPACE_SYMBOL_QUERY_ROOTS,
    };
  }

  private async findDescendantDirectoryDescriptorMatches(
    runtime: Runtime,
    directoryPath: string,
    workspaceRuntimePath: string
  ): Promise<ResolvedDirectoryDescriptorMatch[]> {
    const matches: ResolvedDirectoryDescriptorMatch[] = [];

    for (const descriptor of this.registry) {
      const specificRootMarkers = descriptor.rootMarkers.filter(
        (marker) => !isGenericLspRootMarker(marker)
      );
      if (specificRootMarkers.length === 0) {
        continue;
      }

      const markerPaths = await this.findDescendantMarkerPaths(
        runtime,
        directoryPath,
        workspaceRuntimePath,
        specificRootMarkers
      );
      for (const markerPath of markerPaths) {
        const pathModule = selectPathModule(markerPath);
        matches.push({
          descriptor,
          rootPath: pathModule.dirname(markerPath),
          matchedMarker: pathModule.basename(markerPath),
        });
      }
    }

    return matches;
  }

  private async findDescendantMarkerPaths(
    runtime: Runtime,
    directoryPath: string,
    workspaceRuntimePath: string,
    markers: readonly string[]
  ): Promise<string[]> {
    if (markers.length === 0) {
      return [];
    }

    // Keep the directory walk LSP-local by using the existing runtime exec surface instead of
    // widening Runtime with another file-system traversal primitive just for workspace_symbols.
    const ignoredDirectoryExpression = WORKSPACE_SYMBOLS_ROOT_SCAN_IGNORED_DIRECTORY_NAMES.map(
      (directoryName) => `-name ${shellQuote(directoryName)}`
    ).join(" -o ");
    const markerExpression = markers
      .map((marker) => `-name ${shellQuote(marker)}`)
      .join(" -o ");
    const findResult = await execBuffered(
      runtime,
      `find ${shellQuote(directoryPath)} '(' ${ignoredDirectoryExpression} ')' -type d -prune -o -type f '(' ${markerExpression} ')' -print0`,
      {
        cwd: workspaceRuntimePath,
        timeout: 30,
      }
    );
    if (findResult.exitCode !== 0) {
      const errorOutput = findResult.stderr.trim() || findResult.stdout.trim();
      throw new Error(
        errorOutput.length > 0
          ? errorOutput
          : `Failed to scan ${directoryPath} for nested LSP roots (exit ${findResult.exitCode})`
      );
    }

    return findResult.stdout.split(" ").filter((markerPath) => markerPath.length > 0);
  }

  private async resolveDirectoryDescriptorSelection(
    runtime: Runtime,
    directoryPath: string,
    workspaceRuntimePath: string
  ): Promise<ResolvedDirectoryDescriptorSelection> {
    const matches = (
      await Promise.all(
        this.registry.map(async (descriptor) => ({
          descriptor,
          ...(await this.resolveRootMatch(
            runtime,
            directoryPath,
            workspaceRuntimePath,
            descriptor.rootMarkers,
            true
          )),
        }))
      )
    ).filter((candidate) => candidate.matchedMarker != null);

    const specificMatches = matches.filter(
      (candidate) => !isGenericLspRootMarker(candidate.matchedMarker)
    );
    const candidateMatches = specificMatches.length > 0 ? specificMatches : matches;
    const selectedMatch = pickDeepestRootMatch(candidateMatches, workspaceRuntimePath);
    if (!selectedMatch) {
      return { kind: "none" };
    }

    const bestDepth = getWorkspaceRelativePathDepth(selectedMatch.rootPath, workspaceRuntimePath);
    const ambiguousMatches = candidateMatches.filter(
      (candidate) =>
        getWorkspaceRelativePathDepth(candidate.rootPath, workspaceRuntimePath) === bestDepth
    );
    if (ambiguousMatches.length > 1) {
      return {
        kind: "ambiguous",
        matches: ambiguousMatches,
      };
    }

    return {
      kind: "selected",
      match: selectedMatch,
    };
  }

  private async inferDescriptorForDirectory(
    runtime: Runtime,
    directoryPath: string,
    workspaceRuntimePath: string,
    outputPath: string
  ): Promise<{ descriptor: LspServerDescriptor; rootPath: string }> {
    const descriptorSelection = await this.resolveDirectoryDescriptorSelection(
      runtime,
      directoryPath,
      workspaceRuntimePath
    );
    if (descriptorSelection.kind === "none") {
      throw new Error(
        `Could not infer a built-in LSP server for directory ${outputPath}. Provide a representative source file path or use a directory with a language-specific project marker.`
      );
    }

    if (descriptorSelection.kind === "ambiguous") {
      throw new Error(buildWorkspaceSymbolsAmbiguityError(outputPath, descriptorSelection.matches));
    }

    return {
      descriptor: descriptorSelection.match.descriptor,
      rootPath: descriptorSelection.match.rootPath,
    };
  }

  private markActivity(workspaceId: string): void {
    const entry = this.workspaceClients.get(workspaceId);
    if (!entry) {
      return;
    }

    entry.lastActivity = Date.now();
  }

  private getWorkspaceGeneration(workspaceId: string): number {
    return this.workspaceGenerations.get(workspaceId) ?? 0;
  }

  private async cleanupIdleWorkspaces(): Promise<void> {
    const now = Date.now();
    for (const [workspaceId, entry] of this.workspaceClients) {
      if ((this.workspaceLeases.get(workspaceId) ?? 0) > 0) {
        continue;
      }

      if (this.hasDiagnosticPollInFlight(workspaceId)) {
        continue;
      }

      if (now - entry.lastActivity < this.idleTimeoutMs) {
        continue;
      }

      log.info("Stopping idle LSP clients", {
        workspaceId,
        idleMinutes: Math.round((now - entry.lastActivity) / 60_000),
      });
      await this.disposeWorkspace(workspaceId);
    }
  }

  private async resolveRootPath(
    runtime: Runtime,
    filePath: string,
    workspaceRuntimePath: string,
    rootMarkers: readonly string[]
  ): Promise<string> {
    return (
      await this.resolveRootMatch(runtime, filePath, workspaceRuntimePath, rootMarkers, false)
    ).rootPath;
  }

  private async resolveRootMatch(
    runtime: Runtime,
    targetPath: string,
    workspaceRuntimePath: string,
    rootMarkers: readonly string[],
    treatAsDirectory: boolean
  ): Promise<ResolvedRootMatch> {
    const pathModule = selectPathModule(targetPath);
    let currentPath = treatAsDirectory ? targetPath : pathModule.dirname(targetPath);

    while (true) {
      for (const marker of rootMarkers) {
        const markerPath = runtime.normalizePath(marker, currentPath);
        if (await pathExists(runtime, markerPath)) {
          return {
            rootPath: currentPath,
            matchedMarker: marker,
          };
        }
      }

      if (currentPath === workspaceRuntimePath) {
        return {
          rootPath: workspaceRuntimePath,
          matchedMarker: null,
        };
      }

      const parentPath = pathModule.dirname(currentPath);
      if (parentPath === currentPath) {
        return {
          rootPath: workspaceRuntimePath,
          matchedMarker: null,
        };
      }
      currentPath = parentPath;
    }
  }

  private handlePublishDiagnostics(context: {
    workspaceId: string;
    workspaceGeneration: number;
    clientKey: string;
    serverId: string;
    rootUri: string;
    pathMapper: LspPathMapper;
    params: LspPublishDiagnosticsParams;
  }): void {
    if (context.workspaceGeneration !== this.getWorkspaceGeneration(context.workspaceId)) {
      return;
    }

    const trackedFiles = this.workspaceClients
      .get(context.workspaceId)
      ?.clients.get(context.clientKey)
      ?.getTrackedFiles?.();
    if (trackedFiles && !trackedFiles.some((fileHandle) => fileHandle.uri === context.params.uri)) {
      return;
    }

    if (isMalformedDiagnosticPublish(context.params)) {
      return;
    }

    const receivedAtMs = Date.now();
    const publishReceipt: LspDiagnosticPublishReceipt = {
      version: context.params.version,
      receivedAtMs,
    };
    const publishesForWorkspace = this.getOrCreateDiagnosticPublishes(
      context.workspaceId,
      context.clientKey
    );
    publishesForWorkspace.set(context.params.uri, publishReceipt);

    const diagnosticsForWorkspace = this.getOrCreateWorkspaceDiagnostics(
      context.workspaceId,
      context.clientKey
    );
    if (context.params.diagnostics.length === 0) {
      diagnosticsForWorkspace.delete(context.params.uri);
    } else {
      const runtimePath = context.pathMapper.fromUri(context.params.uri);
      diagnosticsForWorkspace.set(context.params.uri, {
        uri: context.params.uri,
        path: context.pathMapper.toOutputPath(runtimePath),
        serverId: context.serverId,
        rootUri: context.rootUri,
        version: context.params.version,
        diagnostics: context.params.diagnostics,
        receivedAtMs,
      });
    }

    this.notifyDiagnosticWaiters(
      context.workspaceId,
      context.clientKey,
      context.params.uri,
      publishReceipt
    );
    this.notifyWorkspaceDiagnosticsListeners(context.workspaceId);
  }

  private getOrCreateWorkspaceDiagnostics(
    workspaceId: string,
    clientKey: string
  ): Map<string, LspFileDiagnostics> {
    const workspaceDiagnostics =
      this.workspaceDiagnostics.get(workspaceId) ??
      new Map<string, Map<string, LspFileDiagnostics>>();
    this.workspaceDiagnostics.set(workspaceId, workspaceDiagnostics);
    const diagnosticsForClient =
      workspaceDiagnostics.get(clientKey) ?? new Map<string, LspFileDiagnostics>();
    workspaceDiagnostics.set(clientKey, diagnosticsForClient);
    return diagnosticsForClient;
  }

  private getOrCreateDiagnosticPublishes(
    workspaceId: string,
    clientKey: string
  ): Map<string, LspDiagnosticPublishReceipt> {
    const workspacePublishes =
      this.workspaceDiagnosticPublishes.get(workspaceId) ??
      new Map<string, Map<string, LspDiagnosticPublishReceipt>>();
    this.workspaceDiagnosticPublishes.set(workspaceId, workspacePublishes);
    const publishesForClient =
      workspacePublishes.get(clientKey) ?? new Map<string, LspDiagnosticPublishReceipt>();
    workspacePublishes.set(clientKey, publishesForClient);
    return publishesForClient;
  }

  private getCachedDiagnostics(
    workspaceId: string,
    clientKey: string,
    uri: string
  ): LspFileDiagnostics | undefined {
    return this.workspaceDiagnostics.get(workspaceId)?.get(clientKey)?.get(uri);
  }

  private getLatestDiagnosticPublish(
    workspaceId: string,
    clientKey: string,
    uri: string
  ): LspDiagnosticPublishReceipt | undefined {
    return this.workspaceDiagnosticPublishes.get(workspaceId)?.get(clientKey)?.get(uri);
  }

  private clearCachedDiagnostics(workspaceId: string, clientKey: string, uri: string): void {
    let snapshotChanged = false;

    const workspaceDiagnostics = this.workspaceDiagnostics.get(workspaceId);
    const clientDiagnostics = workspaceDiagnostics?.get(clientKey);
    if (clientDiagnostics?.delete(uri)) {
      snapshotChanged = true;
      if (clientDiagnostics.size === 0) {
        workspaceDiagnostics?.delete(clientKey);
      }
      if (workspaceDiagnostics?.size === 0) {
        this.workspaceDiagnostics.delete(workspaceId);
      }
    }

    const workspacePublishes = this.workspaceDiagnosticPublishes.get(workspaceId);
    const clientPublishes = workspacePublishes?.get(clientKey);
    if (clientPublishes?.delete(uri) && clientPublishes.size === 0) {
      workspacePublishes?.delete(clientKey);
    }
    if (workspacePublishes?.size === 0) {
      this.workspaceDiagnosticPublishes.delete(workspaceId);
    }

    this.settleDiagnosticWaitersForUri(workspaceId, clientKey, uri);
    if (snapshotChanged) {
      this.notifyWorkspaceDiagnosticsListeners(workspaceId);
    }
  }

  private async waitForFreshDiagnostics(params: {
    workspaceId: string;
    workspaceGeneration: number;
    clientKey: string;
    uri: string;
    previousReceivedAtMs?: number;
    expectedVersion: number;
    timeoutMs: number;
  }): Promise<LspDiagnosticPublishReceipt | undefined> {
    if (params.workspaceGeneration !== this.getWorkspaceGeneration(params.workspaceId)) {
      return undefined;
    }

    const existingPublish = this.getLatestDiagnosticPublish(
      params.workspaceId,
      params.clientKey,
      params.uri
    );
    if (
      isFreshDiagnosticPublish(existingPublish, params.previousReceivedAtMs, params.expectedVersion)
    ) {
      return existingPublish;
    }

    return await new Promise<LspDiagnosticPublishReceipt | undefined>((resolve) => {
      let settled = false;
      const workspaceWaiters = this.getOrCreateDiagnosticWaiters(
        params.workspaceId,
        params.workspaceGeneration,
        params.clientKey,
        params.uri
      );
      if (!workspaceWaiters) {
        resolve(undefined);
        return;
      }

      const finish = (publish?: LspDiagnosticPublishReceipt) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        workspaceWaiters.delete(onPublish);
        if (workspaceWaiters.size === 0) {
          this.deleteDiagnosticWaiters(params.workspaceId, params.clientKey, params.uri);
        }
        resolve(publish);
      };

      const onPublish: LspDiagnosticWaiter = (publish) => {
        if (!publish) {
          finish(undefined);
          return;
        }
        if (
          !isFreshDiagnosticPublish(publish, params.previousReceivedAtMs, params.expectedVersion)
        ) {
          return;
        }
        finish(publish);
      };

      const timeoutId = setTimeout(() => finish(undefined), params.timeoutMs);
      workspaceWaiters.add(onPublish);

      const latestPublish = this.getLatestDiagnosticPublish(
        params.workspaceId,
        params.clientKey,
        params.uri
      );
      if (
        isFreshDiagnosticPublish(latestPublish, params.previousReceivedAtMs, params.expectedVersion)
      ) {
        finish(latestPublish);
      }
    });
  }

  private getOrCreateDiagnosticWaiters(
    workspaceId: string,
    workspaceGeneration: number,
    clientKey: string,
    uri: string
  ): Set<LspDiagnosticWaiter> | undefined {
    if (workspaceGeneration !== this.getWorkspaceGeneration(workspaceId)) {
      return undefined;
    }

    const workspaceWaiters =
      this.diagnosticWaiters.get(workspaceId) ??
      new Map<string, Map<string, Set<LspDiagnosticWaiter>>>();
    this.diagnosticWaiters.set(workspaceId, workspaceWaiters);
    const clientWaiters =
      workspaceWaiters.get(clientKey) ?? new Map<string, Set<LspDiagnosticWaiter>>();
    workspaceWaiters.set(clientKey, clientWaiters);
    const uriWaiters = clientWaiters.get(uri) ?? new Set<LspDiagnosticWaiter>();
    clientWaiters.set(uri, uriWaiters);
    return uriWaiters;
  }

  private deleteDiagnosticWaiters(workspaceId: string, clientKey: string, uri: string): void {
    const workspaceWaiters = this.diagnosticWaiters.get(workspaceId);
    const clientWaiters = workspaceWaiters?.get(clientKey);
    if (!clientWaiters) {
      return;
    }

    clientWaiters.delete(uri);
    if (clientWaiters.size === 0) {
      workspaceWaiters?.delete(clientKey);
    }
    if (workspaceWaiters?.size === 0) {
      this.diagnosticWaiters.delete(workspaceId);
    }
  }

  private settleWorkspaceDiagnosticWaiters(workspaceId: string): void {
    const workspaceWaiters = this.diagnosticWaiters.get(workspaceId);
    if (!workspaceWaiters) {
      return;
    }

    for (const clientWaiters of workspaceWaiters.values()) {
      for (const waiters of clientWaiters.values()) {
        for (const waiter of [...waiters]) {
          waiter(undefined);
        }
      }
    }
  }

  private settleDiagnosticWaitersForUri(workspaceId: string, clientKey: string, uri: string): void {
    const waiters = this.diagnosticWaiters.get(workspaceId)?.get(clientKey)?.get(uri);
    if (!waiters || waiters.size === 0) {
      return;
    }

    for (const waiter of [...waiters]) {
      waiter(undefined);
    }
  }

  private notifyDiagnosticWaiters(
    workspaceId: string,
    clientKey: string,
    uri: string,
    publish: LspDiagnosticPublishReceipt
  ): void {
    const waiters = this.diagnosticWaiters.get(workspaceId)?.get(clientKey)?.get(uri);
    if (!waiters || waiters.size === 0) {
      return;
    }

    for (const waiter of [...waiters]) {
      waiter(publish);
    }
  }

  private notifyWorkspaceDiagnosticsListeners(workspaceId: string): void {
    const listeners = this.workspaceDiagnosticListeners.get(workspaceId);
    if (!listeners || listeners.size === 0) {
      return;
    }

    const snapshot = this.getWorkspaceDiagnosticsSnapshot(workspaceId);
    for (const listener of [...listeners]) {
      listener(snapshot);
    }
  }

  private clearWorkspaceDiagnostics(workspaceId: string): void {
    this.settleWorkspaceDiagnosticWaiters(workspaceId);
    this.workspaceDiagnostics.delete(workspaceId);
    this.workspaceDiagnosticPublishes.delete(workspaceId);
    this.diagnosticWaiters.delete(workspaceId);
    this.notifyWorkspaceDiagnosticsListeners(workspaceId);
  }

  private getClientKey(serverId: string, rootUri: string, policyContext: LspPolicyContext): string {
    return `${serverId}:${rootUri}:${this.getPolicyContextKey(policyContext)}`;
  }

  private getPolicyContextKey(policyContext: LspPolicyContext): string {
    return `${policyContext.provisioningMode}:${policyContext.trustedWorkspaceExecution ? "trusted" : "untrusted"}`;
  }

  private async normalizeQueryResult(
    pathMapper: LspPathMapper,
    runtime: Runtime,
    fileHandle: LspClientFileHandle | undefined,
    serverId: string,
    rootUri: string,
    rawResult: LspClientQueryResult
  ): Promise<LspManagerQueryResult> {
    switch (rawResult.operation) {
      case "hover":
        return {
          operation: rawResult.operation,
          serverId,
          rootUri,
          hover: rawResult.hover ?? "",
        };
      case "definition":
      case "references":
      case "implementation": {
        const warning =
          rawResult.locations && rawResult.locations.length > LSP_MAX_LOCATIONS
            ? `Results truncated to the first ${LSP_MAX_LOCATIONS} locations`
            : undefined;
        const locations = await Promise.all(
          (rawResult.locations ?? [])
            .slice(0, LSP_MAX_LOCATIONS)
            .map(async (location) => this.buildLocationResult(pathMapper, runtime, location))
        );
        return {
          operation: rawResult.operation,
          serverId,
          rootUri,
          locations,
          ...(warning ? { warning } : {}),
        };
      }
      case "document_symbols": {
        const resolvedFileHandle = requireQueryFileHandle(fileHandle, rawResult.operation);
        const flattenedSymbols = flattenDocumentSymbols(
          rawResult.symbols ?? [],
          resolvedFileHandle.uri
        );
        const warning =
          flattenedSymbols.length > LSP_MAX_SYMBOLS
            ? `Results truncated to the first ${LSP_MAX_SYMBOLS} symbols`
            : undefined;
        const symbols = await Promise.all(
          flattenedSymbols.slice(0, LSP_MAX_SYMBOLS).map(async (symbol) =>
            this.buildSymbolResult(
              pathMapper,
              runtime,
              symbol.uri,
              symbol.range,
              symbol.name,
              symbol.kind,
              {
                detail: symbol.detail,
                containerName: symbol.containerName,
              }
            )
          )
        );
        return {
          operation: rawResult.operation,
          serverId,
          rootUri,
          symbols,
          ...(warning ? { warning } : {}),
        };
      }
      case "workspace_symbols": {
        const symbols = await this.buildWorkspaceSymbolResults(
          pathMapper,
          runtime,
          rawResult.symbols ?? []
        );
        const warning =
          symbols.length > LSP_MAX_SYMBOLS
            ? `Results truncated to the first ${LSP_MAX_SYMBOLS} symbols`
            : undefined;
        return {
          operation: rawResult.operation,
          serverId,
          rootUri,
          symbols: symbols.slice(0, LSP_MAX_SYMBOLS),
          ...(warning ? { warning } : {}),
        };
      }
    }
  }

  private async buildWorkspaceSymbolResults(
    pathMapper: LspPathMapper,
    runtime: Runtime,
    rawSymbols: Array<LspDocumentSymbol | LspSymbolInformation>
  ): Promise<LspSymbolResult[]> {
    const workspaceSymbols = flattenWorkspaceSymbols(rawSymbols);
    return await Promise.all(
      workspaceSymbols.map(async (symbol) =>
        this.buildSymbolResult(pathMapper, runtime, symbol.uri, symbol.range, symbol.name, symbol.kind, {
          detail: symbol.detail,
          containerName: symbol.containerName,
        })
      )
    );
  }

  private async buildLocationResult(
    pathMapper: LspPathMapper,
    runtime: Runtime,
    location: LspLocation
  ) {
    const runtimePath = pathMapper.fromUri(location.uri);
    const outputPath = pathMapper.toOutputPath(runtimePath);
    return {
      path: outputPath,
      uri: location.uri,
      range: toOneBasedRange(location.range),
      preview: await buildPreview(runtime, pathMapper.toReadablePath(runtimePath), location.range),
    };
  }

  private async buildSymbolResult(
    pathMapper: LspPathMapper,
    runtime: Runtime,
    uri: string,
    range: LspRange,
    name: string,
    kind: number,
    extra?: { detail?: string; containerName?: string }
  ) {
    const runtimePath = pathMapper.fromUri(uri);
    const outputPath = pathMapper.toOutputPath(runtimePath);
    return {
      name,
      kind,
      path: outputPath,
      range: toOneBasedRange(range),
      preview: await buildPreview(runtime, pathMapper.toReadablePath(runtimePath), range),
      ...(extra?.detail ? { detail: extra.detail } : {}),
      ...(extra?.containerName ? { containerName: extra.containerName } : {}),
    };
  }
}

type PathModule = typeof path.posix;

function selectPathModule(filePath: string): PathModule {
  if (/^[A-Za-z]:[\\/]/.test(filePath) || filePath.includes("\\")) {
    return path.win32;
  }
  return path.posix;
}

function formatDirectoryDescriptorMatch(match: ResolvedDirectoryDescriptorMatch): string {
  const matchedMarker = match.matchedMarker ?? "workspace root";
  return `${match.descriptor.id} (${matchedMarker})`;
}

function buildWorkspaceSymbolsAmbiguityError(
  outputPath: string,
  matches: ResolvedDirectoryDescriptorMatch[],
  detail?: string
): string {
  const matchingServers = matches.map((match) => formatDirectoryDescriptorMatch(match)).join(", ");
  return `Directory ${outputPath} is ambiguous for workspace_symbols; matching LSP servers: ${matchingServers}.${detail ?? ""} Provide a representative source file path to select the intended language server.`;
}

const WORKSPACE_SYMBOLS_ROOT_SCAN_IGNORED_DIRECTORY_NAMES = [".git", "node_modules"] as const;

function buildWorkspaceSymbolsDirectorySearchError(
  outputPath: string,
  attemptedRoots: string[],
  truncatedRootScan: boolean
): string {
  const truncationDetail = truncatedRootScan
    ? ` Directory root scan was truncated to the first ${LSP_MAX_WORKSPACE_SYMBOL_QUERY_ROOTS} matching LSP roots.`
    : "";
  return `workspace_symbols directory search failed for ${outputPath}; attempted roots: ${attemptedRoots.join("; ")}.${truncationDetail} Provide a representative source file path if you need to force a specific language server.`;
}

function describeWorkspaceSymbolsQueryFailure(
  pathMapper: LspPathMapper,
  failure: WorkspaceSymbolsQueryFailure
): string {
  return `${formatDirectoryDescriptorMatch(failure.match)} at ${formatWorkspaceSymbolsRootPath(
    pathMapper,
    failure.match.rootPath
  )}: ${failure.reason}`;
}

function formatWorkspaceSymbolsRootPath(pathMapper: LspPathMapper, rootPath: string): string {
  const workspaceRuntimePath = pathMapper.getWorkspaceRuntimePath();
  const pathModule = selectPathModule(rootPath);
  const relativePath = pathModule.relative(workspaceRuntimePath, rootPath);
  return relativePath.length === 0 ? "." : relativePath;
}

function addDirectoryDescriptorMatch(
  matchesByKey: Map<string, ResolvedDirectoryDescriptorMatch>,
  match: ResolvedDirectoryDescriptorMatch
): void {
  const key = `${match.descriptor.id}:${match.rootPath}`;
  const existingMatch = matchesByKey.get(key);
  if (
    !existingMatch ||
    getDirectoryDescriptorMarkerPriority(match) < getDirectoryDescriptorMarkerPriority(existingMatch)
  ) {
    matchesByKey.set(key, match);
  }
}

function getDirectoryDescriptorMarkerPriority(match: ResolvedDirectoryDescriptorMatch): number {
  const matchedMarker = match.matchedMarker;
  if (matchedMarker == null) {
    return Number.MAX_SAFE_INTEGER;
  }

  if (isGenericLspRootMarker(matchedMarker)) {
    return match.descriptor.rootMarkers.length + 1;
  }

  const markerIndex = match.descriptor.rootMarkers.indexOf(matchedMarker);
  return markerIndex >= 0 ? markerIndex : match.descriptor.rootMarkers.length;
}

function sortWorkspaceSymbolsQueryRoots(
  matches: readonly ResolvedDirectoryDescriptorMatch[],
  directoryPath: string,
  registry: readonly LspServerDescriptor[]
): ResolvedDirectoryDescriptorMatch[] {
  const descriptorOrder = new Map(registry.map((descriptor, index) => [descriptor.id, index]));
  return [...matches].sort((left, right) => {
    const leftSortKey = getWorkspaceSymbolsQueryRootSortKey(left.rootPath, directoryPath);
    const rightSortKey = getWorkspaceSymbolsQueryRootSortKey(right.rootPath, directoryPath);
    return (
      leftSortKey.group - rightSortKey.group ||
      leftSortKey.distance - rightSortKey.distance ||
      (descriptorOrder.get(left.descriptor.id) ?? Number.MAX_SAFE_INTEGER) -
        (descriptorOrder.get(right.descriptor.id) ?? Number.MAX_SAFE_INTEGER) ||
      left.rootPath.localeCompare(right.rootPath) ||
      getDirectoryDescriptorMarkerPriority(left) - getDirectoryDescriptorMarkerPriority(right)
    );
  });
}

function getWorkspaceSymbolsQueryRootSortKey(
  rootPath: string,
  directoryPath: string
): { group: number; distance: number } {
  const pathModule = selectPathModule(directoryPath);
  const relativeFromDirectory = pathModule.relative(directoryPath, rootPath);
  if (relativeFromDirectory.length === 0) {
    return { group: 0, distance: 0 };
  }

  if (isRelativeSubpath(pathModule, relativeFromDirectory)) {
    return {
      group: 0,
      distance: relativeFromDirectory.split(pathModule.sep).filter((segment) => segment.length > 0).length,
    };
  }

  const relativeFromRoot = pathModule.relative(rootPath, directoryPath);
  if (isRelativeSubpath(pathModule, relativeFromRoot)) {
    return {
      group: 1,
      distance: relativeFromRoot.split(pathModule.sep).filter((segment) => segment.length > 0).length,
    };
  }

  return { group: 2, distance: Number.MAX_SAFE_INTEGER };
}

function isRelativeSubpath(pathModule: PathModule, relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith(`..${pathModule.sep}`) &&
    relativePath !== ".." &&
    !pathModule.isAbsolute(relativePath)
  );
}

function getWorkspaceSymbolIdentity(symbol: LspSymbolResult): string {
  return [
    symbol.name,
    symbol.kind,
    symbol.path,
    symbol.containerName ?? "",
    symbol.range.start.line,
    symbol.range.start.character,
    symbol.range.end.line,
    symbol.range.end.character,
  ].join(":");
}

function joinWarnings(warnings: Array<string | undefined>): string | undefined {
  const definedWarnings = warnings.filter((warning): warning is string => warning != null);
  if (definedWarnings.length === 0) {
    return undefined;
  }

  return definedWarnings.join(" ");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function compareFileDiagnostics(left: LspFileDiagnostics, right: LspFileDiagnostics): number {
  return (
    left.path.localeCompare(right.path) ||
    left.serverId.localeCompare(right.serverId) ||
    left.rootUri.localeCompare(right.rootUri) ||
    left.uri.localeCompare(right.uri)
  );
}

function cloneFileDiagnostics(diagnostics: LspFileDiagnostics): LspFileDiagnostics {
  return {
    uri: diagnostics.uri,
    path: diagnostics.path,
    serverId: diagnostics.serverId,
    rootUri: diagnostics.rootUri,
    version: diagnostics.version,
    diagnostics: diagnostics.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      range: cloneRange(diagnostic.range),
    })),
    receivedAtMs: diagnostics.receivedAtMs,
  };
}

function cloneRange(range: LspRange): LspRange {
  return {
    start: { ...range.start },
    end: { ...range.end },
  };
}

function isTrackedFileMissingError(error: unknown): boolean {
  return typeof error === "object" && error != null && "code" in error && error.code === "ENOENT";
}

function isFreshDiagnosticPublish(
  publish: LspDiagnosticPublishReceipt | undefined,
  previousReceivedAtMs: number | undefined,
  expectedVersion: number
): publish is LspDiagnosticPublishReceipt {
  if (!publish) {
    return false;
  }

  if (publish.version != null) {
    return publish.version >= expectedVersion;
  }

  return publish.receivedAtMs > (previousReceivedAtMs ?? 0);
}

function isMalformedDiagnosticPublish(params: LspPublishDiagnosticsParams): boolean {
  return params.rawDiagnosticCount > 0 && params.diagnostics.length === 0;
}

async function pathExists(runtime: Runtime, candidatePath: string): Promise<boolean> {
  try {
    await runtime.stat(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function statOrNull(runtime: Runtime, candidatePath: string) {
  try {
    return await runtime.stat(candidatePath);
  } catch {
    return null;
  }
}

function shouldTrackQueryFile(operation: LspQueryOperation): boolean {
  return operation !== "workspace_symbols";
}

function requireQueryFileHandle(
  fileHandle: LspClientFileHandle | undefined,
  operation: LspQueryOperation
): LspClientFileHandle {
  if (!fileHandle) {
    throw new Error(`${operation} requires a source file path`);
  }

  return fileHandle;
}

function pickDeepestRootMatch<T extends { rootPath: string }>(
  matches: readonly T[],
  workspaceRuntimePath: string
): T | undefined {
  let selectedMatch: T | undefined;
  let selectedDepth = -1;

  for (const match of matches) {
    const matchDepth = getWorkspaceRelativePathDepth(match.rootPath, workspaceRuntimePath);
    if (matchDepth > selectedDepth) {
      selectedMatch = match;
      selectedDepth = matchDepth;
    }
  }

  return selectedMatch;
}

function getWorkspaceRelativePathDepth(
  candidatePath: string,
  workspaceRuntimePath: string
): number {
  const pathModule = selectPathModule(candidatePath);
  const relativePath = pathModule.relative(workspaceRuntimePath, candidatePath);
  if (relativePath.length === 0) {
    return 0;
  }

  return relativePath.split(pathModule.sep).filter((segment) => segment.length > 0).length;
}

function isGenericLspRootMarker(marker: string | null): boolean {
  return marker === ".git";
}

function failForUnsupportedFile(filePath: string): never {
  const extension = path.extname(filePath) || "(no extension)";
  throw new Error(`No built-in LSP server is configured for ${extension} files`);
}

function toOneBasedRange(range: LspRange): LspRange {
  return {
    start: {
      line: range.start.line + 1,
      character: range.start.character + 1,
    },
    end: {
      line: range.end.line + 1,
      character: range.end.character + 1,
    },
  };
}

async function buildPreview(
  runtime: Runtime,
  filePath: string,
  range: LspRange
): Promise<string | undefined> {
  try {
    const contents = await readFileString(runtime, filePath);
    const lines = contents.split("\n");
    const startLine = Math.max(1, range.start.line + 1 - LSP_PREVIEW_CONTEXT_LINES);
    const endLine = Math.min(
      lines.length,
      Math.max(range.start.line + 1, range.end.line + 1) + LSP_PREVIEW_CONTEXT_LINES
    );

    return lines
      .slice(startLine - 1, endLine)
      .map((line, index) => `${startLine + index}\t${line}`)
      .join("\n");
  } catch {
    return undefined;
  }
}

function flattenDocumentSymbols(
  symbols: Array<LspDocumentSymbol | LspSymbolInformation>,
  fallbackUri: string,
  containerName?: string
): Array<{
  name: string;
  kind: number;
  detail?: string;
  containerName?: string;
  range: LspRange;
  uri: string;
}> {
  const flattened: Array<{
    name: string;
    kind: number;
    detail?: string;
    containerName?: string;
    range: LspRange;
    uri: string;
  }> = [];

  for (const symbol of symbols) {
    if (!isDocumentSymbol(symbol)) {
      continue;
    }

    const documentSymbol = symbol;
    flattened.push({
      name: documentSymbol.name,
      kind: documentSymbol.kind,
      detail: documentSymbol.detail,
      containerName,
      range: documentSymbol.selectionRange,
      uri: documentSymbol.uri ?? fallbackUri,
    });

    if (documentSymbol.children?.length) {
      flattened.push(
        ...flattenDocumentSymbols(documentSymbol.children, fallbackUri, documentSymbol.name)
      );
    }
  }

  return flattened;
}

function flattenWorkspaceSymbols(symbols: Array<LspDocumentSymbol | LspSymbolInformation>): Array<{
  name: string;
  kind: number;
  detail?: string;
  containerName?: string;
  range: LspRange;
  uri: string;
}> {
  return symbols
    .map((symbol) => {
      if (
        !isWorkspaceSymbolInformation(symbol) ||
        !symbol.location ||
        !("range" in symbol.location)
      ) {
        return null;
      }

      return {
        name: symbol.name,
        kind: symbol.kind,
        detail: "detail" in symbol ? symbol.detail : undefined,
        containerName: symbol.containerName,
        range: symbol.location.range,
        uri: symbol.location.uri,
      };
    })
    .filter((symbol): symbol is NonNullable<typeof symbol> => symbol !== null);
}

function isDocumentSymbol(
  symbol: LspDocumentSymbol | LspSymbolInformation
): symbol is LspDocumentSymbol {
  return "selectionRange" in symbol;
}

function isWorkspaceSymbolInformation(
  symbol: LspDocumentSymbol | LspSymbolInformation
): symbol is LspSymbolInformation {
  return "location" in symbol;
}

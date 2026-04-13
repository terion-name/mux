import * as path from "node:path";
import { readFileString } from "@/node/utils/runtime/helpers";
import {
  LSP_IDLE_CHECK_INTERVAL_MS,
  LSP_IDLE_TIMEOUT_MS,
  LSP_MAX_LOCATIONS,
  LSP_MAX_SYMBOLS,
  LSP_POST_MUTATION_DIAGNOSTICS_TIMEOUT_MS,
  LSP_PREVIEW_CONTEXT_LINES,
} from "@/constants/lsp";
import type { Runtime } from "@/node/runtime/Runtime";
import type { WorkspaceLspDiagnosticsSnapshot } from "@/common/orpc/types";
import { log } from "@/node/services/log";
import { LspClient } from "./lspClient";
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
  LspPublishDiagnosticsParams,
  LspQueryOperation,
  LspRange,
  LspServerDescriptor,
  LspSymbolInformation,
} from "./types";

interface WorkspaceClients {
  clients: Map<string, LspClientInstance>;
  pendingClients: Map<string, Promise<LspClientInstance>>;
  lastActivity: number;
}

interface ResolvedLspClientContext {
  client: LspClientInstance;
  clientKey: string;
  workspaceGeneration: number;
  descriptor: LspServerDescriptor;
  fileHandle: LspClientFileHandle;
  pathMapper: LspPathMapper;
  rootUri: string;
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
}

export interface LspManagerQueryOptions {
  workspaceId: string;
  runtime: Runtime;
  workspacePath: string;
  filePath: string;
  operation: LspQueryOperation;
  line?: number;
  column?: number;
  query?: string;
  includeDeclaration?: boolean;
}

export interface LspManagerCollectDiagnosticsOptions {
  workspaceId: string;
  runtime: Runtime;
  workspacePath: string;
  filePaths: string[];
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
  private readonly idleInterval: ReturnType<typeof setInterval>;

  constructor(options?: LspManagerOptions) {
    this.registry = options?.registry ?? BUILTIN_LSP_SERVERS;
    this.clientFactory =
      options?.clientFactory ?? ((clientOptions) => LspClient.create(clientOptions));
    this.idleTimeoutMs = options?.idleTimeoutMs ?? LSP_IDLE_TIMEOUT_MS;
    this.idleCheckIntervalMs = options?.idleCheckIntervalMs ?? LSP_IDLE_CHECK_INTERVAL_MS;
    this.idleInterval = setInterval(() => {
      void this.cleanupIdleWorkspaces();
    }, this.idleCheckIntervalMs);
    this.idleInterval.unref?.();
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
      const context = await this.resolveClientContext(options);
      await context.client.ensureFile(context.fileHandle);

      const rawResult = await context.client.query({
        operation: options.operation,
        file: context.fileHandle,
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
        Array<{ filePath: string; context: ResolvedLspClientContext }>
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
            });
            const entriesForClient = fileContextsByClientKey.get(context.clientKey) ?? [];
            entriesForClient.push({ filePath, context });
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
          [...fileContextsByClientKey.values()].map(
            async (fileContexts) =>
              await Promise.all(
                fileContexts.map(async ({ filePath, context }) => {
                  try {
                    const previousPublish = this.getLatestDiagnosticPublish(
                      options.workspaceId,
                      context.clientKey,
                      context.fileHandle.uri
                    );
                    const expectedVersion = await context.client.ensureFile(context.fileHandle);
                    const freshPublish = await this.waitForFreshDiagnostics({
                      workspaceId: options.workspaceId,
                      workspaceGeneration: context.workspaceGeneration,
                      clientKey: context.clientKey,
                      uri: context.fileHandle.uri,
                      previousReceivedAtMs: previousPublish?.receivedAtMs,
                      expectedVersion,
                      timeoutMs: options.timeoutMs ?? LSP_POST_MUTATION_DIAGNOSTICS_TIMEOUT_MS,
                    });

                    if (!freshPublish) {
                      return undefined;
                    }

                    const snapshot = this.getCachedDiagnostics(
                      options.workspaceId,
                      context.clientKey,
                      context.fileHandle.uri
                    );
                    if (snapshot && snapshot.receivedAtMs === freshPublish.receivedAtMs) {
                      return snapshot;
                    }

                    return undefined;
                  } catch (error) {
                    log.debug("Skipping post-mutation LSP diagnostics for file", {
                      workspaceId: options.workspaceId,
                      filePath,
                      error,
                    });
                    return undefined;
                  }
                })
              )
          )
        )
      )
        .flat()
        .filter((snapshot): snapshot is LspFileDiagnostics => snapshot !== undefined);

      this.markActivity(options.workspaceId);
      return diagnostics.sort((left, right) => left.path.localeCompare(right.path));
    } finally {
      this.releaseLease(options.workspaceId);
    }
  }

  async disposeWorkspace(workspaceId: string): Promise<void> {
    this.workspaceGenerations.set(workspaceId, this.getWorkspaceGeneration(workspaceId) + 1);

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
    const workspaceIds = new Set([
      ...this.workspaceClients.keys(),
      ...this.workspaceDiagnostics.keys(),
      ...this.workspaceDiagnosticListeners.keys(),
    ]);
    await Promise.all(
      [...workspaceIds].map(async (workspaceId) => this.disposeWorkspace(workspaceId))
    );
    this.workspaceDiagnosticListeners.clear();
  }

  private async getOrCreateClient(
    workspaceId: string,
    descriptor: LspServerDescriptor,
    runtime: Runtime,
    pathMapper: LspPathMapper,
    rootPath: string,
    rootUri: string
  ): Promise<{ client: LspClientInstance; clientKey: string; workspaceGeneration: number }> {
    const workspaceEntry = this.workspaceClients.get(workspaceId) ?? {
      clients: new Map<string, LspClientInstance>(),
      pendingClients: new Map<string, Promise<LspClientInstance>>(),
      lastActivity: Date.now(),
    };
    this.workspaceClients.set(workspaceId, workspaceEntry);

    const clientKey = this.getClientKey(descriptor.id, rootUri);
    const workspaceGeneration = this.getWorkspaceGeneration(workspaceId);
    const existingClient = workspaceEntry.clients.get(clientKey);
    if (existingClient && !existingClient.isClosed) {
      workspaceEntry.lastActivity = Date.now();
      return { client: existingClient, clientKey, workspaceGeneration };
    }

    if (existingClient?.isClosed) {
      workspaceEntry.clients.delete(clientKey);
    }

    const pendingClient = workspaceEntry.pendingClients.get(clientKey);
    if (pendingClient) {
      return {
        client: await pendingClient,
        clientKey,
        workspaceGeneration,
      };
    }

    // Deduplicate concurrent queries for the same workspace/root so we never spawn
    // orphaned LSP processes that escape manager tracking.
    const clientPromise = this.clientFactory({
      descriptor,
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

  private async resolveClientContext(options: {
    workspaceId: string;
    runtime: Runtime;
    workspacePath: string;
    filePath: string;
  }): Promise<ResolvedLspClientContext> {
    const pathMapper = new LspPathMapper({
      runtime: options.runtime,
      workspacePath: options.workspacePath,
    });
    const runtimeFilePath = pathMapper.toRuntimePath(options.filePath);
    if (!pathMapper.isWithinWorkspace(runtimeFilePath)) {
      throw new Error(`LSP paths must stay inside the workspace (got ${options.filePath})`);
    }

    const descriptor = findLspServerForFile(runtimeFilePath, this.registry);
    if (!descriptor) {
      const extension = path.extname(runtimeFilePath) || "(no extension)";
      throw new Error(`No built-in LSP server is configured for ${extension} files`);
    }

    const rootPath = await this.resolveRootPath(
      options.runtime,
      runtimeFilePath,
      pathMapper.getWorkspaceRuntimePath(),
      descriptor.rootMarkers
    );
    const rootUri = pathMapper.toUri(rootPath);
    const fileHandle: LspClientFileHandle = {
      runtimePath: runtimeFilePath,
      readablePath: pathMapper.toReadablePath(runtimeFilePath),
      uri: pathMapper.toUri(runtimeFilePath),
      languageId: descriptor.languageIdForPath(runtimeFilePath),
    };

    const clientResult = await this.getOrCreateClient(
      options.workspaceId,
      descriptor,
      options.runtime,
      pathMapper,
      rootPath,
      rootUri
    );

    return {
      client: clientResult.client,
      clientKey: clientResult.clientKey,
      workspaceGeneration: clientResult.workspaceGeneration,
      descriptor,
      fileHandle,
      pathMapper,
      rootUri,
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
    const pathModule = selectPathModule(filePath);
    let currentPath = pathModule.dirname(filePath);

    while (true) {
      for (const marker of rootMarkers) {
        const markerPath = runtime.normalizePath(marker, currentPath);
        if (await pathExists(runtime, markerPath)) {
          return currentPath;
        }
      }

      if (currentPath === workspaceRuntimePath) {
        return workspaceRuntimePath;
      }

      const parentPath = pathModule.dirname(currentPath);
      if (parentPath === currentPath) {
        return workspaceRuntimePath;
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

  private getClientKey(serverId: string, rootUri: string): string {
    return `${serverId}:${rootUri}`;
  }

  private async normalizeQueryResult(
    pathMapper: LspPathMapper,
    runtime: Runtime,
    fileHandle: LspClientFileHandle,
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
        const flattenedSymbols = flattenDocumentSymbols(rawResult.symbols ?? [], fileHandle.uri);
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
        const workspaceSymbols = flattenWorkspaceSymbols(rawResult.symbols ?? []);
        const warning =
          workspaceSymbols.length > LSP_MAX_SYMBOLS
            ? `Results truncated to the first ${LSP_MAX_SYMBOLS} symbols`
            : undefined;
        const symbols = await Promise.all(
          workspaceSymbols.slice(0, LSP_MAX_SYMBOLS).map(async (symbol) =>
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
    }
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

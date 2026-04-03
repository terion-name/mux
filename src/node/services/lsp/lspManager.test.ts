import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { CreateLspClientOptions, LspClientInstance, LspServerDescriptor } from "./types";
import { LspManager } from "./lspManager";

describe("LspManager", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lsp-manager-"));
    await fs.mkdir(path.join(workspacePath, ".git"));
    await fs.mkdir(path.join(workspacePath, "src"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "src", "example.ts"), "export const value = 1;\n");
  });

  afterEach(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  test("reuses clients for the same workspace root and forwards normalized positions", async () => {
    const ensureFile = mock(() => Promise.resolve(undefined));
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
    const registry: readonly LspServerDescriptor[] = [
      {
        id: "typescript",
        extensions: [".ts"],
        command: "fake-lsp",
        args: ["--stdio"],
        rootMarkers: ["package.json", ".git"],
        languageIdForPath: () => "typescript",
      },
    ];

    const manager = new LspManager({
      registry,
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

    expect(lastQueryRequest).toBeDefined();
    if (!lastQueryRequest) {
      throw new Error("Expected the LSP client to receive a query");
    }
    expect(lastQueryRequest.line).toBe(1);
    expect(lastQueryRequest.character).toBe(2);

    await manager.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

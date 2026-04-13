import { describe, expect, it, mock } from "bun:test";
import { LspClient } from "./lspClient";
import type { CreateLspClientOptions, LspPublishDiagnosticsParams, LspServerDescriptor } from "./types";

function createDescriptor(): LspServerDescriptor {
  return {
    id: "typescript",
    extensions: [".ts"],
    command: "fake-lsp",
    args: ["--stdio"],
    rootMarkers: ["package.json", ".git"],
    languageIdForPath: () => "typescript",
  };
}

function createTransport() {
  return {
    onmessage: undefined as ((message: { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown }) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    start: mock(() => undefined),
    send: mock(() => Promise.resolve()),
    close: mock(() => Promise.resolve()),
    isClosed: () => false,
    getStderrTail: () => "",
  };
}

function createClient(options?: Partial<CreateLspClientOptions>) {
  const transport = createTransport();
  const client = new (LspClient as unknown as {
    new (clientOptions: CreateLspClientOptions, transport: ReturnType<typeof createTransport>): LspClient;
  })(
    {
      descriptor: createDescriptor(),
      runtime: {} as never,
      rootPath: "/tmp/workspace",
      rootUri: "file:///tmp/workspace",
      ...options,
    },
    transport
  );

  return {
    client,
    transport,
  };
}

describe("LspClient publishDiagnostics handling", () => {
  it("forwards valid publishDiagnostics notifications", () => {
    const onPublishDiagnostics = mock((_params: LspPublishDiagnosticsParams) => undefined);
    const { transport } = createClient({ onPublishDiagnostics });

    transport.onmessage?.({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///tmp/workspace/src/example.ts",
        version: 2,
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 4 },
              end: { line: 0, character: 9 },
            },
            severity: 1,
            code: "TS2322",
            source: "tsserver",
            message: "Type 'string' is not assignable to type 'number'.",
          },
        ],
      },
    });

    expect(onPublishDiagnostics).toHaveBeenCalledTimes(1);
    expect(onPublishDiagnostics.mock.calls[0]?.[0]).toEqual({
      uri: "file:///tmp/workspace/src/example.ts",
      version: 2,
      diagnostics: [
        {
          range: {
            start: { line: 0, character: 4 },
            end: { line: 0, character: 9 },
          },
          severity: 1,
          code: "TS2322",
          source: "tsserver",
          message: "Type 'string' is not assignable to type 'number'.",
        },
      ],
    });
  });

  it("ignores malformed publishDiagnostics notifications", () => {
    const onPublishDiagnostics = mock((_params: LspPublishDiagnosticsParams) => undefined);
    const { transport } = createClient({ onPublishDiagnostics });

    transport.onmessage?.({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///tmp/workspace/src/example.ts",
        diagnostics: [{ message: "missing range" }],
      },
    });

    expect(onPublishDiagnostics).toHaveBeenCalledTimes(1);
    expect(onPublishDiagnostics.mock.calls[0]?.[0]).toEqual({
      uri: "file:///tmp/workspace/src/example.ts",
      version: undefined,
      diagnostics: [],
    });
  });
});

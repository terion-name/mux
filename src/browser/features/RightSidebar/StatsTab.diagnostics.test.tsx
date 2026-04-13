import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render } from "@testing-library/react";

import type { WorkspaceLspDiagnosticsSnapshot } from "@/common/orpc/types";

let currentSnapshot: WorkspaceLspDiagnosticsSnapshot | null = null;

void mock.module("@/browser/stores/WorkspaceStore", () => ({
  useWorkspaceStatsSnapshot: () => null,
  useWorkspaceLspDiagnosticsSnapshot: () => currentSnapshot,
}));

import { DiagnosticsPanel } from "./StatsTab";

describe("DiagnosticsPanel", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    currentSnapshot = null;
  });

  afterEach(() => {
    cleanup();
    currentSnapshot = null;
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("shows a loading state before the first diagnostics snapshot arrives", () => {
    const view = render(<DiagnosticsPanel workspaceId="workspace-1" />);

    expect(view.getByText("Loading diagnostics...")).toBeTruthy();
  });

  test("shows an empty state when the diagnostics snapshot contains no entries", () => {
    currentSnapshot = {
      workspaceId: "workspace-1",
      diagnostics: [],
    };

    const view = render(<DiagnosticsPanel workspaceId="workspace-1" />);

    expect(view.getByText("No diagnostics for this workspace.")).toBeTruthy();
  });

  test("renders grouped diagnostics with severity labels and file metadata", () => {
    currentSnapshot = {
      workspaceId: "workspace-1",
      diagnostics: [
        {
          uri: "file:///workspace/src/example.ts",
          path: "/workspace/src/example.ts",
          serverId: "typescript",
          rootUri: "file:///workspace",
          version: 3,
          diagnostics: [
            {
              range: {
                start: { line: 1, character: 4 },
                end: { line: 1, character: 10 },
              },
              severity: 1,
              source: "tsserver",
              code: 2322,
              message: "Type 'string' is not assignable to type 'number'.",
            },
            {
              range: {
                start: { line: 4, character: 2 },
                end: { line: 4, character: 8 },
              },
              severity: 2,
              source: "eslint",
              code: "no-console",
              message: "Unexpected console statement.",
            },
          ],
          receivedAtMs: 1,
        },
        {
          uri: "file:///workspace/src/utils.ts",
          path: "/workspace/src/utils.ts",
          serverId: "typescript",
          rootUri: "file:///workspace",
          version: 1,
          diagnostics: [
            {
              range: {
                start: { line: 9, character: 0 },
                end: { line: 9, character: 4 },
              },
              severity: 3,
              source: "tsserver",
              message: "'helper' is declared but its value is never read.",
            },
          ],
          receivedAtMs: 2,
        },
      ],
    };

    const view = render(<DiagnosticsPanel workspaceId="workspace-1" />);

    expect(view.getByText("/workspace/src/example.ts")).toBeTruthy();
    expect(view.getByText("/workspace/src/utils.ts")).toBeTruthy();
    expect(view.getByText("Type 'string' is not assignable to type 'number'.")).toBeTruthy();
    expect(view.getByText("Unexpected console statement.")).toBeTruthy();
    expect(view.getByText("'helper' is declared but its value is never read.")).toBeTruthy();

    expect(view.container.textContent).toContain(
      "3 diagnostics across 2 files · 1 error · 1 warning · 1 information"
    );
    expect(view.container.textContent).toContain("Server: typescript");
    expect(view.container.textContent).toContain("Error · Line 2, Column 5 · tsserver · Code 2322");
    expect(view.container.textContent).toContain(
      "Warning · Line 5, Column 3 · eslint · Code no-console"
    );
    expect(view.container.textContent).toContain("Information · Line 10, Column 1 · tsserver");
  });
});

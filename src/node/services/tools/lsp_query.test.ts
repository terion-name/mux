import { describe, expect, mock, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import { LspManager } from "@/node/services/lsp/lspManager";
import { createTestToolConfig } from "./testHelpers";
import { createLspQueryTool } from "./lsp_query";
import type { LspQueryToolResult } from "@/common/types/tools";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "tool-call-id",
  messages: [],
};

describe("lsp_query tool", () => {
  test("returns formatted LSP data from the manager", async () => {
    const lspManager = new LspManager({ registry: [] });
    const query = mock(() =>
      Promise.resolve({
        operation: "hover" as const,
        serverId: "typescript",
        rootUri: "file:///tmp/workspace",
        hover: "const value: 1",
      })
    );
    lspManager.query = query;
    const config = createTestToolConfig(process.cwd());
    config.lspManager = lspManager;
    const configuredTool = createLspQueryTool(config);

    try {
      const result = (await configuredTool.execute!(
        {
          operation: "hover",
          path: "src/browser/App.tsx",
          line: 1,
          column: 1,
        },
        mockToolCallOptions
      )) as LspQueryToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.serverId).toBe("typescript");
        expect(result.hover).toBe("const value: 1");
      }
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      await lspManager.dispose();
    }
  });

  test("validates required position arguments for hover-like operations", async () => {
    const config = createTestToolConfig(process.cwd());
    const lspManager = new LspManager({ registry: [] });
    const query = mock(() =>
      Promise.resolve({
        operation: "hover" as const,
        serverId: "typescript",
        rootUri: "file:///tmp/workspace",
        hover: "",
      })
    );
    lspManager.query = query;
    config.lspManager = lspManager;
    const tool = createLspQueryTool(config);

    try {
      const result = (await tool.execute!(
        {
          operation: "definition",
          path: "src/browser/App.tsx",
        },
        mockToolCallOptions
      )) as LspQueryToolResult;

      expect(result).toEqual({
        success: false,
        error: "definition requires both line and column",
      });
    } finally {
      await lspManager.dispose();
    }
  });
});

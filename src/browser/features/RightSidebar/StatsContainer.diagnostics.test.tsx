import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render } from "@testing-library/react";

void mock.module("./CostsTab", () => ({
  CostsTab: () => <div>Costs panel</div>,
}));

describe("StatsContainer diagnostics", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("shows the Diagnostics sub-tab alongside the existing Stats tabs", async () => {
    // eslint-disable-next-line no-restricted-syntax -- The test must import after mock.module() so StatsContainer sees the stubbed CostsTab instead of loading Mermaid-heavy dependencies.
    const { StatsContainer } = await import("./StatsContainer");
    const view = render(<StatsContainer workspaceId="workspace-1" />);

    expect(view.getByText("Costs panel")).toBeTruthy();
    expect(view.getByRole("button", { name: "Cost" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Timing" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Models" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Diagnostics" })).toBeTruthy();
  });
});

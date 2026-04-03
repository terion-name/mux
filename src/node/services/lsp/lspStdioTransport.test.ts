import { describe, expect, test } from "bun:test";
import type { ExecStream } from "@/node/runtime/Runtime";
import { LspStdioTransport } from "./lspStdioTransport";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function createReadable(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function createExecStream(options: {
  stdoutChunks: string[];
  stderrChunks?: string[];
  writes?: string[];
  exitCode?: Promise<number>;
}): ExecStream {
  return {
    stdout: createReadable(options.stdoutChunks),
    stderr: createReadable(options.stderrChunks ?? []),
    stdin: new WritableStream<Uint8Array>({
      write(chunk) {
        options.writes?.push(decoder.decode(chunk));
      },
    }),
    exitCode: options.exitCode ?? Promise.resolve(0),
    duration: Promise.resolve(0),
  };
}

describe("LspStdioTransport", () => {
  test("parses Content-Length framed messages", async () => {
    const writes: string[] = [];
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
    const framed = `Content-Length: ${message.length}\r\n\r\n${message}`;
    const transport = new LspStdioTransport(
      createExecStream({
        stdoutChunks: [framed],
        stderrChunks: ["warning from server"],
        writes,
        exitCode: new Promise<number>(() => undefined),
      })
    );

    const messages: unknown[] = [];
    transport.onmessage = (parsed) => {
      messages.push(parsed);
    };

    transport.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { ok: true },
      },
    ]);
    expect(transport.getStderrTail()).toContain("warning from server");

    await transport.send({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
    });

    expect(writes.join("")).toContain("Content-Length:");
    expect(writes.join("")).toContain("\"method\":\"initialize\"");

    await transport.close();
  });
});

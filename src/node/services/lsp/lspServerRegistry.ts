import * as path from "node:path";
import type { LspServerDescriptor } from "./types";

function ext(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

const typescriptServer: LspServerDescriptor = {
  id: "typescript",
  extensions: TYPESCRIPT_EXTENSIONS,
  launch: {
    type: "manual",
    command: "typescript-language-server",
    args: ["--stdio"],
  },
  rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
  languageIdForPath(filePath: string): string {
    const fileExt = ext(filePath);
    if (fileExt === ".tsx") return "typescriptreact";
    if (fileExt === ".jsx") return "javascriptreact";
    if (fileExt === ".js" || fileExt === ".mjs" || fileExt === ".cjs") return "javascript";
    return "typescript";
  },
};

const pythonServer: LspServerDescriptor = {
  id: "python",
  extensions: [".py"],
  launch: {
    type: "manual",
    command: "pyright-langserver",
    args: ["--stdio"],
  },
  rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", ".git"],
  languageIdForPath(): string {
    return "python";
  },
};

const goServer: LspServerDescriptor = {
  id: "go",
  extensions: [".go"],
  launch: {
    type: "manual",
    command: "gopls",
  },
  rootMarkers: ["go.work", "go.mod", ".git"],
  languageIdForPath(): string {
    return "go";
  },
};

const rustServer: LspServerDescriptor = {
  id: "rust",
  extensions: [".rs"],
  launch: {
    type: "manual",
    command: "rust-analyzer",
  },
  rootMarkers: ["Cargo.toml", "rust-project.json", ".git"],
  languageIdForPath(): string {
    return "rust";
  },
};

export const BUILTIN_LSP_SERVERS: readonly LspServerDescriptor[] = [
  typescriptServer,
  pythonServer,
  goServer,
  rustServer,
];

export function findLspServerForFile(
  filePath: string,
  registry: readonly LspServerDescriptor[] = BUILTIN_LSP_SERVERS
): LspServerDescriptor | null {
  const fileExt = ext(filePath);
  return registry.find((descriptor) => descriptor.extensions.includes(fileExt)) ?? null;
}

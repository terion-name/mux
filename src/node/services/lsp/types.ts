import type { Runtime } from "@/node/runtime/Runtime";

export type LspQueryOperation =
  | "hover"
  | "definition"
  | "references"
  | "implementation"
  | "document_symbols"
  | "workspace_symbols";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
}

export interface LspMarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}

export interface LspMarkedString {
  language: string;
  value: string;
}

export interface LspHover {
  contents: string | LspMarkupContent | LspMarkedString | Array<string | LspMarkupContent | LspMarkedString>;
}

export interface LspDocumentSymbol {
  name: string;
  kind: number;
  detail?: string;
  range: LspRange;
  selectionRange: LspRange;
  uri?: string;
  children?: LspDocumentSymbol[];
}

export interface LspSymbolInformation {
  name: string;
  kind: number;
  detail?: string;
  location?: LspLocation | { uri: string };
  containerName?: string;
}

export interface LspSymbolResult {
  name: string;
  kind: number;
  detail?: string;
  containerName?: string;
  path: string;
  range: LspRange;
  preview?: string;
}

export interface LspLocationResult {
  path: string;
  uri: string;
  range: LspRange;
  preview?: string;
}

export interface LspManagerQueryResult {
  operation: LspQueryOperation;
  serverId: string;
  rootUri: string;
  hover?: string;
  locations?: LspLocationResult[];
  symbols?: LspSymbolResult[];
  warning?: string;
}

export interface LspServerDescriptor {
  id: string;
  extensions: readonly string[];
  command: string;
  args: readonly string[];
  rootMarkers: readonly string[];
  languageIdForPath(filePath: string): string;
}

export interface LspClientFileHandle {
  runtimePath: string;
  readablePath: string;
  uri: string;
  languageId: string;
}

export interface LspClientQueryRequest {
  operation: LspQueryOperation;
  file: LspClientFileHandle;
  line?: number;
  character?: number;
  query?: string;
  includeDeclaration?: boolean;
}

export interface LspClientQueryResult {
  operation: LspQueryOperation;
  hover?: string;
  locations?: LspLocation[];
  symbols?: Array<LspDocumentSymbol | LspSymbolInformation>;
}

export interface LspClientInstance {
  readonly isClosed: boolean;
  ensureFile(file: LspClientFileHandle): Promise<void>;
  query(request: LspClientQueryRequest): Promise<LspClientQueryResult>;
  close(): Promise<void>;
}

export interface CreateLspClientOptions {
  descriptor: LspServerDescriptor;
  runtime: Runtime;
  rootPath: string;
  rootUri: string;
}

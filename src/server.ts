#!/usr/bin/env node
import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  CompletionParams,
  DocumentSymbolParams,
  HoverParams,
  DocumentSymbol,
  SymbolKind,
  Hover,
  MarkupContent,
  InitializeResult,
  TextDocumentSyncKind,
  CancellationToken,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { fileURLToPath } from 'node:url';
import {
  defaultForgePath,
  ForgeSettings,
  ForgeSymbol,
  runForgeCheck,
  runForgeSymbols,
  scanSymbolsFromText,
} from './forge';
import { HOVER_DOCS, STDLIB_MODULES } from './constants';
import { keywordCompletions, stdlibCompletions, symbolCompletions, typeCompletions } from './completion';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let generation = 0;
let stopping = false;
const compilerWork = new Set<Promise<unknown>>();
function track<T>(work: Promise<T>): Promise<T> {
  compilerWork.add(work);
  void work.finally(() => compilerWork.delete(work)).catch(() => {});
  return work;
}
interface SymbolJob {
  version: number;
  generation: number;
  controller: AbortController;
  promise: Promise<ForgeSymbol[]>;
}
const symbolCache = new Map<string, SymbolJob>();
const diagnosticJobs = new Map<string, {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}>();

function invalidateSymbols(): void {
  for (const entry of symbolCache.values()) entry.controller.abort();
  symbolCache.clear();
}

async function documentSymbols(doc: TextDocument): Promise<ForgeSymbol[]> {
  if (stopping) return [];
  const cached = symbolCache.get(doc.uri);
  if (cached?.version === doc.version && cached.generation === generation) return cached.promise;
  cached?.controller.abort();
  const controller = new AbortController();
  const epoch = generation;
  const uri = doc.uri;
  const version = doc.version;
  const promise = track(runForgeSymbols(settings, uri, doc.getText(), controller.signal))
    .then(symbols => {
      if (stopping || generation !== epoch || documents.get(uri) !== doc
          || documents.get(uri)?.version !== version)
        return scanSymbolsFromText(doc.getText());
      return symbols;
    }).catch(() => scanSymbolsFromText(doc.getText()));
  symbolCache.set(uri, { version, generation: epoch, controller, promise });
  return promise;
}

async function requestSymbols(doc: TextDocument, token: CancellationToken): Promise<ForgeSymbol[]> {
  if (stopping || token.isCancellationRequested) return [];
  const work = documentSymbols(doc);
  return new Promise(resolve => {
    let done = false;
    let subscription: { dispose(): void } | undefined;
    const finish = (symbols: ForgeSymbol[]) => {
      if (done) return;
      done = true;
      subscription?.dispose();
      resolve(symbols);
    };
    subscription = token.onCancellationRequested(() => finish([]));
    void work.then(finish);
    if (token.isCancellationRequested) finish([]);
  });
}

function cancelDiagnostic(uri: string): void {
  const job = diagnosticJobs.get(uri);
  if (!job) return;
  clearTimeout(job.timer);
  job.controller.abort();
  diagnosticJobs.delete(uri);
}

let workspaceRoot: string | undefined;
let settings: ForgeSettings = {
  forgePath: 'forge',
  includePaths: [],
};

interface ForgeClientConfig {
  path?: string;
  forgeRoot?: string;
  libDir?: string;
  includePaths?: string[];
}

interface ForgeInitOptions {
  workspaceRoot?: string;
  forge?: ForgeClientConfig;
}

function folderPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri.replace(/^file:\/\//, '');
  }
}

function applyClientConfig(root: string | undefined, cfg?: ForgeClientConfig): void {
  generation++;
  invalidateSymbols();
  for (const uri of diagnosticJobs.keys()) cancelDiagnostic(uri);
  settings = {
    forgePath: cfg?.path || defaultForgePath(root),
    forgeRoot: cfg?.forgeRoot,
    libDir: cfg?.libDir,
    includePaths: cfg?.includePaths?.length
      ? cfg.includePaths
      : root ? [root] : [],
  };
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const init = params.initializationOptions as ForgeInitOptions | undefined;
  workspaceRoot = init?.workspaceRoot
    ?? (params.workspaceFolders?.[0]?.uri ? folderPath(params.workspaceFolders[0].uri) : undefined);
  applyClientConfig(workspaceRoot, init?.forge);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ['.', '"', ' '] },
      hoverProvider: true,
      documentSymbolProvider: true,
    },
  };
});

connection.onDidChangeConfiguration((change) => {
  const raw = change.settings as { forge?: ForgeClientConfig } | ForgeClientConfig | undefined;
  const cfg = raw && 'forge' in raw ? raw.forge : (raw as ForgeClientConfig | undefined);
  applyClientConfig(workspaceRoot, cfg);
  for (const doc of documents.all()) validate(doc);
});

function validate(doc: TextDocument): void {
  cancelDiagnostic(doc.uri);
  if (stopping) return;
  const uri = doc.uri;
  const version = doc.version;
  const epoch = generation;
  const text = doc.getText();
  const config = settings;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    void track(runForgeCheck(config, uri, text, controller.signal)).then(diagnostics => {
      if (!stopping && !controller.signal.aborted && generation === epoch
          && documents.get(uri) === doc && documents.get(uri)?.version === version)
        connection.sendDiagnostics({ uri, version, diagnostics });
    }).catch(error => {
      if (!controller.signal.aborted)
        connection.console.error(`Forge diagnostics failed: ${String(error)}`);
    }).finally(() => {
      if (diagnosticJobs.get(uri)?.controller === controller) diagnosticJobs.delete(uri);
    });
  }, 150);
  diagnosticJobs.set(uri, { controller, timer });
}

documents.onDidChangeContent((change) => {
  // Imports can change symbols in other open documents.
  invalidateSymbols();
  validate(change.document);
});
connection.onDidChangeWatchedFiles(() => {
  generation++;
  invalidateSymbols();
  for (const doc of documents.all()) validate(doc);
});
documents.onDidClose((e) => {
  symbolCache.get(e.document.uri)?.controller.abort();
  symbolCache.delete(e.document.uri);
  cancelDiagnostic(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});
documents.listen(connection);

connection.onCompletion(async (params: CompletionParams, token) => {
  const doc = documents.get(params.textDocument.uri);
  if (stopping || !doc) return [];
  const version = doc.version;
  const epoch = generation;
  const symbols = await requestSymbols(doc, token);
  if (stopping || token.isCancellationRequested || generation !== epoch
      || documents.get(doc.uri) !== doc || documents.get(doc.uri)?.version !== version) return [];
  return [...keywordCompletions(), ...typeCompletions(), ...stdlibCompletions(), ...symbolCompletions(symbols)];
});

connection.onDocumentSymbol(async (params: DocumentSymbolParams, token): Promise<DocumentSymbol[]> => {
  const doc = documents.get(params.textDocument.uri);
  if (stopping || !doc) return [];
  const text = doc.getText();
  const version = doc.version;
  const epoch = generation;
  const symbols = await requestSymbols(doc, token);
  if (stopping || token.isCancellationRequested || generation !== epoch
      || documents.get(doc.uri) !== doc || documents.get(doc.uri)?.version !== version) return [];
  const lines = text.split('\n');
  return symbols.map((s) => symbolToLsp(s, lines));
});

function symbolToLsp(sym: ForgeSymbol, lines: string[]): DocumentSymbol {
  const re = new RegExp(`\\b${sym.name}\\b`);
  const lineIdx = lines.findIndex((l) => re.test(l));
  const line = Math.max(0, lineIdx);
  const col = lineIdx >= 0 ? Math.max(0, lines[lineIdx].indexOf(sym.name)) : 0;
  const label = sym.container ? `${sym.container}.${sym.name}` : sym.name;
  return {
    name: label,
    kind: lspSymbolKind(sym.kind),
    range: { start: { line, character: col }, end: { line, character: col + sym.name.length } },
    selectionRange: { start: { line, character: col }, end: { line, character: col + sym.name.length } },
  };
}

function lspSymbolKind(kind: string): SymbolKind {
  switch (kind) {
    case 'function': return SymbolKind.Function;
    case 'process': return SymbolKind.Class;
    case 'coroutine': return SymbolKind.Method;
    case 'const': return SymbolKind.Constant;
    case 'struct': return SymbolKind.Struct;
    case 'enum': return SymbolKind.Enum;
    case 'library': return SymbolKind.Module;
    case 'supervisor': return SymbolKind.Namespace;
    case 'native': return SymbolKind.Event;
    default: return SymbolKind.Variable;
  }
}

connection.onHover((params: HoverParams): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const line = doc.getText({
    start: { line: params.position.line, character: 0 },
    end: { line: params.position.line, character: 1_000_000 },
  });
  const wordMatch = line.slice(0, params.position.character + 1).match(/[A-Za-z_][A-Za-z0-9_]*$/);
  if (!wordMatch) return null;
  const word = wordMatch[0];

  if (HOVER_DOCS[word]) {
    return { contents: markdown(HOVER_DOCS[word]) };
  }
  for (const [mod, fns] of Object.entries(STDLIB_MODULES)) {
    if (fns.includes(word)) {
      return { contents: markdown(`**${word}** — \`${mod}\` module`) };
    }
    if (word === mod) {
      return { contents: markdown(`Standard module \`${mod}\`. Import with \`import ${mod};\``) };
    }
  }
  return null;
});

function markdown(text: string): MarkupContent {
  return { kind: 'markdown', value: text };
}

async function stopCompilerWork(): Promise<void> {
  stopping = true;
  generation++;
  invalidateSymbols();
  for (const uri of diagnosticJobs.keys()) cancelDiagnostic(uri);
  await Promise.allSettled([...compilerWork]);
}
connection.onShutdown(stopCompilerWork);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => { void stopCompilerWork().finally(() => process.exit(0)); });
}
connection.listen();

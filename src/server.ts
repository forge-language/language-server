#!/usr/bin/env node
import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionParams,
  TextDocumentPositionParams,
  DocumentSymbolParams,
  HoverParams,
  DocumentSymbol,
  SymbolKind,
  Hover,
  MarkupContent,
  InitializeResult,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultForgePath,
  ForgeSettings,
  ForgeSymbol,
  runForgeCheck,
  runForgeSymbols,
} from './forge';
import { HOVER_DOCS, STDLIB_MODULES } from './constants';
import { keywordCompletions, stdlibCompletions, symbolCompletions, typeCompletions } from './completion';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

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
  settings = {
    forgePath: cfg?.path || defaultForgePath(root),
    forgeRoot: cfg?.forgeRoot || root,
    libDir: cfg?.libDir || (root ? path.join(root, 'build', 'lib') : undefined),
    includePaths: cfg?.includePaths?.length
      ? cfg.includePaths
      : root
        ? [path.join(root, 'examples')]
        : [],
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
});

function validate(textDocument: TextDocument): void {
  const text = textDocument.getText();
  const diagnostics = runForgeCheck(settings, textDocument.uri, text);
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

documents.onDidChangeContent((change) => validate(change.document));
documents.onDidClose((e) => connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] }));
documents.listen(connection);

connection.onCompletion((params: CompletionParams) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const symbols = runForgeSymbols(settings, doc.uri, doc.getText());
  return [...keywordCompletions(), ...typeCompletions(), ...stdlibCompletions(), ...symbolCompletions(symbols)];
});

connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const text = doc.getText();
  const symbols = runForgeSymbols(settings, doc.uri, text);
  return symbols.map((s) => symbolToLsp(s, text));
});

function symbolToLsp(sym: ForgeSymbol, text: string): DocumentSymbol {
  const re = new RegExp(`\\b${sym.name}\\b`);
  const lineIdx = text.split('\n').findIndex((l) => re.test(l));
  const line = Math.max(0, lineIdx);
  const col = lineIdx >= 0 ? Math.max(0, text.split('\n')[lineIdx].indexOf(sym.name)) : 0;
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

connection.listen();

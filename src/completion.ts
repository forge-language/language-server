import { CompletionItem, CompletionItemKind, InsertTextFormat } from 'vscode-languageserver';
import { HOVER_DOCS, KEYWORDS, SNIPPETS, STDLIB_MODULES, TYPES } from './constants';
import { ForgeSymbol } from './forge';

export function keywordCompletions(): CompletionItem[] {
  return KEYWORDS.map((kw) => ({
    label: kw,
    kind: CompletionItemKind.Keyword,
    detail: HOVER_DOCS[kw],
    insertText: SNIPPETS[kw] ?? kw,
    insertTextFormat: SNIPPETS[kw] ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
  }));
}

export function typeCompletions(): CompletionItem[] {
  return TYPES.map((t) => ({
    label: t,
    kind: CompletionItemKind.TypeParameter,
  }));
}

export function stdlibCompletions(): CompletionItem[] {
  const items: CompletionItem[] = [];
  for (const [mod, fns] of Object.entries(STDLIB_MODULES)) {
    items.push({
      label: mod,
      kind: CompletionItemKind.Module,
      detail: `import ${mod}`,
      insertText: `import ${mod};`,
    });
    for (const fn of fns) {
      items.push({
        label: fn,
        kind: CompletionItemKind.Function,
        detail: `${mod} module`,
      });
    }
  }
  return items;
}

export function symbolCompletions(symbols: ForgeSymbol[]): CompletionItem[] {
  return symbols.map((s) => ({
    label: s.name,
    kind: symbolKindToCompletion(s.kind),
    detail: s.container ? `${s.kind} in ${s.container}` : s.kind,
  }));
}

function symbolKindToCompletion(kind: string): CompletionItemKind {
  switch (kind) {
    case 'function': return CompletionItemKind.Function;
    case 'process': return CompletionItemKind.Class;
    case 'coroutine': return CompletionItemKind.Method;
    case 'const': return CompletionItemKind.Constant;
    case 'struct': return CompletionItemKind.Struct;
    case 'enum': return CompletionItemKind.Enum;
    case 'library': return CompletionItemKind.Module;
    default: return CompletionItemKind.Variable;
  }
}

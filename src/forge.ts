import { spawnSync, SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Diagnostic, DiagnosticSeverity, Position, Range } from 'vscode-languageserver';

export interface ForgeSettings {
  forgePath: string;
  forgeRoot?: string;
  libDir?: string;
  includePaths: string[];
}

export interface ForgeSymbol {
  kind: string;
  name: string;
  container?: string;
}

export function defaultForgePath(workspaceRoot?: string): string {
  const candidates = [
    workspaceRoot ? path.join(workspaceRoot, 'build', 'bin', 'forge') : '',
    path.join(process.cwd(), 'build', 'bin', 'forge'),
    'forge',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c !== 'forge' && fs.existsSync(c)) return c;
  }
  return 'forge';
}

function runCompiler(settings: ForgeSettings, uri: string, text: string, extra: string[]): SpawnSyncReturns<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lsp-'));
  try {
    const file = path.join(dir, 'buffer.fg');
    fs.writeFileSync(file, text, 'utf8');
    // Unsaved buffers live in /tmp; preserve imports relative to the original file.
    const localSettings = { ...settings, includePaths: [...settings.includePaths] };
    try {
      const sourceDir = path.dirname(fileURLToPath(uri));
      localSettings.includePaths.unshift(sourceDir);
    } catch { /* Non-file documents have no local module directory. */ }
    return spawnSync(settings.forgePath, forgeArgs(localSettings, file, extra), {
      encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10_000,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function forgeArgs(settings: ForgeSettings, file: string, extra: string[]): string[] {
  const args = [file, ...extra];
  if (settings.forgeRoot) args.push('--forge-root', settings.forgeRoot);
  if (settings.libDir) args.push('--lib-dir', settings.libDir);
  for (const inc of settings.includePaths) args.push('-I', inc);
  return args;
}

export function runForgeCheck(
  settings: ForgeSettings,
  uri: string,
  text: string,
): Diagnostic[] {
  const result = runCompiler(settings, uri, text, ['--check']);

  const diagnostics: Diagnostic[] = [];
  if (result.error) {
    return [{ severity: DiagnosticSeverity.Error, range: Range.create(0, 0, 0, 1),
      message: `Cannot run Forge compiler: ${result.error.message}`, source: 'forge' }];
  }
  const stderr = `${result.stderr ?? ''}${result.stdout ?? ''}`;
  for (const line of stderr.split('\n')) {
    if (!line.startsWith('forge:')) continue;
    const m = line.match(/forge: parse error at (\d+):(\d+): (.+)/);
    if (m) {
      const lineNo = Math.max(0, parseInt(m[1], 10) - 1);
      const col = Math.max(0, parseInt(m[2], 10) - 1);
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: Range.create(Position.create(lineNo, col), Position.create(lineNo, col + 1)),
        message: m[3],
        source: 'forge',
      });
      continue;
    }
    const generic = line.replace(/^forge:\s*/, '');
    if (generic && result.status !== 0) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: Range.create(0, 0, 0, 1),
        message: generic,
        source: 'forge',
      });
    }
  }
  return diagnostics;
}

export function runForgeSymbols(
  settings: ForgeSettings,
  uri: string,
  text: string,
): ForgeSymbol[] {
  const result = runCompiler(settings, uri, text, ['--symbols-json']);
  if (result.status !== 0 || !result.stdout) return scanSymbolsFromText(text);
  try {
    return JSON.parse(result.stdout) as ForgeSymbol[];
  } catch {
    return scanSymbolsFromText(text);
  }
}

export function scanSymbolsFromText(text: string): ForgeSymbol[] {
  const symbols: ForgeSymbol[] = [];
  const re = /^\s*(process|coroutine|supervisor|fn|const|struct|enum|library|native)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const kind = m[1] === 'fn' ? 'function' : m[1];
    symbols.push({ kind, name: m[2] });
  }
  return symbols;
}

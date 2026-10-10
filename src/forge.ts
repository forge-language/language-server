import { execFile } from 'node:child_process';
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

export function defaultForgePath(_workspaceRoot?: string): string {
  // Opening a project must not select its build/bin executable as a compiler.
  // A local compiler can still be selected explicitly through forge.path.
  return 'forge';
}

const compilerLimit = 4;
let runningCompilers = 0;
const compilerQueue: Array<() => void> = [];

function acquireCompiler(signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      const index = compilerQueue.indexOf(start);
      if (index >= 0) compilerQueue.splice(index, 1);
      signal?.removeEventListener('abort', cancelled);
      reject(signal?.reason ?? new Error('Compiler cancelled'));
    };
    const start = () => {
      signal?.removeEventListener('abort', cancelled);
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      runningCompilers++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        runningCompilers--;
        const next = compilerQueue.shift();
        if (next) next();
      });
    };
    if (runningCompilers < compilerLimit) start();
    else {
      compilerQueue.push(start);
      signal?.addEventListener('abort', cancelled, { once: true });
    }
  });
}

interface CompilerResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  inputFile: string;
  error?: Error;
  failureKind?: 'timeout' | 'output_limit' | 'spawn';
}

async function runCompiler(
  settings: ForgeSettings,
  uri: string,
  text: string,
  extra: string[],
  signal?: AbortSignal,
): Promise<CompilerResult> {
  signal?.throwIfAborted();
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-lsp-'));
  try {
    const file = path.join(dir, 'buffer.fg');
    await fs.promises.writeFile(file, text, 'utf8');
    signal?.throwIfAborted();
    const localSettings = { ...settings, includePaths: [...settings.includePaths] };
    try {
      localSettings.includePaths.unshift(path.dirname(fileURLToPath(uri)));
    } catch { /* Non-file documents have no local module directory. */ }

    const release = await acquireCompiler(signal);
    try {
      return await new Promise<CompilerResult>((resolve, reject) => {
        let settled = false;
        const child = execFile(settings.forgePath, forgeArgs(localSettings, file, extra), {
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          timeout: 10_000,
          killSignal: 'SIGKILL',
        }, (error, stdout, stderr) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', abort);
          if (signal?.aborted) {
            reject(signal.reason ?? new Error('Compiler cancelled'));
            return;
          }
          const status = error ? typeof error.code === 'number' ? error.code : null : 0;
          const invocationError = error && typeof error.code !== 'number' &&
            (error.killed || !error.signal) ? error : undefined;
          resolve({
            status, signal: error?.signal ?? null, stdout, stderr, inputFile: file,
            error: invocationError,
            failureKind: invocationError
              ? invocationError.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
                ? 'output_limit'
                : invocationError.killed ? 'timeout' : 'spawn'
              : undefined,
          });
        });
        // Wait for execFile's terminal callback before deleting the source.
        // Removing this listener prevents a late abort from killing a finished child.
        const abort = () => {
          if (!settled) child.kill('SIGKILL');
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    } finally {
      release();
    }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

function forgeArgs(settings: ForgeSettings, file: string, extra: string[]): string[] {
  const args = [file, ...extra];
  if (settings.forgeRoot) args.push('--forge-root', settings.forgeRoot);
  if (settings.libDir) args.push('--lib-dir', settings.libDir);
  for (const inc of settings.includePaths) args.push('-I', inc);
  return args;
}

export async function runForgeCheck(
  settings: ForgeSettings,
  uri: string,
  text: string,
  signal?: AbortSignal,
): Promise<Diagnostic[]> {
  let result: CompilerResult;
  try {
    result = await runCompiler(settings, uri, text, ['--check'], signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return [{ severity: DiagnosticSeverity.Error, range: Range.create(0, 0, 0, 1),
      message: `Cannot prepare Forge compiler check: ${error instanceof Error ? error.message : String(error)}. Check the compiler configuration and temporary directory.`,
      source: 'forge' }];
  }

  const diagnostics: Diagnostic[] = [];
  if (result.error) {
    const message = result.failureKind === 'timeout'
      ? 'Forge compiler check timed out after 10 seconds.'
      : result.failureKind === 'output_limit'
        ? 'Forge compiler output exceeded the 1 MiB diagnostic limit.'
        : `Cannot run Forge compiler: ${result.error.message}. Install Forge or set forge.path to its executable.`;
    return [{ severity: DiagnosticSeverity.Error, range: Range.create(0, 0, 0, 1), message, source: 'forge' }];
  }
  const stderr = `${result.stderr ?? ''}${result.stdout ?? ''}`;
  const lines = stderr.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.startsWith('forge:')) continue;
    if (line.startsWith('forge: location: ')) continue;
    // New compilers retain the legacy error line and follow it with an exact
    // source range. Read the suffix from the right: filenames may contain ':'.
    const location = lines[index + 1]?.match(/^forge: location: (.+):(\d+):(\d+)-(\d+):(\d+)$/);
    if (location && result.status !== 0) {
      const coordinates = location.slice(2).map(Number);
      const [startLine, startCol, endLine, endCol] = coordinates;
      const valid = coordinates.every(value => Number.isSafeInteger(value) && value > 0) &&
        (endLine > startLine || (endLine === startLine && endCol >= startCol));
      if (valid) {
        const imported = location[1] !== result.inputFile;
        diagnostics.push({ severity: DiagnosticSeverity.Error,
          range: imported ? Range.create(0, 0, 0, 1) :
            Range.create(startLine - 1, startCol - 1, endLine - 1, endCol - 1),
          message: `${line.replace(/^forge:\s*/, '')}${imported ? ` (${location[1]}:${startLine}:${startCol})` : ''}`,
          source: 'forge' });
        index++;
        continue;
      }
    }
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
  if (diagnostics.length === 0 && (result.status !== 0 || result.signal)) {
    const detail = stderr.trim().slice(0, 2000);
    const failure = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
    diagnostics.push({ severity: DiagnosticSeverity.Error, range: Range.create(0, 0, 0, 1),
      message: `Forge compiler failed (${failure}). Check forge.path and the installed SDK.${detail ? ` ${detail}` : ''}`,
      source: 'forge' });
  }
  return diagnostics;
}

export async function runForgeSymbols(
  settings: ForgeSettings,
  uri: string,
  text: string,
  signal?: AbortSignal,
): Promise<ForgeSymbol[]> {
  const result = await runCompiler(settings, uri, text, ['--symbols-json'], signal);
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

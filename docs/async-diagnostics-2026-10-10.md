# Asynchronous TypeScript language-server diagnostics

The previous TypeScript implementation invoked the compiler with `spawnSync` on
content changes and symbol requests. A controlled compiler that completed after
1.2 seconds blocked the Node event loop for 1,255 ms: a scheduled 10 ms timer did
not execute during the check. This was a responsiveness problem, not a benchmark
of Forge compilation speed.

## Implemented behavior

- Diagnostics debounce edits for 150 ms. A newer document version, close,
  configuration change or watched-file change cancels obsolete checks.
- Compiler checks and symbol queries use asynchronous `execFile` with argument
  arrays, a ten-second execution timeout and one MiB output bounds per stream.
  A shared queue permits at most four compiler subprocesses at once. Cancelling
  queued work removes it before launch.
- Published diagnostics include the checked document version. Publication also
  requires the current document identity, version and configuration generation to
  match. Closing and reopening the same URI at the same version cannot revive an
  old symbol response.
  A closed document receives empty diagnostics and never receives a late result
  from its cancelled check.
- Completion and document-symbol requests share a pending compiler-symbol result
  for the same document version and configuration generation. Document edits,
  settings and watched imports invalidate the cache. Cancelled client requests
  stop waiting; a shared symbol job remains available for other clients/requests
  until invalidation, shutdown or its execution timeout.
- Cancellation kills the direct compiler child with `SIGKILL`. The wrapper waits
  for `execFile`'s terminal callback before deleting its temporary source. A
  terminal callback removes its cancellation listener, so a later abort does not
  try to kill a finished process. Shutdown and SIGTERM/SIGINT await pending
  compiler cleanup, including checks already superseded by another version. A
  stopping flag prevents late edits, settings or symbol requests from launching
  new compiler work during cleanup.
- Unsaved buffers still include their original document directory for source
  imports. Opening a project does not automatically trust its local compiler
  executable. Only the configured executable or the installed `forge` is used.

Compiler checking remains a complete-buffer operation. This change does not add
incremental parsing, semantic completion, project-wide references, rename,
formatting or source-level debugging. Compiler diagnostics without source spans
still use the first character of the document. Forced termination such as SIGKILL
of the language server cannot run asynchronous cleanup; cancellation also does
not claim process-tree isolation for an arbitrary configured compiler that forks
its own descendants.

## Verification

On 2026-10-10, `npm test` passed all 18 tests in 11.77 seconds, including
TypeScript compilation. The execution-timeout fixture accounts for ten seconds
of that runtime. Output is captured in `/tmp/forge-lsp-async-final-test.log` on
the validation host. `npm pack --dry-run --json` also confirmed this document,
README and compiled server are included in the npm package. These host logs are
not required release artifacts.

`npm test` builds TypeScript and exercises the actual stdio JSON-RPC server, not
only mocked handler functions. Controlled compiler subprocesses verify:

1. Hover responds within a 500 ms test deadline while a 1.5 second compiler check
   is pending. New version diagnostics replace obsolete work, and the old child's
   source and process are removed.
2. Closing a document and changing the compiler configuration without changing
   its document version suppress late diagnostics from the old configuration.
3. Slow symbol queries do not block hover; completion and outline coalesce work;
   client cancellation and a later document version do not return old results.
4. A late cancellation does not call `kill` after compiler completion.
5. Four compiler jobs can run concurrently; a cancelled fifth never launches,
   while an additional non-cancelled job runs once a slot becomes available.
6. Excessive compiler output and execution timeout produce explicit diagnostics.
   The timed-out child and its temporary input are removed. A temporary-directory
   preparation failure also becomes a visible diagnostic.
7. Same-version configuration changes suppress obsolete symbol responses, and
   shutdown waits for active diagnostic and symbol child cleanup.
8. Closing and reopening the same URI/version rejects old completion and outline
   responses. Notifications arriving during shutdown do not spawn new children.

A separate check against the real stage0 compiler verified errors for unknown
values, function values used as integers, missing non-void returns and a wrong
argument in a relatively imported module; a valid print program had no diagnostic.
The helper returns Promises now; both server call sites and direct tests await
them. This is an internal API change, not a new LSP wire method.

Existing tests continue to cover executable selection, compiler errors, relative
imports, temporary-file cleanup, source-scan fallback and cache invalidation.
These timing thresholds establish responsiveness of this controlled protocol
fixture. They are not user-device latency guarantees or a Rust performance
comparison.

## Native server remains serial

`native/main.fg` calls `proc_run_forge` while handling diagnostics and symbol
requests. The current `forge-stdlib/src/process.c` primitive waits synchronously
for its child. Consequently, the native server can still delay processing editor
messages while checking a buffer. The TypeScript changes above do not apply to
native `forge-lsp`.

Native parity needs OS-only asynchronous process primitives (start, readiness,
status/output collection and cancellation), then a Forge-language event loop that
interleaves stdio messages with those completions. Document version/generation
state, debounce decisions and LSP publication must remain in `.fg` code. Shared
protocol fixtures should then verify cancellation, version ordering, close,
settings, timeout and source cleanup for both servers. Moving hidden LSP routing
into a C bridge would not be that implementation.

## Source locations and compiler failures

Compilers that append `forge: location: <file>:<line>:<column>-<end-line>:<end-column>` to a legacy error now supply the editor range without a duplicate diagnostic. Coordinates use the compiler's UTF-16 contract. Imported-module failures retain their file and location in the message and use a document-level fallback range, since imported coordinates belong to another source. Older compilers retain the existing fallback. The server does not require the new compiler flag. Signal termination is reported as a compiler failure separately from a missing executable.

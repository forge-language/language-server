# Asynchronous language-server diagnostics

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

## Native Forge event loop

`native/main.fg` now polls framed input and compiler jobs in the same Forge event
loop. The C standard-library additions implement only OS process handles,
monotonic time and transport framing. Document/version/configuration state,
debounce, request cancellation, symbol caching and LSP publication remain in
Forge. No LSP handlers or document routing moved into C.

The native server bounds state at 32 documents, 32 outstanding symbol requests
and four compiler children. Edits debounce for 150 ms; checks time out after ten
seconds, and each child stream is bounded to one MiB. Each input burst handles
at most eight frames before checking child completion. Partial incoming frames
do not block completed diagnostics. Version, reopen epoch and configuration
generation guards suppress obsolete results. Completion and outline share a
pending symbol job; cancelling one request does not discard another's result.

On POSIX, each compiler runs in a separate process group. Cancellation, timeout
and shutdown kill the group, collect terminal status and drain/close output
before removing the temporary source. Natural leader exit also kills surviving
group members before reaping the reserved PID/PGID. The server cleans up on EOF,
SIGTERM and SIGINT. Descendants that deliberately leave that group and forced
SIGKILL of the server are outside this cleanup contract. This is process
lifecycle management, not a sandbox. Windows primitives return unsupported
codes; the native asynchronous server is verified on Linux, and Windows users
should use the TypeScript server.

Persistent metadata and source text use copied docstore strings. The event loop
resets temporary string arenas between ticks. Diagnostic JSON preserves escaped
Unicode, quotes, backslashes and control characters. Compiler signal failures
identify the signal; symbol output from failed/cancelled children is discarded.

### Native verification

An isolated SDK install to `/tmp/forge-resumed-sdk-20261010` was used to build an
external CMake consumer at `/tmp/forge-resumed-lsp-20261010`. All four CTest suites
passed on 2026-10-10: doctor, basic native protocol, 14 asynchronous protocol
tests and four real-compiler diagnostic tests. The asynchronous suite is now
registered in CMake, so CI runs it with the other native checks.

The protocol tests cover responsive hover, superseded diagnostics, shared symbol
work, client cancellation, same-version settings, close/reopen, partial input,
four-child capacity and queued close, output limits, timeout, late shutdown
notifications, multiple full replacements, escaped Unicode paths/source, URI
and control-character round trips, compiler signal failure, wrapper descendants,
EOF and SIGTERM cleanup. The server's successful exit is checked as well.

The real-compiler tests compare editor ranges to the installed compiler's JSON
diagnostics after Korean text and a supplementary Unicode character, and for a
parse error on a later line. An imported module in a directory containing a
colon and Unicode retains its filename in the message and a document-level
fallback range. Valid code has empty diagnostics. Each error produces a single
diagnostic.

The compiler/runtime build passed all 21 CTest suites and the stage2/stage3
self-hosting fixed point. A separate ASan/UBSan standard-library/runtime build
passed ten suites. Native Forge code is also generated as C and linked against
those instrumented libraries for the asynchronous and real-compiler protocols.
This coverage does not establish full ownership, alias or thread safety.

### Controlled hover observation

A serial server built from language-server `2381fbe` and the new native server
were compiled with the same local Release SDK. A configured fixture compiler
slept for 1.2 seconds. After observing its startup, the client sent hover and
timed the response. Five samples per implementation were interleaved in a seeded
random order, with no build or benchmark running alongside them. Median hover
latency was 1,202.36 ms for serial dispatch and 0.410 ms for the Forge event loop.
The [raw samples and binary hashes](native-hover-latency-2026-10-10.json) preserve
all observations. This measures responsiveness while a controlled check is
pending; it does not measure compilation speed, language throughput or Rust
performance, and five samples on a shared host are not a latency guarantee.
Hover and outline still use source scanning rather than a semantic index; their
legacy scanner is byte-oriented. Exact UTF-16 ranges above apply to compiler
diagnostics, not every navigation feature.

To reproduce after building the serial and current native binaries with the same
SDK:

```sh
python3 scripts/measure-native-hover.py --baseline /path/to/serial-forge-lsp \
  --server /path/to/current-forge-lsp --samples 5 --seed 20261010 \
  --output /tmp/native-hover.json
```

## Source locations and compiler failures

Compilers that append `forge: location: <file>:<line>:<column>-<end-line>:<end-column>` to a legacy error now supply the editor range without a duplicate diagnostic. Coordinates use the compiler's UTF-16 contract. Imported-module failures retain their file and location in the message and use a document-level fallback range, since imported coordinates belong to another source. Older compilers retain the existing fallback. The server does not require the new compiler flag. Signal termination is reported as a compiler failure separately from a missing executable.

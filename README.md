# Forge Language Server

Language Server Protocol servers for [Forge](https://github.com/forge-language/forge), maintained independently of the compiler and editor clients.

## Native server

`native/main.fg` builds to `forge-lsp`, a native executable communicating over stdio. Install the Forge SDK first; it includes the compiler, runtime, standard library, headers and CMake package.

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH=/path/to/forge-install
cmake --build build -j2
ctest --test-dir build --output-on-failure
cmake --install build --prefix "$HOME/.local"
```

For a sibling compiler checkout, configure Forge with an install prefix, build and install it, then use that prefix above. This repository does not include compiler or runtime sources.

## TypeScript server

The Node.js implementation remains available for clients using `forge-language-server`.

```bash
npm ci
npm test
node out/server.js --stdio
```

Requires Node.js 18+ and a Forge compiler on `PATH`. `npm start -- --stdio` also starts the server. Diagnostics report compiler launch failures. Temporary buffers are removed after every compiler invocation; imports include the original file's directory. Completion and outline requests share symbols cached by document version.

## Editor configuration

Both servers support diagnostics (`forge --check`), completion, hover and document symbols (`forge --symbols-json`). Native initialization options use the same `forge` settings object shown below. The TypeScript server also accepts configuration updates.

```json
{
  "forge": {
    "path": "/path/to/forge-install/bin/forge",
    "includePaths": ["/path/to/project/modules"]
  }
}
```

`forge.forgeRoot` and `forge.libDir` are optional toolchain overrides; the compiler normally resolves its installed SDK. Project workspaces no longer assume the compiler's `build/lib` or `examples` layout. Set `forge.lspPath` in your editor to the installed `forge-lsp` binary. See [vscode-extension](https://github.com/forge-language/vscode-extension) and [editor plugins](https://github.com/forge-language/editor-plugins) for clients.

## Claude Code integration

`scripts/install-claude-lsp.sh` optionally patches an existing oh-my-claudecode installation to recognize `.fg` and run `forge-lsp`. It is separate from building and installing this server; install `forge-lsp` on `PATH` before running it. The patcher checks upstream anchors and skips unfamiliar versions.

## Layout

- `native/`: Forge server source.
- `src/`: TypeScript server, compiler adapter and completion data.
- `tests/`: native stdio protocol and TypeScript compiler adapter regressions.
- `scripts/`: optional Claude Code integration.

Licensed under [Apache License 2.0](LICENSE).

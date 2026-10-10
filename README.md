# Forge Language Server

Diagnostics, completion, hover and document symbols for [Forge](https://github.com/forge-language/forge). The compiler, language server and editor client are installed separately. Neither server downloads tools or runs package installation/build scripts.

To learn before installing, start with the [Forge website and browser playground](https://forge-lang.org/playground) or [compiler examples](https://github.com/forge-language/forge/tree/main/examples). Checking a file in an editor requires a working local Forge compiler.

## First use

1. Install a Forge compiler and its matching runtime/standard-library SDK. Verify `forge --help` in a terminal. Follow the [compiler build and installation instructions](https://github.com/forge-language/forge#build-and-install) for source installations and supported platforms.
2. Install one server below: native `forge-lsp`, or the Node.js TypeScript fallback.
3. Run the diagnostic command before configuring an editor:

   ```sh
   python3 scripts/doctor.py --compiler /absolute/path/to/bin/forge --server /absolute/path/to/bin/forge-lsp
   ```

4. Install your editor client and set its server command and compiler path. Desktop editors may have a different `PATH` than the terminal; absolute paths avoid that problem.
5. Open a `.fg` file. Hover, completion and diagnostics require the server to attach; syntax highlighting alone does not confirm that it started.

The doctor command needs Python 3.8+. It checks executable discovery, compiles and runs a fixed temporary program importing `strings` and calling `str_len`, and exchanges LSP initialize/shutdown messages over stdio. It uses the installed compiler and host C compiler to link a temporary executable, verifies its output, then deletes it. It does not load project configuration or download dependencies. A failed check exits with status 1; `--json` produces a machine-readable report. It confirms startup, not every editor feature or package's behavior.

## Install from a release

[GitHub Releases](https://github.com/forge-language/language-server/releases) provide a native Linux x86-64 archive and a separately built TypeScript npm archive. Select a release matching your platform; these contain the server, not the Forge compiler/SDK. Download `SHA256SUMS` and the selected archive to the same directory, then verify that archive before extracting or installing it:

```sh
# Native Linux server
sha256sum --check --ignore-missing SHA256SUMS
tar -xzf forge-lsp-linux-x86_64.tar.gz
mkdir -p "$HOME/.local/bin"
cp forge-lsp/bin/forge-lsp "$HOME/.local/bin/forge-lsp"
chmod +x "$HOME/.local/bin/forge-lsp"
export PATH="$HOME/.local/bin:$PATH"
python3 forge-lsp/scripts/doctor.py --compiler /absolute/path/to/bin/forge --server "$HOME/.local/bin/forge-lsp"
```

Check that verification lists the archive you downloaded with `OK`; missing checksum entries or an unsuccessful check are not verification. The exported PATH applies to this shell; desktop editors can use the absolute executable path instead.

For the TypeScript release, install Node.js 22, download `forge-language-server-0.2.0.tgz` and `SHA256SUMS`, verify the checksum, then install to a user-owned prefix:

```sh
sha256sum --check --ignore-missing SHA256SUMS
npm install --prefix "$HOME/.local/share/forge-language-server" --ignore-scripts ./forge-language-server-0.2.0.tgz
"$HOME/.local/share/forge-language-server/node_modules/.bin/forge-language-server" --stdio
```

The last command waits for a client. Use its absolute path as the editor's stdio command. The installed Node entry module is `$HOME/.local/share/forge-language-server/node_modules/@forge/language-server/out/server.js`, and its diagnostic script is `scripts/doctor.py` in that package directory. npm installs the server's declared runtime dependencies; this is a manual installation step. Do not run `npm install` in a project merely to configure the editor.

```sh
python3 "$HOME/.local/share/forge-language-server/node_modules/@forge/language-server/scripts/doctor.py" \
  --compiler /absolute/path/to/bin/forge --server node \
  --server-arg "$HOME/.local/share/forge-language-server/node_modules/@forge/language-server/out/server.js" --server-arg=--stdio
```

The source builds below remain available for other platforms and development.

## Native server

`native/main.fg` builds to `forge-lsp`, communicating over stdio. The asynchronous native transport and compiler process API require POSIX; this change is verified on Linux. Use the TypeScript server on Windows. Building requires the compiler's complete CMake SDK: `bin/forge`, headers, runtime/stdlib libraries and `lib/cmake/Forge/ForgeConfig.cmake`. A standalone compiler executable or an SDK download without the CMake package cannot satisfy this build dependency. Use a Forge source build/install when that package is absent. Older SDKs without `proc_start_forge`, `lsp_poll` and `time_monotonic_ms` cannot build this native source.

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH=/absolute/path/to/forge-install
cmake --build build -j2
ctest --test-dir build --output-on-failure
cmake --install build --prefix "$HOME/.local"
python3 scripts/doctor.py --compiler /absolute/path/to/forge-install/bin/forge --server "$HOME/.local/bin/forge-lsp"
```

CMake installs `forge-lsp` and `forge-lsp-doctor` into the prefix's `bin` directory. Add it to `PATH`, or use explicit paths. The installed doctor accepts the same options as `scripts/doctor.py`.

For a sibling compiler checkout, build and install Forge first, then pass its install prefix to `CMAKE_PREFIX_PATH`. This repository does not include compiler/runtime sources and does not depend on a particular sibling-directory layout.

## TypeScript server

Requires Node.js 18+ and an installed Forge compiler. Build once:

```sh
npm ci
npm test
node out/server.js --stdio
```

The last command is an editor transport process; it waits for LSP messages and is not an interactive shell. To test it from a terminal, use the doctor instead:

```sh
python3 scripts/doctor.py --compiler /absolute/path/to/bin/forge \
  --server node --server-arg "$PWD/out/server.js" --server-arg=--stdio
```

A generic stdio client launches `node /absolute/path/to/out/server.js --stdio`. VS Code/Cursor's Forge extension uses its own IPC transport. `npm start -- --stdio` is another stdio launch option. Compiler failures appear as diagnostics, including loader errors, timeouts and failures without Forge-formatted output. Temporary buffers are removed after compiler calls; imports include the original file's directory. Completion and outline share symbols cached by document version.

The default compiler is `forge` on the editor process's `PATH`. Project `build/bin/forge` files are not selected automatically. Choose a custom compiler explicitly through `forge.path`.

## Editor clients

| Editor | Client and setup |
| --- | --- |
| VS Code / Cursor | [Forge extension](https://github.com/forge-language/vscode-extension). Native: `forge.serverMode: "native"`, `forge.lspPath` for the server, `forge.path` for the compiler. TypeScript: `forge.serverMode: "typescript"`, `forge.serverModule` pointing to `out/server.js`. Use **Forge: Set Up Language Server** and **Forge: Show Language Server Output**. Workspace trust is required to start tools. |
| Sublime Text 4 | Install separate [Forge syntax](https://github.com/forge-language/sublime-syntax), LSP and [LSP-Forge](https://github.com/forge-language/sublime-text). **Preferences: LSP-Forge Settings** edits `command`; the modern client/session name is `LSP-Forge`. Set compiler options in `initialization_options.forge`, and matching `settings.forge` when using TypeScript. |
| Neovim 0.10+ | [editor-configs/nvim](https://github.com/forge-language/editor-configs/tree/main/nvim). Set `vim.g.forge_lsp_path` for a server outside `PATH`; use `:checkhealth vim.lsp` to confirm attachment. |
| Vim 8/9 | [editor-configs/vim](https://github.com/forge-language/editor-configs/tree/main/vim), plus `vim-lsp`. Set `g:forge_lsp_path` if needed; inspect `:LspStatus`. |
| Other LSP editors | Configure a stdio command `["/absolute/path/to/forge-lsp"]` and language ID `forge` for `.fg` files. Send the initialization options below. Syntax/filetype registration is editor-specific. |

Both servers accept this initialization-options object:

```json
{
  "forge": {
    "path": "/absolute/path/to/forge-install/bin/forge",
    "includePaths": ["/absolute/path/to/project/modules"]
  }
}
```

`forgeRoot` and `libDir` are optional keys inside `forge` for custom SDK layouts. Installed compilers normally locate their own SDK. Both servers accept `workspace/didChangeConfiguration` with `settings.forge`; settings changes cancel obsolete checks and invalidate symbols. Supply the complete compiler settings on updates so omitted overrides do not reset to defaults.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `Executable not found` | Install that tool manually, add its `bin` directory to the editor's PATH, or set its absolute path. `forge` and `forge-lsp` are different executables. |
| CMake cannot find `ForgeConfig.cmake` | Use the compiler's complete source-built/installed SDK and set `CMAKE_PREFIX_PATH` to its prefix. |
| Compiler/native smoke check fails | Verify the matching SDK and a host C compiler are installed. Check explicit SDK overrides; unset stale `forgeRoot`/`libDir` values when using a normal installation. |
| `Server did not answer initialize` / invalid protocol | Choose the server executable, not the compiler. TypeScript needs built `out/server.js`, Node.js and `--stdio` for a stdio client. Logs must go to stderr. |
| Terminal doctor passes, editor fails | Set absolute server/compiler paths in the editor, restart its session, and inspect its LSP log. |
| Syntax highlighting works but there are no diagnostics | Install/enable the separate LSP client and verify attachment. The syntax package alone does not launch a language server. |
| Compiler options changed | Send `workspace/didChangeConfiguration` with the complete `settings.forge` object, or restart the session. |

For custom layouts, the doctor accepts `--forge-root PATH`, `--lib-dir PATH` and repeated `--include PATH`. `--timeout SECONDS` bounds each compiler/run or protocol operation (default 10, maximum 60). It checks only the executable paths you specify or find through PATH.

## Optional Claude Code integration

`scripts/install-claude-lsp.sh` modifies an existing oh-my-claudecode installation to recognize `.fg` and run `forge-lsp`. It does not install the compiler or server. Install and diagnose `forge-lsp` first; read the script before running it. The patcher checks upstream anchors and skips unfamiliar versions. This integration is separate from native builds and editor-client installation.

## 한국어 빠른 시작

Forge 컴파일러/SDK, 언어 서버, 에디터 클라이언트는 각각 설치합니다. 먼저 `python3 scripts/doctor.py --compiler /컴파일러/절대경로 --server /언어서버/절대경로`를 실행하세요. 고정된 임시 소스를 컴파일·링크·실행하고 LSP 초기화·종료를 확인하며 자동 다운로드나 프로젝트 설정 실행은 하지 않습니다.

데스크톱 에디터의 PATH가 터미널과 다르면 절대 경로를 지정하세요. Sublime에서는 별도 Forge 문법 패키지와 LSP, LSP-Forge가 필요합니다. 문법 강조만 작동하는 상태에서는 언어 서버 연결 여부를 따로 확인해야 합니다. 두 서버 모두 설정 변경 알림을 지원합니다. 네이티브 비동기 서버는 Linux에서 검증했으며 Windows에서는 TypeScript 서버를 사용하세요.

## Layout and license

- `native/`: native Forge server.
- `src/`: TypeScript server, compiler adapter and completion data.
- `tests/`: native/TypeScript protocol and diagnostic regressions, doctor checks.
- `scripts/`: doctor and optional Claude Code integration.

[Apache License 2.0](LICENSE).

## Asynchronous diagnostics

Both servers check buffers asynchronously with a 150 ms edit debounce,
a four-process compiler limit, cancellation and versioned diagnostics. Slow checks
and symbol queries leave hover and other protocol messages responsive. Pending
completion and outline requests share a versioned symbol cache. Configuration and
import changes invalidate pending results; shutdown waits for temporary-source
cleanup. Compiler checks still process entire buffers and retain a ten-second
execution timeout.

The native event loop is written in Forge; C supplies process and stdio framing
primitives. It tracks at most 32 open documents, 32 pending symbol requests and
four compiler jobs. POSIX child process groups are cancelled and reaped before
their temporary sources are removed. See the
[implementation and protocol verification report](docs/async-diagnostics-2026-10-10.md)
for the exact behavior, tests and remaining limitations.

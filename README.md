# Forge Language Server

[LSP](https://microsoft.github.io/language-server-protocol/) server for the [Forge](https://github.com/forge-language/forge) programming language.

## Features

- Diagnostics via `forge --check`
- Completion (keywords, types, stdlib, snippets, symbols)
- Hover documentation
- Document symbols (outline)

## Requirements

- Node.js 18+
- [Forge compiler](https://github.com/forge-language/forge) built and available on `PATH` or configured via editor settings

## Install

```bash
npm install
npm run build
```

## Run

```bash
npm start
```

Communicates over stdio (default LSP transport).

## Editor integration

Use with [vscode-extension](https://github.com/forge-language/vscode-extension) for VS Code and Cursor.

## Configuration

The server reads these settings from the editor client:

| Setting | Description |
|---------|-------------|
| `forge.path` | Path to `forge` binary |
| `forge.forgeRoot` | Project root (`--forge-root`) |
| `forge.libDir` | Library directory (`--lib-dir`) |
| `forge.includePaths` | Extra `-I` module search paths |

## License

MIT

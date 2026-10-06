#!/usr/bin/env python3
"""Patches one oh-my-claudecode plugin install so its LSP tool knows about
Forge (.fg) files. Invoked by install-claude-lsp.sh; each patch is guarded by
a marker check so re-running against an already-patched or a freshly-updated
(unpatched) plugin tree is always safe.
"""
import sys
from pathlib import Path


def patch_servers(text, ts):
    if "FORGE_FALLBACK_SERVER" in text:
        return None

    if ts:
        lsp_servers_anchor = (
            "export const LSP_SERVERS: Record<string, LspServerConfig> = {\n"
            "  typescript: TYPESCRIPT_CLASSIC_SERVER,"
        )
        block = """const FORGE_EXTENSIONS = ['.fg'];

const FORGE_FALLBACK_SERVER: LspServerConfig = {
  name: 'Forge Language Server',
  command: 'forge-lsp',
  args: [],
  extensions: FORGE_EXTENSIONS,
  installHint: 'cmake --build build --target forge-lsp (from the language-server repo root)'
};

function findForgeLspBinary(workspaceRoot: string): string | null {
  let dir = resolve(workspaceRoot);

  while (true) {
    const candidate = join(dir, 'build', 'bin', 'forge-lsp');
    if (existsSync(candidate)) {
      return candidate;
    }

    const parsed = parse(dir);
    if (parsed.root === dir) {
      return null;
    }

    dir = dirname(dir);
  }
}

export function getForgeServerForWorkspace(workspaceRoot: string): LspServerConfig {
  const binary = findForgeLspBinary(workspaceRoot);
  if (!binary) {
    return FORGE_FALLBACK_SERVER;
  }

  return {
    name: 'Forge Language Server',
    command: binary,
    args: [],
    extensions: FORGE_EXTENSIONS,
    installHint: FORGE_FALLBACK_SERVER.installHint
  };
}

export const LSP_SERVERS: Record<string, LspServerConfig> = {
  typescript: TYPESCRIPT_CLASSIC_SERVER,
  forge: FORGE_FALLBACK_SERVER,"""
        dispatch_anchor = (
            "  if (TYPESCRIPT_EXTENSIONS.includes(ext) && workspaceRoot) {\n"
            "    return getTypeScriptServerForWorkspace(workspaceRoot);\n"
            "  }\n\n"
            "  for (const [_, config] of Object.entries(LSP_SERVERS)) {"
        )
        dispatch_block = (
            "  if (TYPESCRIPT_EXTENSIONS.includes(ext) && workspaceRoot) {\n"
            "    return getTypeScriptServerForWorkspace(workspaceRoot);\n"
            "  }\n\n"
            "  if (FORGE_EXTENSIONS.includes(ext) && workspaceRoot) {\n"
            "    return getForgeServerForWorkspace(workspaceRoot);\n"
            "  }\n\n"
            "  for (const [_, config] of Object.entries(LSP_SERVERS)) {"
        )
        langmap_anchor = "    'v': 'verilog'\n  };"
        langmap_block = "    'v': 'verilog',\n    'forge': 'forge',\n    'fg': 'forge'\n  };"
    else:
        lsp_servers_anchor = (
            "export const LSP_SERVERS = {\n"
            "    typescript: TYPESCRIPT_CLASSIC_SERVER,"
        )
        block = """const FORGE_EXTENSIONS = ['.fg'];
const FORGE_FALLBACK_SERVER = {
    name: 'Forge Language Server',
    command: 'forge-lsp',
    args: [],
    extensions: FORGE_EXTENSIONS,
    installHint: 'cmake --build build --target forge-lsp (from the language-server repo root)'
};
function findForgeLspBinary(workspaceRoot) {
    let dir = resolve(workspaceRoot);
    while (true) {
        const candidate = join(dir, 'build', 'bin', 'forge-lsp');
        if (existsSync(candidate)) {
            return candidate;
        }
        const parsed = parse(dir);
        if (parsed.root === dir) {
            return null;
        }
        dir = dirname(dir);
    }
}
export function getForgeServerForWorkspace(workspaceRoot) {
    const binary = findForgeLspBinary(workspaceRoot);
    if (!binary) {
        return FORGE_FALLBACK_SERVER;
    }
    return {
        name: 'Forge Language Server',
        command: binary,
        args: [],
        extensions: FORGE_EXTENSIONS,
        installHint: FORGE_FALLBACK_SERVER.installHint
    };
}
export const LSP_SERVERS = {
    typescript: TYPESCRIPT_CLASSIC_SERVER,
    forge: FORGE_FALLBACK_SERVER,"""
        dispatch_anchor = (
            "    if (TYPESCRIPT_EXTENSIONS.includes(ext) && workspaceRoot) {\n"
            "        return getTypeScriptServerForWorkspace(workspaceRoot);\n"
            "    }\n"
            "    for (const [_, config] of Object.entries(LSP_SERVERS)) {"
        )
        dispatch_block = (
            "    if (TYPESCRIPT_EXTENSIONS.includes(ext) && workspaceRoot) {\n"
            "        return getTypeScriptServerForWorkspace(workspaceRoot);\n"
            "    }\n"
            "    if (FORGE_EXTENSIONS.includes(ext) && workspaceRoot) {\n"
            "        return getForgeServerForWorkspace(workspaceRoot);\n"
            "    }\n"
            "    for (const [_, config] of Object.entries(LSP_SERVERS)) {"
        )
        langmap_anchor = "        'v': 'verilog'\n    };"
        langmap_block = (
            "        'v': 'verilog',\n"
            "        'forge': 'forge',\n"
            "        'fg': 'forge'\n"
            "    };"
        )

    if lsp_servers_anchor not in text or dispatch_anchor not in text or langmap_anchor not in text:
        return None  # upstream shape changed too much to patch safely

    text = text.replace(lsp_servers_anchor, block, 1)
    text = text.replace(dispatch_anchor, dispatch_block, 1)
    text = text.replace(langmap_anchor, langmap_block, 1)
    return text


def patch_client(text, ts):
    if "'fg': 'forge'" in text:
        return None

    if ts:
        anchor = "      'eex': 'elixir',\n      'cs': 'csharp'\n    };"
        block = "      'eex': 'elixir',\n      'cs': 'csharp',\n      'fg': 'forge'\n    };"
    else:
        anchor = "            'eex': 'elixir',\n            'cs': 'csharp'\n        };"
        block = "            'eex': 'elixir',\n            'cs': 'csharp',\n            'fg': 'forge'\n        };"

    if anchor not in text:
        return None
    return text.replace(anchor, block, 1)


def apply(path, patch_fn, ts):
    if not path.exists():
        return
    text = path.read_text()
    patched = patch_fn(text, ts)
    if patched is None:
        print("  skip (already patched or shape changed): {}".format(path))
        return
    path.write_text(patched)
    print("  patched: {}".format(path))


def main():
    if len(sys.argv) != 2:
        print("usage: patch_forge_lsp.py <plugin_root>", file=sys.stderr)
        return 1

    plugin_root = Path(sys.argv[1])
    apply(plugin_root / "src/tools/lsp/servers.ts", patch_servers, True)
    apply(plugin_root / "dist/tools/lsp/servers.js", patch_servers, False)
    apply(plugin_root / "src/tools/lsp/client.ts", patch_client, True)
    apply(plugin_root / "dist/tools/lsp/client.js", patch_client, False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

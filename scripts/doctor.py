#!/usr/bin/env python3
"""Check a manually installed Forge toolchain and LSP without loading project files."""
import argparse
import json
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import time


def executable(value):
    resolved = shutil.which(value)
    if not resolved:
        raise ValueError(f"Executable not found: {value}. Install it, add its bin directory to PATH, or provide an explicit path.")
    return str(Path(resolved).absolute())


def compiler_check(command, root, lib, includes, timeout):
    with tempfile.TemporaryDirectory(prefix="forge-doctor-") as directory:
        source = Path(directory) / "main.fg"
        source.write_text('import strings;\nnative main { println(str_len("Forge")); return 0; }\n')
        binary = Path(directory) / "doctor-app"
        args = [command, str(source), "-o", str(binary)]
        if root:
            args += ["--forge-root", root]
        if lib:
            args += ["--lib-dir", lib]
        for include in includes:
            args += ["-I", include]
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            detail = (result.stderr + result.stdout).strip()[:2000]
            raise ValueError(f"Compiler check failed (exit {result.returncode}): {detail or 'no output'}. Check forge.path, SDK installation and optional --forge-root/--lib-dir.")
        if not binary.is_file():
            raise ValueError("Compiler reported success but produced no executable. Select the Forge compiler and check its native output support.")
        run = subprocess.run([str(binary)], capture_output=True, text=True, timeout=timeout)
        if run.returncode or run.stdout.strip() != "5":
            detail = (run.stderr + run.stdout).strip()[:2000]
            raise ValueError(f"Native smoke program did not return expected output 5: {detail or 'no output'}. Check the compiler/runtime SDK versions.")
    return "Native compile/link/run passed for a scratch strings import and str_len call; no project build scripts were executed."


def read_messages(stream, responses):
    try:
        while True:
            size = None
            header_bytes = 0
            while True:
                line = stream.readline(16385)
                header_bytes += len(line)
                if not line:
                    raise ValueError("Server closed stdout before responding.")
                if header_bytes > 16384:
                    raise ValueError("Invalid LSP header; the command may be printing logs to stdout.")
                if line in (b"\r\n", b"\n"):
                    break
                if line.lower().startswith(b"content-length:"):
                    if size is not None:
                        raise ValueError("Duplicate LSP Content-Length header.")
                    size = int(line.split(b":", 1)[1])
            if size is None or not 0 < size <= 1024 * 1024:
                raise ValueError("Missing or oversized LSP Content-Length header.")
            body = stream.read(size)
            if len(body) != size:
                raise ValueError("Server returned an incomplete LSP response.")
            responses.put(json.loads(body))
    except Exception as error:
        responses.put(error)


def server_check(command, compiler, root, lib, includes, timeout):
    with tempfile.TemporaryDirectory(prefix="forge-doctor-lsp-") as directory, tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors)
        responses = queue.Queue()
        reader = threading.Thread(target=read_messages, args=(process.stdout, responses), daemon=True)
        reader.start()

        def send(message):
            body = json.dumps(message).encode()
            process.stdin.write(b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
            process.stdin.flush()

        def request(identifier, method, params):
            send({"jsonrpc": "2.0", "id": identifier, "method": method, "params": params})
            deadline = time.monotonic() + timeout
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError(f"Server did not answer {method}. Check its command and stdio transport.")
                try:
                    response = responses.get(timeout=remaining)
                except queue.Empty:
                    raise ValueError(f"Server did not answer {method}. Check its command and stdio transport.")
                if isinstance(response, Exception):
                    raise ValueError(str(response))
                if not isinstance(response, dict):
                    raise ValueError("Server returned a non-object LSP response.")
                if response.get("id") == identifier:
                    if "error" in response or "result" not in response:
                        raise ValueError(f"Server rejected {method}: {str(response.get('error', 'missing result'))[:500]}")
                    return response["result"]

        try:
            config = {"path": compiler, "includePaths": includes}
            if root:
                config["forgeRoot"] = root
            if lib:
                config["libDir"] = lib
            result = request(1, "initialize", {"rootUri": Path(directory).as_uri(), "capabilities": {},
                                              "initializationOptions": {"forge": config}})
            if not isinstance(result, dict) or not isinstance(result.get("capabilities"), dict):
                raise ValueError("Initialize response has no server capabilities; this is not a compatible LSP command.")
            send({"jsonrpc": "2.0", "method": "initialized", "params": {}})
            request(2, "shutdown", None)
            send({"jsonrpc": "2.0", "method": "exit"})
            process.stdin.close()
            status = process.wait(timeout=timeout)
            if status:
                raise ValueError(f"Server exited with status {status} after shutdown.")
            return "LSP initialize/capabilities/shutdown passed over stdio."
        except Exception as error:
            errors.seek(0)
            detail = errors.read(2000).decode("utf-8", errors="replace").strip()
            raise ValueError(f"{error}" + (f" Server stderr: {detail}" if detail else ""))
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stdout.close()
            if not process.stdin.closed:
                process.stdin.close()
            reader.join(timeout=1)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compiler", default="forge", help="Forge executable, normally the installed bin/forge")
    parser.add_argument("--server", default="forge-lsp", help="Server executable; use node for the TypeScript fallback")
    parser.add_argument("--server-arg", action="append", default=[], help="Repeat for server arguments; use --server-arg=--stdio for flags")
    parser.add_argument("--forge-root", default="")
    parser.add_argument("--lib-dir", default="")
    parser.add_argument("--include", action="append", default=[])
    parser.add_argument("--timeout", type=float, default=10, help="Timeout per compiler/run or protocol operation (0.1 to 60)")
    parser.add_argument("--json", action="store_true", help="Emit a machine-readable report")
    args = parser.parse_args(argv)
    if not 0.1 <= args.timeout <= 60:
        parser.error("--timeout must be between 0.1 and 60 seconds")
    checks = []
    compiler = args.compiler
    for name, operation in (("compiler", lambda: compiler_check(executable(compiler), args.forge_root, args.lib_dir, args.include, args.timeout)),
                            ("server", lambda: server_check([executable(args.server)] + args.server_arg, compiler, args.forge_root, args.lib_dir, args.include, args.timeout))):
        try:
            message = operation()
            checks.append({"check": name, "ok": True, "message": message})
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            checks.append({"check": name, "ok": False, "message": str(error)})
    report = {"ok": all(item["ok"] for item in checks), "checks": checks}
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        for item in checks:
            print(("PASS" if item["ok"] else "FAIL") + " " + item["check"] + ": " + item["message"])
        if not report["ok"]:
            print("Next: install Forge and forge-lsp manually, then set your editor's compiler/server paths and rerun this command.")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

"""Test the installed-SDK native server's stdio protocol without an editor."""
import json
import subprocess
import sys

messages = [
    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"rootUri": None, "capabilities": {}}},
    {"jsonrpc": "2.0", "id": 2, "method": "textDocument/completion", "params": {"textDocument": {"uri": "file:///tmp/test.fg"}, "position": {"line": 0, "character": 0}}},
    {"jsonrpc": "2.0", "id": 3, "method": "shutdown", "params": None},
    {"jsonrpc": "2.0", "method": "exit"},
]
payload = b""
for message in messages:
    body = json.dumps(message).encode()
    payload += b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
result = subprocess.run([sys.argv[1]], input=payload, capture_output=True, timeout=10)
assert result.returncode == 0, result.stderr.decode()
output = result.stdout
responses = []
while output:
    header, output = output.split(b"\r\n\r\n", 1)
    length = int(header.split(b":", 1)[1])
    responses.append(json.loads(output[:length]))
    output = output[length:]
assert [response["id"] for response in responses] == [1, 2, 3]
assert "capabilities" in responses[0]["result"]
assert "str_builder" in [entry["label"] for entry in responses[1]["result"]]
print("native LSP initialize/completion/shutdown passed")

# A missing compiler or nonstandard loader error must not look like valid code.
import tempfile
from pathlib import Path
with tempfile.TemporaryDirectory(prefix="native-lsp-failure-") as directory:
    compiler = Path(directory) / "compiler"
    compiler.write_text("#!/bin/sh\necho 'runtime library missing' >&2\nexit 17\n")
    compiler.chmod(0o755)
    for selected in (str(compiler), str(Path(directory) / "missing")):
        # Native checks are asynchronous: wait for this check before shutdown.
        # Sending shutdown immediately would correctly cancel pending diagnostics.
        from native_async_protocol_test import NativeClient
        client = NativeClient(sys.argv[1])
        try:
            client.initialize(selected)
            client.open("native main { return 0; }")
            response = client.wait(lambda m: m.get("method") == "textDocument/publishDiagnostics")
            diagnostics = response["params"]["diagnostics"]
            assert diagnostics, "Compiler failure was reported as valid code"
            assert "forge.path" in diagnostics[0]["message"] or "runtime library missing" in diagnostics[0]["message"]
        finally:
            client.close()
print("native compiler startup failures remain visible")

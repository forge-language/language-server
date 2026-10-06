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

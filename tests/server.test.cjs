const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('completion and outline share compiler symbols until a document changes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cache-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const compiler = path.join(dir, 'compiler');
  const log = path.join(dir, 'calls');
  fs.writeFileSync(compiler, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},process.argv.includes('--symbols-json')?'symbols\\n':'check\\n');\nif(process.argv.includes('--symbols-json'))process.stdout.write('[{"kind":"function","name":"hello"}]');\n`);
  fs.chmodSync(compiler, 0o755);
  const server = spawn(process.execPath, ['out/server.js', '--stdio']);
  t.after(() => server.kill());
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  server.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const split = buffer.indexOf('\r\n\r\n');
      if (split < 0) break;
      const length = Number(buffer.subarray(0, split).toString().match(/Content-Length: (\d+)/i)[1]);
      if (buffer.length < split + 4 + length) break;
      const message = JSON.parse(buffer.subarray(split + 4, split + 4 + length));
      buffer = buffer.subarray(split + 4 + length);
      if (message.id !== undefined) { pending.get(message.id)?.(message); pending.delete(message.id); }
    }
  });
  let nextId = 0;
  function send(method, params, request = true) {
    const id = request ? ++nextId : undefined;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const response = request ? new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 5000);
      pending.set(id, message => { clearTimeout(timeout); resolve(message); });
    }) : Promise.resolve();
    server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    return response;
  }
  const uri = 'file:///tmp/project/main.fg';
  await send('initialize', { capabilities: {}, initializationOptions: { forge: { path: compiler } } });
  await send('initialized', {}, false);
  await send('textDocument/didOpen', { textDocument: { uri, languageId: 'forge', version: 1, text: 'fn hello(): int { return 1; }' } }, false);
  await send('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: 0 } });
  await send('textDocument/documentSymbol', { textDocument: { uri } });
  await send('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: 0 } });
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter(x => x === 'symbols').length, 1);
  await send('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'fn hello(): int { return 2; }' }] }, false);
  await send('textDocument/documentSymbol', { textDocument: { uri } });
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter(x => x === 'symbols').length, 2);
  await send('workspace/didChangeWatchedFiles', { changes: [{ uri: 'file:///tmp/project/imported.fg', type: 2 }] }, false);
  await send('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: 0 } });
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter(x => x === 'symbols').length, 3);
  await send('workspace/didChangeConfiguration', { settings: { forge: { path: compiler } } }, false);
  await send('textDocument/documentSymbol', { textDocument: { uri } });
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter(x => x === 'symbols').length, 4);
  // Editing a separate open file can change this document's imported symbols.
  await send('textDocument/didOpen', { textDocument: { uri: 'file:///tmp/project/imported.fg', languageId: 'forge', version: 1, text: 'const imported: int = 1;' } }, false);
  await send('textDocument/documentSymbol', { textDocument: { uri } });
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter(x => x === 'symbols').length, 5);
  await send('shutdown', null);
  await send('exit', undefined, false);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runForgeCheck, runForgeSymbols, defaultForgePath } = require('../out/forge');
const settings = { forgePath: '/missing-forge-compiler', includePaths: [] };
const uri = 'file:///tmp/project/main.fg';
const source = 'fn hello(): int { return 1; }';
const temporarySources = () => fs.readdirSync(os.tmpdir()).filter(x => x.startsWith('forge-lsp-')).sort();
test('failed compiler invocation reports an error and removes temporary buffers', () => {
  const before = temporarySources();
  const diagnostics = runForgeCheck(settings, uri, source);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /Cannot run Forge compiler/);
  assert.deepEqual(temporarySources(), before);
});
test('symbols fall back to source scanning without leaking temporary buffers', () => {
  const before = temporarySources();
  assert.deepEqual(runForgeSymbols(settings, uri, source), [{ kind: 'function', name: 'hello' }]);
  assert.deepEqual(temporarySources(), before);
});
test('compiler gets the original document directory for relative imports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  try {
    const compiler = path.join(dir, 'compiler');
    fs.writeFileSync(compiler, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([{kind:"function",name:process.argv.includes("/tmp/project") ? "relative_import_ok" : "missing"}]));\n');
    fs.chmodSync(compiler, 0o755);
    assert.equal(runForgeSymbols({ ...settings, forgePath: compiler }, uri, source)[0].name, 'relative_import_ok');
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('project build executable never implicitly replaces the installed compiler', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'build', 'bin'), {recursive:true});
    fs.writeFileSync(path.join(dir, 'build', 'bin', 'forge'), 'unexpected project compiler');
    assert.equal(defaultForgePath(dir), 'forge');
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});
test('unrecognized and empty compiler failure output remain visible diagnostics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  try {
    const compiler = path.join(dir, 'compiler');
    for (const message of ['runtime library missing', '']) {
      fs.writeFileSync(compiler, '#!/usr/bin/env node\nprocess.stderr.write(' + JSON.stringify(message) + '); process.exit(17);\n');
      fs.chmodSync(compiler, 0o755);
      const diagnostics = runForgeCheck({...settings, forgePath:compiler}, uri, source);
      assert.equal(diagnostics.length, 1);
      assert.match(diagnostics[0].message, /exit code 17.*forge.path/);
      if (message) assert.ok(diagnostics[0].message.includes(message));
    }
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

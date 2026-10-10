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
test('failed compiler invocation reports an error and removes temporary buffers', async () => {
  const before = temporarySources();
  const diagnostics = await runForgeCheck(settings, uri, source);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /Cannot run Forge compiler/);
  assert.deepEqual(temporarySources(), before);
});
test('symbols fall back to source scanning without leaking temporary buffers', async () => {
  const before = temporarySources();
  assert.deepEqual(await runForgeSymbols(settings, uri, source), [{ kind: 'function', name: 'hello' }]);
  assert.deepEqual(temporarySources(), before);
});
test('compiler gets the original document directory for relative imports', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  try {
    const compiler = path.join(dir, 'compiler');
    fs.writeFileSync(compiler, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([{kind:"function",name:process.argv.includes("/tmp/project") ? "relative_import_ok" : "missing"}]));\n');
    fs.chmodSync(compiler, 0o755);
    assert.equal((await runForgeSymbols({ ...settings, forgePath: compiler }, uri, source))[0].name, 'relative_import_ok');
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('project build executable never implicitly replaces the installed compiler', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'build', 'bin'), {recursive:true});
    fs.writeFileSync(path.join(dir, 'build', 'bin', 'forge'), 'unexpected project compiler');
    assert.equal(defaultForgePath(dir), 'forge');
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});
test('unrecognized and empty compiler failure output remain visible diagnostics', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  try {
    const compiler = path.join(dir, 'compiler');
    for (const message of ['runtime library missing', '']) {
      fs.writeFileSync(compiler, '#!/usr/bin/env node\nprocess.stderr.write(' + JSON.stringify(message) + '); process.exit(17);\n');
      fs.chmodSync(compiler, 0o755);
      const diagnostics = await runForgeCheck({...settings, forgePath:compiler}, uri, source);
      assert.equal(diagnostics.length, 1);
      assert.match(diagnostics[0].message, /exit code 17.*forge.path/);
      if (message) assert.ok(diagnostics[0].message.includes(message));
    }
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('late cancellation after completion cannot kill a finished compiler', async () => {
  const childProcess = require('node:child_process');
  const original = childProcess.execFile;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  let kills = 0;
  try {
    const compiler = path.join(dir, 'compiler');
    fs.writeFileSync(compiler, '#!/usr/bin/env node\nprocess.exit(0);\n');
    fs.chmodSync(compiler, 0o755);
    childProcess.execFile = (...args) => {
      const child = original(...args), kill = child.kill.bind(child);
      child.kill = (...signals) => { kills++; return kill(...signals); };
      return child;
    };
    const controller = new AbortController();
    assert.deepEqual(await runForgeCheck({...settings, forgePath:compiler}, uri, source, controller.signal), []);
    controller.abort();
    assert.equal(kills, 0);
  } finally {
    childProcess.execFile = original;
    fs.rmSync(dir, {recursive:true, force:true});
  }
});

test('compiler concurrency is bounded and cancellation removes queued work', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  try {
    const compiler = path.join(dir, 'compiler'), log = path.join(dir, 'starts');
    fs.writeFileSync(compiler, '#!/usr/bin/env node\nrequire("node:fs").appendFileSync('+JSON.stringify(log)+',"start\\n");setTimeout(()=>process.exit(0),600);\n');
    fs.chmodSync(compiler, 0o755);
    const local = {...settings, forgePath:compiler};
    const first = Array.from({length:4},()=>runForgeCheck(local,uri,source));
    const started = Date.now();
    while (!fs.existsSync(log) || fs.readFileSync(log,'utf8').trim().split('\n').length<4) {
      if(Date.now()-started>2500)throw new Error('initial compiler workers did not start');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    const controller = new AbortController();
    const cancelled = runForgeCheck(local,uri,source,controller.signal);
    const survivor = runForgeCheck(local,uri,source);
    const rejection = assert.rejects(cancelled);
    await new Promise(resolve=>setTimeout(resolve,40));controller.abort();await rejection;
    assert.equal(fs.readFileSync(log,'utf8').trim().split('\n').length,4);
    await Promise.all(first);assert.deepEqual(await survivor,[]);
    assert.equal(fs.readFileSync(log,'utf8').trim().split('\n').length,5);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('oversized compiler output is reported rather than an empty successful check', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'forge-test-'));
  try {
    const compiler=path.join(dir,'compiler');
    fs.writeFileSync(compiler,'#!/usr/bin/env node\nprocess.stdout.write("x".repeat(1024*1024+4096));\n');
    fs.chmodSync(compiler,0o755);
    const diagnostics=await runForgeCheck({...settings,forgePath:compiler},uri,source);
    assert.equal(diagnostics.length,1);assert.match(diagnostics[0].message,/output exceeded.*1 MiB/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('compiler execution timeout kills the process and removes its input source', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'forge-test-'));
  try {
    const compiler=path.join(dir,'compiler'),record=path.join(dir,'process');
    fs.writeFileSync(compiler,'#!/usr/bin/env node\nrequire("node:fs").writeFileSync('+JSON.stringify(record)+',JSON.stringify({pid:process.pid,file:process.argv[2]}));process.on("SIGTERM",()=>{});setInterval(()=>{},1000);\n');
    fs.chmodSync(compiler,0o755);
    const diagnostics=await runForgeCheck({...settings,forgePath:compiler},uri,source);
    assert.equal(diagnostics.length,1);assert.match(diagnostics[0].message,/timed out after 10 seconds/);
    const child=JSON.parse(fs.readFileSync(record,'utf8'));
    assert.equal(fs.existsSync(child.file),false);assert.throws(()=>process.kill(child.pid,0),/ESRCH/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('temporary source preparation failure remains visible to the editor', async () => {
  const previous=process.env.TMPDIR;
  process.env.TMPDIR=path.join(os.tmpdir(),'missing-parent-'+process.pid+'-'+Date.now(),'nested');
  try {
    const diagnostics=await runForgeCheck(settings,uri,source);
    assert.equal(diagnostics.length,1);assert.match(diagnostics[0].message,/Cannot prepare.*temporary directory/);
  } finally {if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;}
});

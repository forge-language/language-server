"""Real native stdio protocol with controlled subprocesses; no C LSP routing."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest

BINARY = 'build/bin/forge-lsp'


class NativeClient:
    def __init__(self, binary=None):
        self.directory = tempfile.TemporaryDirectory(prefix='native-async-protocol-')
        self.root = Path(self.directory.name)
        self.log = self.root / 'calls'
        self.compiler = self.make_compiler('old')
        self.replacement = self.make_compiler('new')
        self.server = subprocess.Popen([binary or BINARY], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.incoming = queue.Queue()
        self.messages = []
        self.next_id = 0
        self.reader = threading.Thread(target=self.read_messages, daemon=True)
        self.reader.start()

    def make_compiler(self, tag):
        file = self.root / ('compiler-' + tag)
        file.write_text('''#!/usr/bin/env python3
import json,os,pathlib,sys,time
file=sys.argv[1];text=pathlib.Path(file).read_text();symbols='--symbols-json' in sys.argv
with open(%r,'a') as log:log.write(json.dumps({'pid':os.getpid(),'file':file,'text':text,'symbols':symbols,'tag':%r,'args':sys.argv})+'\\n')
if 'HANG' in text:time.sleep(30)
if 'SIGNAL_FAILURE' in text:os.kill(os.getpid(),9)
if 'LIMIT' in text:sys.stdout.write('x'*1100000);sys.exit(1)
if %r=='old' and ('SLOW_SYMBOLS' in text if symbols else 'SLOW_CHECK' in text):time.sleep(1.5)
if symbols:
 import re
 name=re.search(r'fn\\s+(\\w+)',text)
 print(json.dumps([{'kind':'function','name':name.group(1) if name else 'hello'}]))
else:
 print('forge: semantic: '+%r+' '+text,file=sys.stderr);sys.exit(1)
''' % (str(self.log), tag, tag, tag))
        file.chmod(0o755)
        return str(file)

    def read_messages(self):
        try:
            while True:
                line = self.server.stdout.readline()
                if not line:
                    return
                length = int(line.split(b':', 1)[1])
                self.server.stdout.readline()
                body = self.server.stdout.read(length)
                self.incoming.put(json.loads(body))
        except Exception as error:
            self.incoming.put(error)

    def frame(self, method, params=None, request_id=None):
        message = {'jsonrpc':'2.0', 'method':method, 'params':params}
        if request_id is not None:
            message['id'] = request_id
        body = json.dumps(message).encode()
        return b'Content-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body

    def send(self, method, params=None, request_id=None):
        self.server.stdin.write(self.frame(method, params, request_id))
        self.server.stdin.flush()

    def request(self, method, params=None):
        self.next_id += 1
        self.send(method, params, self.next_id)
        return self.next_id

    def wait(self, predicate, timeout=4):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for message in self.messages:
                if predicate(message):
                    return message
            try:
                message = self.incoming.get(timeout=min(.02, max(.001, deadline-time.monotonic())))
                if isinstance(message, Exception):
                    raise message
                self.messages.append(message)
            except queue.Empty:
                pass
        raise AssertionError('native protocol response timed out')

    def response(self, request_id, timeout=4):
        return self.wait(lambda m:m.get('id') == request_id, timeout)

    def records(self):
        if not self.log.exists():
            return []
        return [json.loads(row) for row in self.log.read_text().splitlines() if row]

    def wait_records(self, predicate, timeout=3):
        deadline = time.monotonic()+timeout
        while time.monotonic()<deadline:
            rows = self.records()
            if predicate(rows):
                return rows
            time.sleep(.01)
        raise AssertionError('native compiler did not start')

    def initialize(self, compiler=None):
        request = self.request('initialize', {'capabilities':{},'initializationOptions':{
            'forge':{'path':compiler or self.compiler}}})
        self.response(request)

    def open(self, text, version=1, uri='file:///tmp/native.fg'):
        self.send('textDocument/didOpen', {'textDocument':{
            'uri':uri,'languageId':'forge','version':version,'text':text}})

    def change(self, text, version=2, uri='file:///tmp/native.fg'):
        self.send('textDocument/didChange', {'textDocument':{'uri':uri,'version':version},
                                           'contentChanges':[{'text':text}]})

    def diagnostics(self, text, version, timeout=4):
        return self.wait(lambda m:m.get('method')=='textDocument/publishDiagnostics'
                         and m['params'].get('version')==version
                         and any(text in d['message'] for d in m['params']['diagnostics']),timeout)

    def close(self):
        try:
            if self.server.poll() is None:
                request = self.request('shutdown')
                self.response(request)
                self.send('exit')
                self.server.wait(timeout=4)
            if self.server.returncode != 0:
                raise AssertionError('native server failed: ' + self.server.stderr.read().decode(errors='replace'))
        finally:
            if self.server.poll() is None:
                self.server.kill();self.server.wait()
            for row in self.records():
                try:
                    command = Path('/proc/%s/cmdline' % row['pid']).read_bytes()
                    if self.directory.name.encode() in command:
                        os.kill(row['pid'], 9)
                except (OSError, ProcessLookupError):
                    pass
            self.server.stdin.close();self.server.stdout.close();self.server.stderr.close()
            self.directory.cleanup()


PARAMS = {'textDocument':{'uri':'file:///tmp/native.fg'}}


class NativeAsyncTests(unittest.TestCase):
    def setUp(self):
        self.client = NativeClient()
        self.addCleanup(self.client.close)
        self.client.initialize()

    def assert_clean(self, rows):
        for row in rows:
            self.assertFalse(Path(row['file']).exists(), row)
            with self.assertRaises(ProcessLookupError):
                os.kill(row['pid'],0)

    def test_check_responsive_and_superseded(self):
        c=self.client;c.open('SLOW_CHECK_OLD')
        old=c.wait_records(lambda rows:len(rows)==1)
        hover=c.request('textDocument/hover',{**PARAMS,'position':{'line':0,'character':2}})
        c.response(hover,.5)
        c.change('CURRENT_NEW',2);c.diagnostics('CURRENT_NEW',2)
        self.assert_clean(old)
        self.assertFalse(any(m.get('params',{}).get('version')==1 for m in c.messages))

    def test_symbols_shared_cancel_and_reopen(self):
        c=self.client;c.open('fn before(): int { return 1; } // SLOW_SYMBOLS')
        completion=c.request('textDocument/completion',{**PARAMS,'position':{'line':0,'character':0}})
        outline=c.request('textDocument/documentSymbol',PARAMS)
        c.wait_records(lambda rows:any(r['symbols'] for r in rows))
        hover=c.request('textDocument/hover',{**PARAMS,'position':{'line':0,'character':2}});c.response(hover,.5)
        c.send('$/cancelRequest',{'id':completion});self.assertEqual(c.response(completion)['result'],[])
        self.assertEqual(c.response(outline)['result'][0]['name'],'before')
        self.assertEqual(len([r for r in c.records() if r['symbols']]),1)
        c.change('fn stale(): int { return 1; } // SLOW_SYMBOLS',2)
        stale=c.request('textDocument/documentSymbol',PARAMS)
        c.wait_records(lambda rows:any(r['symbols'] and 'stale' in r['text'] for r in rows))
        c.send('textDocument/didClose',PARAMS);c.open('fn reopened(): int { return 2; }',2)
        self.assertEqual(c.response(stale)['result'],[])
        fresh=c.request('textDocument/documentSymbol',PARAMS)
        self.assertEqual(c.response(fresh)['result'][0]['name'],'reopened')

    def test_same_version_configuration(self):
        c=self.client;c.open('SLOW_CHECK_CONFIG',3)
        old=c.wait_records(lambda rows:len(rows)==1)
        c.send('workspace/didChangeConfiguration',{'settings':{'forge':{'path':c.replacement}}})
        c.diagnostics('new SLOW_CHECK_CONFIG',3);self.assert_clean(old)
        self.assertFalse(any('old SLOW_CHECK_CONFIG' in d['message'] for m in c.messages
                             for d in m.get('params',{}).get('diagnostics',[])))

    def test_fragmented_input_does_not_block_completed_check(self):
        c=self.client;c.open('SLOW_CHECK_FRAGMENT')
        c.wait_records(lambda rows:len(rows)==1)
        c.next_id+=1;request=c.next_id
        frame=c.frame('textDocument/hover',{**PARAMS,'position':{'line':0,'character':2}},request)
        split=len(frame)-8
        c.server.stdin.write(frame[:split]);c.server.stdin.flush()
        c.diagnostics('SLOW_CHECK_FRAGMENT',1)
        c.server.stdin.write(frame[split:]);c.server.stdin.flush();c.response(request,.5)

    def test_max_four_and_queued_close(self):
        c=self.client
        for i in range(8):c.open('SLOW_CHECK_%d'%i,1,'file:///tmp/%d.fg'%i)
        rows=c.wait_records(lambda rows:len(rows)==4)
        time.sleep(.1);self.assertEqual(len(c.records()),4)
        for i in range(8):c.send('textDocument/didClose',{'textDocument':{'uri':'file:///tmp/%d.fg'%i}})
        shutdown=c.request('shutdown');c.response(shutdown)
        self.assertEqual(len(c.records()),4);self.assert_clean(rows)
        c.send('exit');c.server.wait(timeout=3)

    def test_output_limit_timeout(self):
        c=self.client;c.open('LIMIT');c.diagnostics('1 MiB',1)
        c.change('HANG',2);rows=c.wait_records(lambda rows:any(r['text']=='HANG' for r in rows))
        c.diagnostics('timed out after 10 seconds',2,12)
        self.assert_clean(rows)

    def test_shutdown_late_notifications_and_cleanup(self):
        c=self.client;c.open('fn ending(): int { return 1; } // SLOW_SYMBOLS SLOW_CHECK')
        symbols=c.request('textDocument/documentSymbol',PARAMS)
        rows=c.wait_records(lambda rows:len(rows)==2)
        shutdown=c.request('shutdown');c.change('late edit',2)
        c.send('workspace/didChangeConfiguration',{'settings':{'forge':{'path':c.replacement}}})
        c.response(shutdown);self.assertEqual(c.response(symbols)['result'],[])
        time.sleep(.3);self.assertEqual(len(c.records()),2);self.assert_clean(rows)
        c.send('exit');c.server.wait(timeout=3)

    def test_multiple_full_replacements_use_last(self):
        c=self.client;c.open('fn initial(): int { return 1; }')
        c.send('textDocument/didChange', {'textDocument':{'uri':'file:///tmp/native.fg','version':2},
                                        'contentChanges':[{'text':'fn wrong(): int { return 1; }'},
                                                          {'text':'fn final(): int { return 2; }'}]})
        request=c.request('textDocument/documentSymbol',PARAMS)
        self.assertEqual(c.response(request)['result'][0]['name'],'final')
        c.diagnostics('fn final()',2)

    def test_escaped_unicode_text_uri_and_compiler_path(self):
        c=self.client
        renamed=Path(c.compiler).with_name('compiler-한글-😀')
        Path(c.compiler).rename(renamed)
        c.send('workspace/didChangeConfiguration',{'settings':{'forge':{'path':str(renamed)}}})
        text='fn unicode_value(): int { return 1; } // 한글 😀'
        uri='file:///tmp/한글😀/source.fg'
        c.open(text,1,uri)
        c.diagnostics('한글 😀',1)
        row=c.records()[0]
        self.assertEqual(row['text'],text)
        self.assertIn('/tmp/한글😀',row['args'])
        message=c.wait(lambda m:m.get('method')=='textDocument/publishDiagnostics')
        self.assertEqual(message['params']['uri'],uri)

    def test_quoted_uri_and_control_characters_roundtrip(self):
        c = self.client
        uri = 'file:///tmp/quote"and\\backslash.fg'
        text = 'SOURCE with \b backspace and \f form feed and \x01 control'
        c.open(text, 1, uri)
        message = c.diagnostics(text, 1)
        self.assertEqual(message['params']['uri'], uri)
        self.assertEqual(c.records()[0]['text'], text)
        c.send('textDocument/didClose', {'textDocument': {'uri': uri}})
        cleared = c.wait(lambda m: m.get('method') == 'textDocument/publishDiagnostics'
                         and m['params'].get('uri') == uri
                         and m['params']['diagnostics'] == [])
        self.assertEqual(cleared['params']['uri'], uri)

    def test_signal_failure_is_a_compiler_failure(self):
        c = self.client
        c.open('SIGNAL_FAILURE')
        message = c.diagnostics('terminated by signal 9', 1)
        self.assertNotIn('Check forge.path', message['params']['diagnostics'][0]['message'])
        self.assert_clean(c.records())

    def test_shell_wrapper_descendants_stop_on_shutdown(self):
        import shlex
        c=self.client
        record=c.root/'wrapper-pids';wrapper=c.root/'wrapper'
        wrapper.write_text('#!/bin/sh\n'+shlex.quote(c.compiler)+' "$@" &\necho "$$ $!" > '+shlex.quote(str(record))+'\nwait\n')
        wrapper.chmod(0o755)
        c.send('workspace/didChangeConfiguration',{'settings':{'forge':{'path':str(wrapper)}}})
        c.open('HANG');rows=c.wait_records(lambda rows:len(rows)==1)
        request=c.request('shutdown');c.response(request)
        self.assertFalse(Path(rows[0]['file']).exists())
        for pid in map(int,record.read_text().split()):
            try:
                stat=Path('/proc/%d/stat'%pid).read_text()
                self.assertEqual(stat.rsplit(')',1)[1].strip()[0],'Z')
            except FileNotFoundError:
                pass
        c.send('exit');c.server.wait(timeout=3)

    def test_eof_cleanup(self):
        c=self.client;c.open('HANG');rows=c.wait_records(lambda rows:len(rows)==1)
        c.server.stdin.close();c.server.wait(timeout=3);self.assert_clean(rows)

    def test_sigterm_cleanup(self):
        c=self.client;c.open('HANG');rows=c.wait_records(lambda rows:len(rows)==1)
        c.server.terminate();c.server.wait(timeout=3);self.assert_clean(rows)


if __name__ == '__main__':
    BINARY = sys.argv.pop(1) if len(sys.argv) > 1 else BINARY
    unittest.main()

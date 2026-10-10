"""Compare real native LSP diagnostics with the installed compiler's ranges."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

from native_async_protocol_test import NativeClient

BINARY, COMPILER = sys.argv[1:3]
del sys.argv[1:3]


class NativeDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.client = NativeClient(BINARY)
        self.addCleanup(self.client.close)
        self.client.initialize(COMPILER)

    def check(self, source, directory=None):
        c = self.client
        directory = directory or c.root
        file = directory / 'main.fg'
        file.write_text(source)
        reference = subprocess.run([COMPILER, str(file), '--check', '--diagnostics-json'],
                                   capture_output=True, text=True, timeout=5)
        self.assertEqual(reference.returncode, 1, reference.stderr)
        expected = json.loads(reference.stderr)
        c.open(source, uri=file.as_uri())
        message = c.wait(lambda m: m.get('method') == 'textDocument/publishDiagnostics'
                         and m['params'].get('uri') == file.as_uri())
        actual = message['params']['diagnostics']
        self.assertEqual(len(actual), 1, actual)
        self.assertIn(expected['message'], actual[0]['message'])
        return expected, actual[0]

    def test_semantic_range_after_unicode(self):
        expected, actual = self.check('native main { let text: string = "한😀"; println(missing); }')
        self.assertEqual(actual['range'], expected['range'])

    def test_parse_range_on_later_line(self):
        expected, actual = self.check('native main {\n    let value: int = ;\n}')
        self.assertEqual(actual['range'], expected['range'])

    def test_imported_colon_unicode_path_keeps_document_fallback(self):
        directory = self.client.root / 'module:한😀'
        directory.mkdir()
        helper = directory / 'helper.fg'
        helper.write_text('fn value(): int { return absent; }')
        expected, actual = self.check('import helper; native main { println(helper.value()); }', directory)
        self.assertEqual(expected['file'], str(helper))
        self.assertIn(str(helper), actual['message'])
        self.assertEqual(actual['range'], {'start': {'line': 0, 'character': 0},
                                          'end': {'line': 0, 'character': 1}})

    def test_valid_source_has_empty_diagnostics(self):
        c = self.client
        c.open('native main { println("한😀"); }')
        message = c.wait(lambda m: m.get('method') == 'textDocument/publishDiagnostics')
        self.assertEqual(message['params']['diagnostics'], [])


if __name__ == '__main__':
    unittest.main()

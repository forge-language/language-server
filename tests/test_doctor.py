"""Exercise real CLI processes for first-use failures, timeouts and stdio startup."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
DOCTOR = ROOT / 'scripts/doctor.py'


class DoctorTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='doctor-test-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.compiler = self.root / 'compiler'
        self.compiler.write_text('#!' + sys.executable + '\nimport sys\nfrom pathlib import Path\nassert "import strings;" in Path(sys.argv[1]).read_text()\noutput=Path(sys.argv[sys.argv.index("-o")+1])\noutput.write_text("#!/bin/sh"+chr(10)+"echo 5"+chr(10))\noutput.chmod(0o755)\n')
        self.compiler.chmod(0o755)
        self.server = self.root / 'server.py'
        self.server.write_text('''import sys,json
while True:
 header=sys.stdin.buffer.readline()
 if not header: break
 length=int(header.split(b":",1)[1]);sys.stdin.buffer.readline()
 message=json.loads(sys.stdin.buffer.read(length))
 if message['method']=='exit': break
 if 'id' not in message: continue
 result={'capabilities':{'hoverProvider':True}} if message['method']=='initialize' else None
 body=json.dumps({'jsonrpc':'2.0','id':message['id'],'result':result}).encode()
 sys.stdout.buffer.write(b'Content-Length: '+str(len(body)).encode()+b'\\r\\n\\r\\n'+body);sys.stdout.buffer.flush()
''')

    def run_doctor(self, *extra):
        result = subprocess.run([sys.executable, str(DOCTOR), '--json', '--compiler', str(self.compiler),
                                 '--server', sys.executable, '--server-arg', str(self.server), '--timeout', '1', *extra],
                                capture_output=True, text=True, timeout=8)
        return result, json.loads(result.stdout)

    def test_compiler_stdlib_and_server_handshake(self):
        result, report = self.run_doctor()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue(report['ok'])
        self.assertEqual([item['check'] for item in report['checks']], ['compiler', 'server'])

    def test_native_smoke_wrong_output_is_not_reported_as_healthy(self):
        self.compiler.write_text(self.compiler.read_text().replace('echo 5', 'echo incorrect'))
        result, report = self.run_doctor()
        self.assertEqual(result.returncode, 1)
        self.assertIn('expected output 5', report['checks'][0]['message'])
        self.assertTrue(report['checks'][1]['ok'])

    def test_missing_compiler_has_installation_action_but_server_still_checked(self):
        result, report = self.run_doctor('--compiler', str(self.root / 'missing'))
        self.assertEqual(result.returncode, 1)
        self.assertIn('PATH', report['checks'][0]['message'])
        self.assertTrue(report['checks'][1]['ok'])

    def test_non_lsp_command_fails_without_hanging(self):
        self.server.write_text('print("This is not an LSP server")\n')
        result, report = self.run_doctor()
        self.assertEqual(result.returncode, 1)
        self.assertFalse(report['checks'][1]['ok'])
        self.assertIn('stdout', report['checks'][1]['message'])

    def test_timeout_is_bounded_and_compiler_failure_explained(self):
        self.compiler.write_text('#!' + sys.executable + '\nimport sys\nprint("SDK files missing",file=sys.stderr)\nsys.exit(17)\n')
        self.server.write_text('import time\ntime.sleep(30)\n')
        result, report = self.run_doctor('--timeout', '0.2')
        self.assertEqual(result.returncode, 1)
        self.assertIn('SDK files missing', report['checks'][0]['message'])
        self.assertIn('did not answer initialize', report['checks'][1]['message'])


if __name__ == '__main__':
    unittest.main()

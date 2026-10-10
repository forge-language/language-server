#!/usr/bin/env python3
"""Measure native hover while a controlled compiler check is pending."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import random
import statistics
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tests'))
from native_async_protocol_test import NativeClient


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--server', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--samples', type=int, default=5)
    parser.add_argument('--seed', type=int, default=20261010)
    args = parser.parse_args()
    if args.samples < 1:
        parser.error('--samples must be positive')
    binaries = {'serial': args.baseline.resolve(), 'async': args.server.resolve()}
    order = list(binaries) * args.samples
    random.Random(args.seed).shuffle(order)
    samples = []
    for kind in order:
        client = NativeClient(str(binaries[kind]))
        try:
            compiler = Path(client.compiler)
            compiler.write_text(compiler.read_text().replace('time.sleep(1.5)', 'time.sleep(1.2)'))
            client.initialize()
            client.open('SLOW_CHECK_LATENCY')
            client.wait_records(lambda rows: len(rows) == 1)
            start = time.monotonic()
            request = client.request('textDocument/hover', {
                'textDocument': {'uri': 'file:///tmp/native.fg'},
                'position': {'line': 0, 'character': 2}})
            client.response(request, 3)
            samples.append({'implementation': kind,
                            'hover_ms': (time.monotonic() - start) * 1000})
        finally:
            client.close()
    result = {
        'fixture_compiler_sleep_ms': 1200,
        'scope': 'Hover after compiler startup; not compiler throughput or language performance.',
        'platform': platform.platform(), 'python': platform.python_version(),
        'seed': args.seed,
        'binary_sha256': {key: hashlib.sha256(file.read_bytes()).hexdigest()
                          for key, file in binaries.items()},
        'samples': samples,
        'median_hover_ms': {key: statistics.median(s['hover_ms'] for s in samples
                                                  if s['implementation'] == key)
                            for key in binaries}}
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result['median_hover_ms'], indent=2))


if __name__ == '__main__':
    main()

"""Build and verify a synthetic Windows PyInstaller backend with the real runner.

Explicit smoke (not normal pytest collection). It does not bundle models or
run the user's installed backend. All build outputs, profile data and processes
belong to this temporary fixture.

``*-eof`` modes close the test's own stdin pipe directly. ``parent-exit-*``
modes run the fixture under a throwaway launcher process that exits without
closing the child's stdin, so the child observes a real OS pipe EOF when that
launcher dies.
"""
from __future__ import annotations

import os
import queue
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / 'backend'
FIXTURE = BACKEND / 'tests' / 'fixtures' / 'managed_backend.py'

LAUNCHER = """\
import os, subprocess, sys, time

exe, profile, expected = sys.argv[1], sys.argv[2], sys.argv[3]
log_path = os.path.join(profile, 'child.log')
log = open(log_path, 'a', encoding='utf-8', errors='replace')
# Keep the Popen object referenced for the whole wait: dropping it lets CPython
# garbage-collect the stdin pipe and the child sees a premature EOF.
child = subprocess.Popen(
    [exe], cwd=profile, env=os.environ, stdin=subprocess.PIPE,
    stdout=log, stderr=subprocess.STDOUT,
    creationflags=subprocess.CREATE_NO_WINDOW,
)
seen = False
deadline = time.time() + 30
while time.time() < deadline:
    with open(log_path, 'r', encoding='utf-8', errors='replace') as handle:
        if expected in handle.read():
            seen = True
            break
    time.sleep(0.05)
if not seen:
    print('LAUNCHER_MARKER_MISSING', flush=True)
os._exit(0 if seen else 2)
"""


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def wait_for_line(events, expected, output, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if events.get(timeout=0.5) == expected:
                return
        except queue.Empty:
            continue
    raise AssertionError('ready/import line absent: ' + ''.join(output))


def wait_for_file(path, output, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.exists():
            return
        time.sleep(0.05)
    raise AssertionError(f'{path.name} absent: {output}')


def main():
    if sys.platform != 'win32':
        raise SystemExit('Windows-only explicit smoke')
    target = Path(tempfile.mkdtemp(prefix='ia-packaged-eof-'))
    print(f'Isolated packaged fixture: {target}', flush=True)
    subprocess.run([
        sys.executable, '-m', 'PyInstaller', '--noconfirm', '--console', '--name', 'ia-managed-fixture',
        '--paths', str(BACKEND), '--exclude-module', 'main', '--exclude-module', 'torch',
        '--exclude-module', 'tensorflow', '--exclude-module', 'numpy', '--exclude-module', 'pandas',
        '--exclude-module', 'scipy', '--exclude-module', 'matplotlib', '--exclude-module', 'pytest',
        '--distpath', str(target / 'dist'), '--workpath', str(target / 'work'),
        '--specpath', str(target), str(FIXTURE),
    ], cwd=ROOT, check=True)
    executable = target / 'dist' / 'ia-managed-fixture' / 'ia-managed-fixture.exe'
    launcher_script = target / 'launch_parent.py'
    launcher_script.write_text(LAUNCHER, encoding='utf-8')

    for mode in ('ready-eof', 'import-eof', 'parent-exit-ready', 'parent-exit-import'):
        profile = target / mode
        profile.mkdir()
        database = profile / 'fixture.db'
        exited = profile / 'exited.txt'
        env = {
            **os.environ, 'PORT': str(port()), 'IA_MANAGED_BACKEND': '1',
            'IA_BACKEND_LAUNCH_ID': f'owned-packaged-{mode}',
            'IA_FIXTURE_SHUTDOWN': str(profile / 'shutdown.txt'),
            'IA_FIXTURE_EXITED': str(exited),
            'IA_FIXTURE_DB': str(database),
            'IA_FIXTURE_IMPORT_DELAY': '0.5' if 'import' in mode else '0',
        }
        expected = (
            'IA_FIXTURE_IMPORT_STARTED' if 'import' in mode
            else f'IA_BACKEND_READY owned-packaged-{mode}'
        )

        if mode.startswith('parent-exit'):
            # The launcher dies while its child keeps running; the child must see
            # real OS EOF rather than an orderly stdin.close() from its parent.
            launcher = subprocess.Popen(
                [sys.executable, str(launcher_script), str(executable), str(profile), expected],
                cwd=profile, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding='utf-8', errors='replace',
            )
            try:
                try:
                    launcher_output, _ = launcher.communicate(timeout=45)
                except subprocess.TimeoutExpired:
                    launcher.kill()
                    launcher_output, _ = launcher.communicate()
                    raise AssertionError(
                        f'{mode}: parent launcher hung\n{launcher_output}'
                    )
            finally:
                if launcher.poll() is None:
                    launcher.kill()
                    launcher.wait(timeout=5)
            child_log = profile / 'child.log'
            child_output = child_log.read_text(encoding='utf-8', errors='replace') if child_log.exists() else ''
            assert launcher.returncode == 0, (
                f'{mode}: parent launcher failed rc={launcher.returncode}\n'
                f'launcher: {launcher_output}\nchild: {child_output}\nfixture: {target}'
            )
            assert expected in child_output, (
                f'{mode}: launcher never saw {expected!r}\n'
                f'launcher: {launcher_output}\nchild: {child_output}\nfixture: {target}'
            )
            wait_for_file(
                exited,
                f'{mode}: child did not finish after real parent exit\n'
                f'launcher: {launcher_output}\nchild: {child_output}\nfixture: {target}',
            )
            if mode == 'parent-exit-ready':
                assert (profile / 'shutdown.txt').exists(), child_output
                with sqlite3.connect(database) as conn:
                    assert conn.execute('select text from archive').fetchall() == [
                        ('synthetic active turn',)
                    ]
            else:
                assert 'IA_BACKEND_READY' not in child_output, child_output
            print(f'PASS Windows PyInstaller {mode}: real parent death exits owned child')
            continue

        proc = subprocess.Popen(
            [str(executable)], cwd=profile, env=env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8', errors='replace', creationflags=subprocess.CREATE_NO_WINDOW,
        )
        output = []
        events = queue.Queue()

        def read(proc=proc, output=output, events=events):
            for line in proc.stdout:
                output.append(line)
                events.put(line.rstrip())

        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        try:
            wait_for_line(events, expected, output)
            proc.stdin.close()
            code = proc.wait(timeout=10)
            reader.join(timeout=2)
            combined = ''.join(output)
            assert code == 0, f'{mode}: child rc={code}\n{combined}\nfixture: {target}'
            assert exited.exists(), f'{mode}: runner did not return\n{combined}\nfixture: {target}'
            if mode == 'ready-eof':
                assert (profile / 'shutdown.txt').exists(), combined
                with sqlite3.connect(database) as conn:
                    assert conn.execute('select text from archive').fetchall() == [
                        ('synthetic active turn',)
                    ]
            else:
                assert not any('IA_BACKEND_READY' in line for line in output), combined
            print(f'PASS Windows PyInstaller {mode}: real pipe EOF exits owned child')
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
            reader.join(timeout=2)
    print(f'Smoke complete: {target}')


if __name__ == '__main__':
    import traceback

    try:
        main()
    except Exception:
        traceback.print_exc()
        raise SystemExit(1)

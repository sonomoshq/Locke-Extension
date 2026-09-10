"""Local Git integration tests. No network or private source is used."""
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'rescue-native-host.py'
spec = importlib.util.spec_from_file_location('rescue_native_host', SCRIPT)
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.PIPE)


def blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


class RescueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.src = self.root / 'source'
        self.dst = self.root / 'destination'
        for repo, remote in [(self.src, m.SOURCE_REPO), (self.dst, m.DESTINATION_REPO)]:
            repo.mkdir()
            git(repo, 'init', '-q', '-b', 'main')
            git(repo, 'config', 'user.name', 'Fixture')
            git(repo, 'config', 'user.email', 'fixture@example.invalid')
            git(repo, 'remote', 'add', 'origin', 'https://github.com/' + remote + '.git')
        self.data = {
            'native-host/src/main.rs': '// fixture\r\nfn main() { /* café */ }\r\n'.encode(),
            'native-host/install.sh': b'#!/bin/sh\nprintf fixture\\n\n',
        }
        for name, data in self.data.items():
            p = self.src / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        (self.src / 'native-host/install.sh').chmod(0o755)
        self.license = b'Fixture source licence. All rights reserved.\n'
        (self.src / 'LICENSE').write_bytes(self.license)
        (self.src / 'private-notes.txt').write_text('This must not be copied.\n')
        git(self.src, 'add', '.')
        git(self.src, 'commit', '-qm', 'source fixture')
        self.pin = git(self.src, 'rev-parse', 'HEAD').decode().strip()
        self.snapshot = m.Snapshot(self.pin, {p: blob(b) for p, b in self.data.items()}, blob(self.license))
        (self.dst / 'README.md').write_text('# Existing extension\n')
        (self.dst / 'LICENSE').write_text('Unchanged destination licence\n')
        git(self.dst, 'add', '.')
        git(self.dst, 'commit', '-qm', 'destination fixture')
        git(self.dst, 'switch', '-qc', 'rescue-fixture')
        self.dst_head = git(self.dst, 'rev-parse', 'HEAD')

    def prepare(self):
        return m.prepare(self.src, self.dst, self.snapshot)

    def test_dry_run_does_not_change_either_worktree_or_history(self):
        plan = self.prepare()
        self.assertEqual(len(plan.files), 3)
        self.assertFalse((self.dst / 'native-host').exists())
        self.assertEqual(git(self.src, 'status', '--porcelain'), b'')
        self.assertEqual(git(self.dst, 'status', '--porcelain'), b'')
        self.assertEqual(git(self.dst, 'rev-parse', 'HEAD'), self.dst_head)

    def test_apply_preserves_bytes_modes_licence_and_existing_application(self):
        m.apply(self.prepare())
        for path, data in self.data.items():
            self.assertEqual((self.dst / path).read_bytes(), data)
            self.assertEqual((self.src / path).read_bytes(), data)
        self.assertEqual((self.dst / 'native-host/LICENSE').read_bytes(), self.license)
        self.assertEqual((self.dst / 'LICENSE').read_text(), 'Unchanged destination licence\n')
        self.assertEqual((self.dst / 'README.md').read_text(), '# Existing extension\n')
        self.assertFalse((self.dst / 'private-notes.txt').exists())
        if os.name != 'nt':
            self.assertTrue((self.dst / 'native-host/install.sh').stat().st_mode & 0o111)
        self.assertEqual(git(self.dst, 'diff', '--cached'), b'')
        self.assertEqual(git(self.dst, 'rev-parse', 'HEAD'), self.dst_head)
        self.assertTrue((self.dst / 'native-host/RESCUE-PROVENANCE.json').is_file())

    def test_dirty_source_is_never_copied_from_working_tree(self):
        (self.src / 'native-host/src/main.rs').write_text('UNCOMMITTED CHANGE')
        (self.src / 'native-host/secret.env').write_text('UNTRACKED PRIVATE FILE')
        m.apply(self.prepare())
        self.assertEqual((self.dst / 'native-host/src/main.rs').read_bytes(), self.data['native-host/src/main.rs'])
        self.assertFalse((self.dst / 'native-host/secret.env').exists())

    def test_default_branch_refused(self):
        git(self.dst, 'switch', '-q', 'main')
        with self.assertRaises(m.RescueError):
            self.prepare()

    def test_detached_head_refused(self):
        git(self.dst, 'switch', '-q', '--detach')
        with self.assertRaises(m.RescueError):
            self.prepare()

    def test_dirty_destination_refused_before_writing(self):
        (self.dst / 'untracked.txt').write_text('keep')
        with self.assertRaises(m.RescueError):
            self.prepare()
        self.assertFalse((self.dst / 'native-host').exists())

    def test_existing_ignored_destination_is_not_overwritten(self):
        with (self.dst / '.git/info/exclude').open('a') as f:
            f.write('\nnative-host/\n')
        (self.dst / 'native-host').mkdir()
        (self.dst / 'native-host/keep').write_text('keep')
        with self.assertRaises(m.RescueError):
            self.prepare()
        self.assertEqual((self.dst / 'native-host/keep').read_text(), 'keep')

    def test_wrong_origin_refused(self):
        git(self.dst, 'remote', 'set-url', 'origin', 'https://github.com/example/wrong.git')
        with self.assertRaises(m.RescueError):
            self.prepare()

    def test_bad_blob_pin_refused(self):
        bad = dict(self.snapshot.blobs)
        bad['native-host/src/main.rs'] = '0' * 40
        with self.assertRaises(m.RescueError):
            m.prepare(self.src, self.dst, m.Snapshot(self.pin, bad, self.snapshot.license_blob))
        self.assertFalse((self.dst / 'native-host').exists())

    def test_unexpected_tracked_host_file_refused(self):
        (self.src / 'native-host/extra.txt').write_text('unexpected')
        git(self.src, 'add', '.')
        git(self.src, 'commit', '-qm', 'extra source file')
        pin = git(self.src, 'rev-parse', 'HEAD').decode().strip()
        with self.assertRaises(m.RescueError):
            m.prepare(self.src, self.dst, m.Snapshot(pin, self.snapshot.blobs, self.snapshot.license_blob))

    def test_missing_source_commit_refused(self):
        with self.assertRaises(m.RescueError):
            m.prepare(self.src, self.dst, m.Snapshot('0' * 40, self.snapshot.blobs, self.snapshot.license_blob))

    def test_destination_changed_after_plan_is_refused(self):
        plan = self.prepare()
        (self.dst / 'README.md').write_text('changed after inspection')
        with self.assertRaises(m.RescueError):
            m.apply(plan)
        self.assertFalse((self.dst / 'native-host').exists())

    def test_second_apply_is_refused_without_deleting_first_copy(self):
        m.apply(self.prepare())
        before = (self.dst / 'native-host/src/main.rs').read_bytes()
        with self.assertRaises(m.RescueError):
            self.prepare()
        self.assertEqual((self.dst / 'native-host/src/main.rs').read_bytes(), before)


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
# Copyright (c) 2026 Sonomos, Inc. All rights reserved.
"""Rescue the pinned native host using local Git objects, without publishing it.

Python 3.9+ and Git are required. Dry-run by default. The apply mode only writes
an untracked native-host/ directory on a clean, non-default destination branch.
It never fetches, installs, stages, commits, pushes, merges, or deletes source.
"""
import argparse
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

SOURCE_REPO = 'sonomoshq/Depreciated-Desktop-Extension'
DESTINATION_REPO = 'sonomoshq/Locke-Extension'


class RescueError(Exception):
    """An invariant failed; no import should be published."""


@dataclass(frozen=True)
class Snapshot:
    commit: str
    blobs: dict
    license_blob: str


SNAPSHOT = Snapshot(
    'c379b85e37456c50fb0ccd128fb3f8d3610d1b77',
    {
        'native-host/Cargo.lock': 'fd0501435dd41a76c1fb40a6bd2e4af123da4753',
        'native-host/Cargo.toml': '6034fd4619502bf9bf0135981517d6943ea4bd09',
        'native-host/install.ps1': 'ece9354c185ff75fd153340b1cb321ecf5451cef',
        'native-host/install.sh': '897298a5b21ad0bb8146a7d31f8bb13300f85131',
        'native-host/manifest.chromium.json.template': 'a4b9b5fa3873bab2aff9d5cbddff4438b72e8855',
        'native-host/manifest.firefox.json.template': 'f9fd2e1e29d94783a1c2e0fc439e0b400553d087',
        'native-host/src/bridge.rs': 'a50710d72e0949e9953664fffbc31546fa364d16',
        'native-host/src/main.rs': '162c53a1e67a569e4907a83207405fed022b7a73',
        'native-host/src/surfaces_local.rs': '52c301b328f835059ff5d9994cf4e5b69e1ff3e1',
        'native-host/src/test_env.rs': '4d11921cb35ddc4263e1a25b44fbdfc36694bf31',
        'native-host/src/verification_tests.rs': '973a29cdf4521c9a8b4964f90e042ae00e7a8e7c',
    },
    'a15d900d9938b1de50d6585772804689da977667',
)


@dataclass(frozen=True)
class CopyFile:
    path: str
    data: bytes
    mode: str
    blob: str


@dataclass(frozen=True)
class Plan:
    source: Path
    destination: Path
    head: str
    branch: str
    snapshot: Snapshot
    files: tuple


def git(root, *args, optional=False):
    """Only local read commands are used. Do not log remote URLs or file bytes."""
    try:
        result = subprocess.run(
            ['git', '-c', 'core.fsmonitor=false', '-C', str(root), *args],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=30, check=False,
            env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'},
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RescueError('Local Git command unavailable or timed out.') from exc
    if result.returncode:
        if optional:
            return None
        raise RescueError('Local Git read failed: ' + args[0] + '. Check the checkout and pinned commit.')
    return result.stdout


def repo_root(path):
    root = Path(path).resolve(strict=True)
    reported = git(root, 'rev-parse', '--show-toplevel').decode().strip()
    if Path(reported).resolve() != root:
        raise RescueError('Pass the checkout root, not a directory inside it.')
    return root


def require_origin(root, expected):
    remote = git(root, 'remote', 'get-url', 'origin').decode().strip()
    if remote.startswith('git@github.com:'):
        path = remote[len('git@github.com:'):]
    else:
        url = urlsplit(remote)
        if url.hostname != 'github.com' or url.scheme not in ('https', 'ssh'):
            raise RescueError('Origin must identify the intended GitHub repository.')
        path = url.path.lstrip('/')
    path = path.rstrip('/')
    if path.endswith('.git'):
        path = path[:-4]
    if path.lower() != expected.lower():
        raise RescueError('Wrong origin repository; refusing the import.')


def destination_state(root):
    branch = git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD', optional=True)
    if branch is None:
        raise RescueError('Use an explicit migration branch, not detached HEAD.')
    branch = branch.decode().strip()
    protected = {'main', 'master'}
    default = git(root, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD', optional=True)
    if default:
        protected.add(default.decode().strip().removeprefix('origin/'))
    if branch in protected:
        raise RescueError('Refusing to write on the default branch. Switch to the migration branch.')
    if git(root, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'):
        raise RescueError('Destination must be clean, including untracked files.')
    if os.path.lexists(root / 'native-host'):
        raise RescueError('native-host already exists, possibly ignored; it will not be overwritten.')
    return git(root, 'rev-parse', 'HEAD').decode().strip(), branch


def hash_blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode('ascii') + b'\0' + data).hexdigest()


def prepare(source, destination, snapshot=SNAPSHOT):
    src, dst = repo_root(source), repo_root(destination)
    if src == dst:
        raise RescueError('Source and destination must be different checkouts.')
    require_origin(src, SOURCE_REPO)
    require_origin(dst, DESTINATION_REPO)
    head, branch = destination_state(dst)
    if not re.fullmatch(r'[0-9a-f]{40}', snapshot.commit):
        raise RescueError('Source must be pinned by a full commit SHA.')
    resolved = git(src, 'rev-parse', '--verify', snapshot.commit + '^{commit}').decode().strip()
    if resolved != snapshot.commit:
        raise RescueError('Source commit did not resolve to the approved pin.')
    entries = {}
    for record in git(src, 'ls-tree', '-rz', snapshot.commit, '--', 'native-host').split(b'\0'):
        if not record:
            continue
        metadata, path = record.split(b'\t', 1)
        mode, kind, sha = metadata.decode('ascii').split()
        name = path.decode('utf-8')
        if kind != 'blob' or mode not in ('100644', '100755'):
            raise RescueError('Symlinks, submodules, and non-regular host files are refused.')
        if not name.startswith('native-host/') or '..' in Path(name).parts:
            raise RescueError('Unsafe source path.')
        entries[name] = (mode, sha)
    if set(entries) != set(snapshot.blobs):
        raise RescueError('Host inventory differs from the approved snapshot; review before importing.')
    files = []
    for name, expected in sorted(snapshot.blobs.items()):
        mode, sha = entries[name]
        if sha != expected:
            raise RescueError('Pinned source blob mismatch: ' + name)
        data = git(src, 'cat-file', 'blob', sha)
        if hash_blob(data) != expected:
            raise RescueError('Git object byte verification failed: ' + name)
        files.append(CopyFile(name, data, mode, sha))
    sha = git(src, 'rev-parse', snapshot.commit + ':LICENSE').decode().strip()
    data = git(src, 'cat-file', 'blob', sha)
    if sha != snapshot.license_blob or hash_blob(data) != snapshot.license_blob:
        raise RescueError('Source licence does not match the reviewed snapshot.')
    files.append(CopyFile('native-host/LICENSE', data, '100644', sha))
    return Plan(src, dst, head, branch, snapshot, tuple(files))


def apply(plan):
    """Publish a fully staged directory locally, never a Git commit or release."""
    require_origin(plan.destination, DESTINATION_REPO)
    if destination_state(plan.destination) != (plan.head, plan.branch):
        raise RescueError('Destination changed after planning; inspect and plan again.')
    provenance = {
        'source_repository': SOURCE_REPO,
        'source_commit': plan.snapshot.commit,
        'source_pull_request': 84,
        'source_pr_status_at_review': 'open draft, 2026-09-10',
        'destination_repository': DESTINATION_REPO,
        'files': {f.path: {'git_blob': f.blob, 'mode': f.mode} for f in plan.files},
        'runtime_validation': 'NOT performed by this import tool',
    }
    readme = '''# Native messaging host: rescued source snapshot

The source in this directory was copied from the exact commit recorded in
RESCUE-PROVENANCE.json. Existing source files and Cargo.lock are byte-identical.
The imported work includes pending source PR #84, not just the old main branch.

## Licensing and private dependencies

This directory retains the Sonomos Source-Available Licence (View Only) in
LICENSE. The parent browser-extension PolyForm licence does not replace it.
These files are not relicensed by the move. Building the host still requires
authorized access to Service-Mesh and Extension-Bridge. Neither dependency,
private Git history, nor the stale browser extension is copied here.

## Distribution

The binary remains extension-host. The registered host name remains
ai.sonomos.desktop. The desktop installer must still build and install it;
the browser store package must not contain native-host sources or binaries.
No protocol, timeout, screening policy, or host registration is changed.

## Import is not completion

This tool does not update Locke's gates, submodule pins, packaging resolvers,
Desktop-Frontend staging paths, or Inspector. Do not retire the source repository
until those consumers are migrated and installation is validated. Retain old
Git objects for historical releases. Review existing extension documentation
that still describes the native host as out of repository.

Authorized maintainers must run the native Cargo tests and lint/format gates,
the browser extension tests, package-content checks, and real browser/desktop
installation and reconnection tests before marking the migration ready.
'''
    with tempfile.TemporaryDirectory(prefix='.native-host-rescue-', dir=plan.destination) as temporary:
        staging = Path(temporary)
        for item in plan.files:
            target = staging / item.path
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as stream:
                stream.write(item.data)
            target.chmod(0o755 if item.mode == '100755' else 0o644)
            if hash_blob(target.read_bytes()) != item.blob:
                raise RescueError('Staged byte verification failed: ' + item.path)
        host = staging / 'native-host'
        (host / 'RESCUE-PROVENANCE.json').write_text(json.dumps(provenance, indent=2) + '\n', encoding='utf-8')
        (host / 'README.md').write_text(readme, encoding='utf-8')
        (host / '.gitignore').write_text('/target/\n', encoding='ascii')
        if os.path.lexists(plan.destination / 'native-host'):
            raise RescueError('Destination appeared during staging; refusing to replace it.')
        os.rename(host, plan.destination / 'native-host')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path, help='Local deprecated repository checkout root')
    parser.add_argument('--destination', required=True, type=Path, help='Clean Locke-Extension migration checkout root')
    parser.add_argument('--apply', action='store_true', help='Write the verified source locally; no commit or push')
    args = parser.parse_args(argv)
    try:
        plan = prepare(args.source, args.destination)
        print('Source commit: ' + plan.snapshot.commit)
        print('Destination branch: ' + plan.branch)
        print('Verified source files including original licence: ' + str(len(plan.files)))
        for item in plan.files:
            print(item.mode + ' ' + item.blob + ' ' + item.path)
        if args.apply:
            apply(plan)
            print('Imported locally. No files staged, no commit, no push, no source deletion.')
            print('Downstream wiring and runtime validation are still required. Do not archive the source yet.')
        else:
            print('Dry-run only. Re-run with --apply to write the verified source locally.')
        return 0
    except (RescueError, OSError, UnicodeError, ValueError) as exc:
        print('Rescue refused: ' + str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

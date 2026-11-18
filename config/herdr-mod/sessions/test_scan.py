#!/usr/bin/env python3
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import scan


SESSION_ID = '01a1e430-bb9e-76d1-b5aa-4b6200e8ed6a'


def thread(session_id=SESSION_ID, **kwargs):
    return {'id': session_id, 'name': 'renamed task', 'preview': 'first prompt',
            'cwd': '/work/project', 'path': '/sessions/latest.jsonl',
            'updatedAt': int(time.time()), **kwargs}


class StandardTraeListTest(unittest.TestCase):
    def test_paginated_threads_have_logical_ids_and_official_names(self):
        client = Mock()
        client.request.side_effect = [
            {'data': [thread()], 'nextCursor': 'opaque-page-2'},
            {'data': [thread(), thread('other-id', name=None, preview='other task')], 'nextCursor': None},
        ]
        with patch.object(scan, 'connect_trae', return_value=client):
            rows = scan.list_trae_sessions()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['id'], SESSION_ID)
        self.assertEqual(rows[0]['title'], 'renamed task')
        self.assertEqual(rows[1]['title'], 'other task')
        self.assertEqual(client.request.call_args_list[1].args[1]['cursor'], 'opaque-page-2')
        self.assertEqual(client.request.call_args_list[0].args[0], 'thread/list')
        self.assertFalse(client.request.call_args_list[0].args[1]['archived'])
        self.assertTrue(client.request.call_args_list[0].args[1]['useStateDbOnly'])
        client.close.assert_called_once()

    def test_archive_filter_and_empty_title_fallback(self):
        client = Mock()
        client.request.return_value = {'data': [thread(name=None, preview='')], 'nextCursor': None}
        with patch.object(scan, 'connect_trae', return_value=client):
            rows = scan.list_trae_sessions(archived=True)
        self.assertTrue(rows[0]['archived'])
        self.assertEqual(rows[0]['title'], SESSION_ID)
        self.assertTrue(client.request.call_args.args[1]['archived'])

    def test_stops_after_history_cutoff_and_closes_client(self):
        client = Mock()
        client.request.return_value = {'data': [thread(updatedAt=0)], 'nextCursor': 'unused'}
        with patch.object(scan, 'connect_trae', return_value=client):
            self.assertEqual(scan.list_trae_sessions(), [])
        client.request.assert_called_once()
        client.close.assert_called_once()

    def test_repeated_cursor_is_an_error(self):
        client = Mock()
        client.request.return_value = {'data': [thread()], 'nextCursor': 'same'}
        with patch.object(scan, 'connect_trae', return_value=client), self.assertRaises(ValueError):
            scan.list_trae_sessions()
        client.close.assert_called_once()

    def test_three_rollout_fragments_are_never_scanned_as_three_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            for index in range(3):
                (Path(directory) / f'rollout-{index}.jsonl').write_text(json.dumps({
                    'type': 'session_meta', 'payload': {'session_id': SESSION_ID}}) + '\n')
            output = io.StringIO()
            with patch.object(scan, 'ROOTS', [('traex', directory, 5)]), \
                    patch.object(scan, 'list_trae_sessions', return_value=[{'id': SESSION_ID, 'mtime': 1}]), \
                    patch.object(scan.os, 'walk') as walk, redirect_stdout(output):
                scan.scan()
            walk.assert_not_called()
            self.assertEqual(len(json.loads(output.getvalue())['sessions']), 1)

    def test_server_failure_does_not_fall_back_to_unsafe_rollout_scan(self):
        output = io.StringIO()
        with patch.object(scan, 'ROOTS', [('traex', '/unused', 5)]), \
                patch.object(scan, 'list_trae_sessions', side_effect=ValueError('unavailable')), \
                patch.object(scan.os, 'walk') as walk, redirect_stdout(output):
            scan.scan()
        result = json.loads(output.getvalue())
        self.assertEqual(result['sessions'], [])
        self.assertIn('unavailable', result['warnings'][0])
        walk.assert_not_called()

    def test_other_cli_still_lists_when_trae_is_unavailable(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'other.jsonl').write_text(json.dumps({
                'type': 'user', 'cwd': '/work', 'message': {'content': 'another CLI'}}) + '\n')
            output = io.StringIO()
            with patch.object(scan, 'ROOTS', [('traex', '/unused', 5), ('claude', directory, 5)]), \
                    patch.object(scan, 'list_trae_sessions', side_effect=ValueError('unavailable')), \
                    redirect_stdout(output):
                scan.scan()
            result = json.loads(output.getvalue())
            self.assertEqual(result['sessions'][0]['title'], 'another CLI')
            self.assertTrue(result['warnings'])


class TraeLifecycleTest(unittest.TestCase):
    def test_delete_uses_official_logical_session_command(self):
        with patch.object(scan, 'trae_executable', return_value='/bin/traecli'), \
                patch.object(scan.subprocess, 'run', return_value=Mock(returncode=0)) as run:
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(scan.main(['--delete', 'traex', SESSION_ID]), 0)
        self.assertEqual(run.call_args.args[0], ['/bin/traecli', 'delete', SESSION_ID, '--force'])
        self.assertEqual(json.loads(output.getvalue()), {'action': 'delete', 'id': SESSION_ID})

    def test_archive_and_unarchive_use_official_commands(self):
        for action in ['archive', 'unarchive']:
            with self.subTest(action=action), \
                    patch.object(scan, 'trae_executable', return_value='traecli'), \
                    patch.object(scan.subprocess, 'run', return_value=Mock(returncode=0)) as run:
                scan.manage_trae_session(action, SESSION_ID)
                self.assertEqual(run.call_args.args[0], ['traecli', action, SESSION_ID])

    def test_dependency_rejection_is_preserved_without_file_mutation(self):
        with patch.object(scan, 'trae_executable', return_value='traecli'), \
                patch.object(scan.subprocess, 'run', return_value=Mock(
                    returncode=1, stderr='history is referenced by another thread', stdout='')), \
                patch.object(scan.os, 'rename') as rename, \
                self.assertRaisesRegex(ValueError, 'referenced'):
            scan.manage_trae_session('delete', SESSION_ID)
        rename.assert_not_called()

    def test_legacy_path_and_flags_cannot_delete_trae_rollouts(self):
        with patch.object(scan.subprocess, 'run') as run, patch.object(scan.os, 'rename') as rename:
            for value in ['/sessions/rollout.jsonl', '--force', 'same-name']:
                with self.subTest(value=value), self.assertRaises(ValueError):
                    scan.manage_trae_session('delete', value)
            with self.assertRaises(ValueError):
                scan.delete_session('traex', '/sessions/rollout.jsonl')
        run.assert_not_called()
        rename.assert_not_called()


class JsonRpcTransportTest(unittest.TestCase):
    def test_stdio_handshake_notifications_requests_and_protocol_errors(self):
        # An actual subprocess verifies transport framing and notification handling.
        source = '''import sys,json
for line in sys.stdin:
 m=json.loads(line)
 if 'id' not in m: continue
 if m.get('method') == 'initialize':
  print(json.dumps({'id':m['id'],'result':{}}), flush=True)
 elif m.get('method') == 'thread/list':
  print(json.dumps({'method':'status/changed','params':{}}), flush=True)
  print(json.dumps({'id':900,'method':'unexpected/request','params':{}}), flush=True)
  print(json.dumps({'id':m['id'],'result':{'data':[],'nextCursor':None}}), flush=True)
 elif m.get('method') == 'fail':
  print(json.dumps({'id':m['id'],'error':{'code':-32600,'message':'blocked'}}), flush=True)
'''
        client = scan.TraeRpc([sys.executable, '-u', '-c', source], time.monotonic() + 3)
        try:
            self.assertEqual(client.request('initialize', {}), {})
            client.send({'method': 'initialized'})
            self.assertEqual(client.request('thread/list', {}), {'data': [], 'nextCursor': None})
            with self.assertRaisesRegex(ValueError, 'blocked'):
                client.request('fail', {})
        finally:
            client.close()
        self.assertIsNotNone(client.process.returncode)

    def test_timeout_closes_an_unresponsive_server(self):
        client = scan.TraeRpc([sys.executable, '-c', 'import time;time.sleep(3)'], time.monotonic() + .1)
        try:
            with self.assertRaises(TimeoutError):
                client.request('initialize', {})
        finally:
            client.close()
        self.assertIsNotNone(client.process.returncode)


class OtherCliDeletionTest(unittest.TestCase):
    def test_delete_cli_reports_recoverable_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            session = Path(directory) / 'session.jsonl'
            session.write_text('{}\n')
            output = io.StringIO()
            with patch.object(scan, 'ROOTS', [('codex', directory, 1)]), redirect_stdout(output):
                code = scan.main(['--delete', 'codex', str(session)])
            self.assertEqual(code, 0)
            self.assertFalse(session.exists())
            self.assertTrue(Path(json.loads(output.getvalue())['deleted_to']).is_file())

    def test_rejects_paths_outside_root_and_non_jsonl_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'sessions'
            root.mkdir()
            outside = Path(directory) / 'outside.jsonl'
            other = root / 'notes.txt'
            outside.write_text('{}\n')
            other.write_text('keep me')
            for path in [outside, other]:
                with self.subTest(path=path), self.assertRaises(ValueError):
                    scan.delete_session('codex', str(path), [('codex', str(root), 1)])
                self.assertTrue(path.exists())

    def test_user_message_array_title(self):
        head = (json.dumps({'type': 'user', 'cwd': '/work', 'message': {
            'content': [{'type': 'text', 'text': 'task'}]}}) + '\n').encode()
        self.assertEqual(scan.first_user_title(head), ('task', '/work'))


if __name__ == '__main__':
    unittest.main()

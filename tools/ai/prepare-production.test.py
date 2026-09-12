"""Provision real temporary files; replace privileged ownership and database calls."""
import contextlib
import io
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('prepare-production.py')

class ProvisioningTest(unittest.TestCase):
    def test_rerun_repairs_permissions_and_preserves_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            config = root/'credentials'
            deployment = root/'deployment'
            deployment.mkdir()
            auth = deployment/'.env.auth'
            auth.write_text('UNRELATED=preserved\n')
            def mapped_path(value):
                return config if str(value) == '/etc/herkules-ai' else type(root)(value)
            def provision():
                previous_umask = os.umask(0o077)
                try:
                    with patch('pathlib.Path', side_effect=mapped_path), \
                         patch('os.geteuid', return_value=0), \
                         patch('os.chown') as ownership, \
                         patch('subprocess.run') as command, \
                         patch('sys.argv', [str(SCRIPT), str(deployment)]), \
                         contextlib.redirect_stdout(io.StringIO()):
                        command.return_value.returncode = 0
                        runpy.run_path(str(SCRIPT), run_name='__main__')
                        return ownership
                finally:
                    os.umask(previous_umask)
            provision()
            key = config/'gateway/client-secret'
            original = key.read_text()
            for path in [config, config/'gateway', key, deployment/'.env.ai']:
                path.chmod(0o777)
            ownership = provision()
            self.assertEqual(key.read_text(), original)
            for path in [config, config/'gateway']:
                self.assertEqual(path.stat().st_mode & 0o777, 0o700)
            self.assertEqual(key.stat().st_mode & 0o777, 0o400)
            ownership.assert_any_call(config, 0, 0)
            ownership.assert_any_call(config/'gateway', 1000, 1000)
            for name in ['.env.ai', '.env.ai-gateway', '.env.auth']:
                path = deployment/name
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                ownership.assert_any_call(path, auth.stat().st_uid, auth.stat().st_gid)
            self.assertIn('UNRELATED=preserved\n', auth.read_text())
            self.assertIn('AI_CLIENT_SECRET='+original.strip(), auth.read_text())
            self.assertIn('SQL_DSN=postgres://', (deployment/'.env.ai').read_text())
            self.assertIn('AI_METADATA_DATABASE_URL=postgres://', (deployment/'.env.ai-gateway').read_text())

if __name__ == '__main__':
    unittest.main()

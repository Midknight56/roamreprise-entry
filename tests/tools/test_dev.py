"""Developer-tool checks. No real credential files, subprocesses or network are used."""
import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "dev"))
import cf

spec = importlib.util.spec_from_file_location("rr_secret_tool", ROOT / "dev/secrets.py")
secret_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(secret_tool)


class DeveloperTools(unittest.TestCase):
    def test_deprecation_stops_deploy_before_credentials_or_vendor(self):
        with patch.object(sys, "argv", ["cf.py", "deploy"]), patch.object(cf.subprocess, "run", return_value=Mock(returncode=1)) as run, patch.object(cf, "env_for_wrangler", side_effect=AssertionError("must not read credentials")):
            self.assertEqual(cf.main(), 1)
            self.assertEqual(run.call_count, 1)
            self.assertTrue(run.call_args.args[0][1].endswith("check_model.mjs"))

    def test_model_check_runs_before_vendor_and_deploy(self):
        with patch.object(sys, "argv", ["cf.py", "deploy"]), patch.object(cf.subprocess, "run", return_value=Mock(returncode=0)) as run, patch.object(cf, "env_for_wrangler", return_value={}):
            self.assertEqual(cf.main(), 0)
            commands = [call.args[0] for call in run.call_args_list]
            self.assertTrue(commands[0][1].endswith("check_model.mjs"))
            self.assertTrue(commands[1][1].endswith("vendor.py"))
            self.assertEqual(commands[2], ["npx", "wrangler", "deploy"])

    def test_dev_vars_prints_names_only_and_enables_dev_routes(self):
        values = {"PAYPAL_CLIENT_ID": "fake-client", "PAYPAL_CLIENT_SECRET": "fake-secret", "PAYPAL_WEBHOOK_ID": "fake-webhook"}
        (ROOT / ".wrangler").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT / ".wrangler") as directory, patch.object(secret_tool, "ROOT", directory), patch.object(secret_tool, "read_values", return_value=values), patch.object(sys, "argv", ["secrets.py", "dev-vars"]):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(secret_tool.main(), 0)
            self.assertEqual(output.getvalue().splitlines(), [*values, "DEV_ROUTES"])
            self.assertIn("DEV_ROUTES=1", (Path(directory) / ".dev.vars").read_text())

    def test_put_passes_values_only_on_stdin_and_prints_names(self):
        values = {"PAYPAL_CLIENT_ID": "fake-client", "PAYPAL_CLIENT_SECRET": "fake-secret", "PAYPAL_WEBHOOK_ID": "fake-webhook"}
        with patch.object(secret_tool, "read_values", return_value=values), patch.object(secret_tool, "env_for_wrangler", return_value={"ACCOUNT": "test"}), patch.object(secret_tool.subprocess, "run", return_value=Mock(returncode=0)) as run, patch.object(sys, "argv", ["secrets.py", "put"]):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(secret_tool.main(), 0)
            self.assertEqual(output.getvalue().splitlines(), list(values))
            for call, (name, value) in zip(run.call_args_list, values.items()):
                self.assertEqual(call.args[0], ["npx", "wrangler", "secret", "put", name])
                self.assertEqual(call.kwargs["input"], value + "\n")
                self.assertEqual(call.kwargs["env"], {"ACCOUNT": "test"})


if __name__ == "__main__":
    unittest.main()

"""Explicit operator tool. Prints secret names only; values are stdin or an ignored local file."""
import argparse
import os
from pathlib import Path
import subprocess
import sys

from cf import ROOT, env_for_wrangler


def read_values():
    values = {}
    source = Path("C:/Users/User/.cloudflare/paypal-sandbox.local.txt")
    for line in source.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            name, value = line.split("=", 1)
            values[name.strip()] = value.strip().strip('"').strip("'")
    return {
        "PAYPAL_CLIENT_ID": values["PAYPAL_SANDBOX_CLIENT_ID"],
        "PAYPAL_CLIENT_SECRET": values["PAYPAL_SANDBOX_SECRET"],
        "PAYPAL_WEBHOOK_ID": (Path(ROOT) / ".wrangler/webhook-id.txt").read_text(encoding="utf-8").strip(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["dev-vars", "put"])
    args = parser.parse_args()
    values = read_values()
    if not all(values.values()) or any("\n" in value or "\r" in value for value in values.values()):
        raise ValueError("Invalid secret format")
    if args.action == "dev-vars":
        # JSON strings are accepted in dotenv and preserve special characters without logging them.
        import json
        (Path(ROOT) / ".dev.vars").write_text("".join(f"{name}={json.dumps(value)}\n" for name, value in values.items()) + "DEV_ROUTES=1\n", encoding="utf-8")
        for name in [*values, "DEV_ROUTES"]:
            print(name)
    else:
        env = env_for_wrangler()
        for name, value in values.items():
            result = subprocess.run(["npx", "wrangler", "secret", "put", name], cwd=ROOT, env=env,
                                    input=value + "\n", text=True, capture_output=True, shell=(os.name == "nt"))
            if result.returncode:
                print(f"{name}: failed (exit {result.returncode})", file=sys.stderr)
                return result.returncode
            print(name)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Avoid tracebacks containing credential source lines or subprocess arguments.
        print("Secret setup failed. Check local input files and account configuration.", file=sys.stderr)
        sys.exit(1)

#!/usr/bin/env python3
"""Save Cloudflare Access credentials outside the checkout, without echoing them."""
import getpass
import os
from pathlib import Path


def credential_value(raw, header):
    """Accept a bare value or the header copied by the Cloudflare dashboard."""
    value = raw.strip()
    if value.lower().startswith(header.lower() + ":"):
        value = value[len(header) + 1:].strip()
    if not value or any(ch.isspace() for ch in value) or ":" in value:
        raise ValueError(f"Paste the {header} value or its complete header line. No files written.")
    return value


def main():
    directory = Path.home() / ".config" / "herkules" / "ai"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    paths = [directory / "cf-access-client-id", directory / "cf-access-client-secret"]
    if any(path.exists() for path in paths):
        raise SystemExit("Credential files already exist. Move them aside before saving a replacement pair.")
    print("Paste either the complete CF-Access header line or just its value. Inputs are hidden.")
    try:
        values = [
            credential_value(getpass.getpass("Cloudflare Client ID (hidden): "), "CF-Access-Client-Id"),
            credential_value(getpass.getpass("Cloudflare Client Secret (hidden): "), "CF-Access-Client-Secret"),
        ]
    except ValueError as error:
        raise SystemExit(str(error)) from None
    for path, value in zip(paths, values):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as output:
            output.write(value + "\n")
    print(f"Saved credentials with mode 600 in {directory}. No secret values printed.")


if __name__ == "__main__":
    main()

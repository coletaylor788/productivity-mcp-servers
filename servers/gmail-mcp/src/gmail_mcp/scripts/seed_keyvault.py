"""One-time script to seed Google OAuth token into Azure Key Vault.

Run from a machine with a browser to complete the Google OAuth consent flow,
then store the resulting token in Azure Key Vault via the az CLI.

Usage:
    python -m gmail_mcp.scripts.seed_keyvault \
        --vault-name my-vault \
        --credentials ~/path/to/credentials.json
"""

import argparse
import subprocess
import sys

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
]
DEFAULT_SECRET_NAME = "google-mcp-token"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Seed Google OAuth token into Azure Key Vault",
    )
    parser.add_argument(
        "--vault-name", required=True, help="Azure Key Vault name",
    )
    parser.add_argument(
        "--credentials", required=True, help="Path to Google OAuth credentials.json",
    )
    parser.add_argument(
        "--secret-name", default=DEFAULT_SECRET_NAME, help="Key Vault secret name",
    )
    args = parser.parse_args()

    # Run Google OAuth flow (opens browser)
    print("Opening browser for Google OAuth consent...")
    flow = InstalledAppFlow.from_client_secrets_file(args.credentials, SCOPES)
    creds = flow.run_local_server(port=0)
    token_json = creds.to_json()

    # Store in Key Vault via az CLI
    print(f"Storing token in Key Vault '{args.vault_name}'...")
    result = subprocess.run(
        [
            "az", "keyvault", "secret", "set",
            "--vault-name", args.vault_name,
            "--name", args.secret_name,
            "--value", token_json,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"Error storing secret: {result.stderr}", file=sys.stderr)
        sys.exit(1)

    print(f"✓ Token stored in Key Vault '{args.vault_name}' as '{args.secret_name}'")


if __name__ == "__main__":
    main()

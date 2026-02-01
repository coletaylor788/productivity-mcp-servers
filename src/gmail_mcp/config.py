"""Configuration management for Gmail MCP server."""

import os
from pathlib import Path

# Default config directory (XDG-compliant)
DEFAULT_CONFIG_DIR = Path.home() / ".config" / "gmail-mcp"

# Keychain service name
KEYCHAIN_SERVICE = "gmail-mcp"


def get_config_dir() -> Path:
    """Get the config directory path, creating it if needed.

    Returns:
        Path to config directory (~/.config/gmail-mcp/)
    """
    config_dir = Path(os.environ.get("GMAIL_MCP_CONFIG_DIR", DEFAULT_CONFIG_DIR))

    if not config_dir.exists():
        config_dir.mkdir(parents=True, mode=0o700)

    return config_dir


def get_credentials_path() -> Path:
    """Get the path to the OAuth credentials file.

    Returns:
        Path to credentials.json
    """
    return get_config_dir() / "credentials.json"

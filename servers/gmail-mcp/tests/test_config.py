"""Unit tests for config module."""

import os
import tempfile
from pathlib import Path
from unittest.mock import patch

from gmail_mcp.config import get_config_dir, get_credentials_path


class TestGetConfigDir:
    """Tests for get_config_dir()."""

    def test_creates_directory_if_not_exists(self):
        """Config dir is created with 700 permissions if it doesn't exist."""
        with tempfile.TemporaryDirectory() as tmp:
            test_dir = Path(tmp) / "gmail-mcp-test"
            with patch.dict(os.environ, {"GMAIL_MCP_CONFIG_DIR": str(test_dir)}):
                result = get_config_dir()

                assert result == test_dir
                assert result.exists()
                assert result.is_dir()
                # Check permissions (700 = owner rwx only)
                assert oct(result.stat().st_mode)[-3:] == "700"

    def test_returns_existing_directory(self):
        """Existing config dir is returned without modification."""
        with tempfile.TemporaryDirectory() as tmp:
            test_dir = Path(tmp) / "gmail-mcp-test"
            test_dir.mkdir(mode=0o755)  # Different permissions

            with patch.dict(os.environ, {"GMAIL_MCP_CONFIG_DIR": str(test_dir)}):
                result = get_config_dir()

                assert result == test_dir
                assert result.exists()

    def test_uses_default_when_env_not_set(self):
        """Uses ~/.config/gmail-mcp when GMAIL_MCP_CONFIG_DIR not set."""
        with patch.dict(os.environ, {}, clear=False):
            # Remove env var if it exists
            os.environ.pop("GMAIL_MCP_CONFIG_DIR", None)
            result = get_config_dir()

            expected = Path.home() / ".config" / "gmail-mcp"
            assert result == expected


class TestGetCredentialsPath:
    """Tests for get_credentials_path()."""

    def test_returns_credentials_json_in_config_dir(self):
        """Returns path to credentials.json in config dir."""
        with tempfile.TemporaryDirectory() as tmp:
            test_dir = Path(tmp) / "gmail-mcp-test"
            with patch.dict(os.environ, {"GMAIL_MCP_CONFIG_DIR": str(test_dir)}):
                result = get_credentials_path()

                assert result == test_dir / "credentials.json"
                assert result.name == "credentials.json"

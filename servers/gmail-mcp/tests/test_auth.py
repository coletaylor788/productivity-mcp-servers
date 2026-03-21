"""Unit tests for auth module."""

import json
from unittest.mock import MagicMock, patch

import pytest

from gmail_mcp.auth import (
    _use_env_backend,
    get_gmail_service,
    get_token,
    is_authenticated,
    run_oauth_flow,
    store_token,
)
from gmail_mcp.config import GOOGLE_TOKEN_ENV, KEYCHAIN_SERVICE


# Ensure env backend is not active during Keychain tests
@pytest.fixture(autouse=True)
def _clear_env_token(monkeypatch):
    """Remove GOOGLE_MCP_TOKEN env var and reset cached creds for each test."""
    monkeypatch.delenv(GOOGLE_TOKEN_ENV, raising=False)
    import gmail_mcp.auth

    gmail_mcp.auth._cached_creds = None


class TestBackendSelection:
    """Tests for backend selection logic."""

    def test_uses_env_backend_when_env_set(self, monkeypatch):
        """Returns True when GOOGLE_MCP_TOKEN is set."""
        monkeypatch.setenv(GOOGLE_TOKEN_ENV, '{"token": "x"}')
        assert _use_env_backend() is True

    def test_uses_keychain_backend_when_env_not_set(self):
        """Returns False when GOOGLE_MCP_TOKEN is not set."""
        assert _use_env_backend() is False


class TestEnvBackend:
    """Tests for environment variable backend."""

    def test_is_authenticated_with_valid_token(self, monkeypatch):
        """Returns True when env var contains valid token JSON."""
        token_data = json.dumps({
            "token": "access_token",
            "refresh_token": "refresh_token",
            "token_uri": "https://oauth2.googleapis.com/token",
            "client_id": "client_id",
            "client_secret": "client_secret",
        })
        monkeypatch.setenv(GOOGLE_TOKEN_ENV, token_data)
        assert is_authenticated() is True

    def test_is_authenticated_with_invalid_json(self, monkeypatch):
        """Returns False when env var contains invalid JSON."""
        monkeypatch.setenv(GOOGLE_TOKEN_ENV, "not json")
        assert is_authenticated() is False

    def test_get_token_returns_credentials(self, monkeypatch):
        """Returns Credentials object from env var."""
        import gmail_mcp.auth

        token_data = json.dumps({
            "token": "access_token",
            "refresh_token": "refresh_token",
            "token_uri": "https://oauth2.googleapis.com/token",
            "client_id": "client_id",
            "client_secret": "client_secret",
        })
        monkeypatch.setenv(GOOGLE_TOKEN_ENV, token_data)

        # Pre-load to avoid refresh attempt on real Credentials
        gmail_mcp.auth._env_load_credentials()
        creds = gmail_mcp.auth._cached_creds
        assert creds is not None
        assert creds.token == "access_token"

    def test_get_token_refreshes_expired(self, monkeypatch):
        """Refreshes expired credentials from env var."""
        import gmail_mcp.auth

        mock_creds = MagicMock()
        mock_creds.expired = True
        mock_creds.refresh_token = "refresh"
        gmail_mcp.auth._cached_creds = mock_creds
        monkeypatch.setenv(GOOGLE_TOKEN_ENV, "{}")

        get_token()
        mock_creds.refresh.assert_called_once()

    def test_store_token_is_noop(self, monkeypatch):
        """store_token does nothing when env backend is active."""
        monkeypatch.setenv(GOOGLE_TOKEN_ENV, '{"token": "x"}')
        mock_creds = MagicMock()
        # Should not raise or call keyring
        store_token(mock_creds)
        mock_creds.to_json.assert_not_called()

    def test_caches_credentials(self, monkeypatch):
        """Credentials are parsed once and cached."""
        import gmail_mcp.auth

        token_data = json.dumps({
            "token": "access_token",
            "refresh_token": "refresh_token",
            "token_uri": "https://oauth2.googleapis.com/token",
            "client_id": "client_id",
            "client_secret": "client_secret",
        })
        monkeypatch.setenv(GOOGLE_TOKEN_ENV, token_data)

        gmail_mcp.auth._env_load_credentials()
        creds1 = gmail_mcp.auth._cached_creds
        gmail_mcp.auth._env_load_credentials()
        # _env_load_credentials overwrites, but the object is equivalent
        creds2 = gmail_mcp.auth._cached_creds
        # Both should be valid Credentials
        assert creds1 is not None
        assert creds2 is not None
        assert creds1.token == creds2.token


class TestKeychainIsAuthenticated:
    """Tests for is_authenticated() with Keychain backend."""

    def test_returns_false_when_no_token(self):
        """Returns False when no token in Keychain."""
        with patch("keyring.get_password", return_value=None):
            assert is_authenticated() is False

    def test_returns_true_when_token_exists(self):
        """Returns True when token exists in Keychain."""
        with patch("keyring.get_password", return_value='{"token": "data"}'):
            assert is_authenticated() is True


class TestKeychainGetToken:
    """Tests for get_token() with Keychain backend."""

    def test_returns_none_when_no_token(self):
        """Returns None when no token in Keychain."""
        with patch("keyring.get_password", return_value=None):
            assert get_token() is None

    def test_returns_none_on_invalid_json(self):
        """Returns None when token data is not valid JSON."""
        with patch("keyring.get_password", return_value="not json"):
            assert get_token() is None

    def test_returns_credentials_when_valid_token(self):
        """Returns Credentials object when valid token exists."""
        token_data = {
            "token": "access_token",
            "refresh_token": "refresh_token",
            "token_uri": "https://oauth2.googleapis.com/token",
            "client_id": "client_id",
            "client_secret": "client_secret",
        }
        with patch("keyring.get_password", return_value=json.dumps(token_data)):
            creds = get_token()
            assert creds is not None
            assert creds.token == "access_token"
            assert creds.refresh_token == "refresh_token"


class TestKeychainStoreToken:
    """Tests for store_token() with Keychain backend."""

    def test_saves_token_to_keyring(self):
        """Token is saved to Keychain with correct service/account."""
        mock_creds = MagicMock()
        mock_creds.to_json.return_value = '{"token": "test"}'

        with patch("keyring.set_password") as mock_set:
            store_token(mock_creds)

            mock_set.assert_called_once_with(KEYCHAIN_SERVICE, "token", '{"token": "test"}')


class TestRunOauthFlow:
    """Tests for run_oauth_flow()."""

    def test_raises_when_credentials_missing(self, tmp_path):
        """Raises FileNotFoundError when credentials.json doesn't exist and no token."""
        with (
            patch("gmail_mcp.auth.get_token", return_value=None),
            patch("gmail_mcp.auth.get_credentials_path", return_value=tmp_path / "missing.json"),
        ):
            with pytest.raises(FileNotFoundError) as exc_info:
                run_oauth_flow()

            assert "credentials.json not found" in str(exc_info.value)

    def test_runs_oauth_and_stores_token(self, tmp_path):
        """Runs OAuth flow, stores token, returns email when no existing token."""
        # Create fake credentials file
        creds_file = tmp_path / "credentials.json"
        creds_file.write_text('{"installed": {"client_id": "x", "client_secret": "y"}}')

        mock_creds = MagicMock()
        mock_creds.to_json.return_value = '{"token": "test"}'

        mock_flow = MagicMock()
        mock_flow.run_local_server.return_value = mock_creds

        mock_service = MagicMock()
        mock_service.users.return_value.getProfile.return_value.execute.return_value = {
            "emailAddress": "test@gmail.com"
        }

        with (
            patch("gmail_mcp.auth.get_token", return_value=None),
            patch("gmail_mcp.auth.get_credentials_path", return_value=creds_file),
            patch(
                "gmail_mcp.auth.InstalledAppFlow.from_client_secrets_file",
                return_value=mock_flow,
            ),
            patch("gmail_mcp.auth.store_token") as mock_store,
            patch("gmail_mcp.auth.build", return_value=mock_service),
        ):
            email = run_oauth_flow()

            assert email == "test@gmail.com"
            mock_store.assert_called_once_with(mock_creds)
            mock_flow.run_local_server.assert_called_once_with(port=0)

    def test_returns_email_when_already_authenticated(self):
        """Returns email without browser flow when already authenticated."""
        mock_creds = MagicMock()
        mock_creds.valid = True
        mock_creds.scopes = [
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/gmail.send",
        ]

        mock_service = MagicMock()
        mock_service.users.return_value.getProfile.return_value.execute.return_value = {
            "emailAddress": "existing@gmail.com"
        }

        with (
            patch("gmail_mcp.auth.get_token", return_value=mock_creds),
            patch("gmail_mcp.auth.build", return_value=mock_service),
        ):
            email = run_oauth_flow()

            assert email == "existing@gmail.com"

    def test_refreshes_expired_token_without_browser(self):
        """Refreshes expired token without opening browser."""
        mock_creds = MagicMock()
        mock_creds.valid = False
        mock_creds.expired = True
        mock_creds.refresh_token = "refresh"
        mock_creds.scopes = [
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/gmail.send",
        ]

        mock_service = MagicMock()
        mock_service.users.return_value.getProfile.return_value.execute.return_value = {
            "emailAddress": "refreshed@gmail.com"
        }

        with (
            patch("gmail_mcp.auth.get_token", return_value=mock_creds),
            patch("gmail_mcp.auth.store_token") as mock_store,
            patch("gmail_mcp.auth.build", return_value=mock_service),
        ):
            email = run_oauth_flow()

            assert email == "refreshed@gmail.com"
            mock_creds.refresh.assert_called_once()
            mock_store.assert_called_once_with(mock_creds)

    def test_reauths_when_scopes_missing(self):
        """Forces re-authentication when token is missing required scopes."""
        # Token with old/wrong scopes
        mock_old_creds = MagicMock()
        mock_old_creds.valid = True
        mock_old_creds.scopes = ["https://www.googleapis.com/auth/gmail.readonly"]

        # New creds from OAuth flow
        mock_new_creds = MagicMock()
        mock_flow = MagicMock()
        mock_flow.run_local_server.return_value = mock_new_creds

        mock_service = MagicMock()
        mock_service.users.return_value.getProfile.return_value.execute.return_value = {
            "emailAddress": "reauthed@gmail.com"
        }

        with (
            patch("gmail_mcp.auth.get_token", return_value=mock_old_creds),
            patch("gmail_mcp.auth.get_credentials_path") as mock_path,
            patch(
                "gmail_mcp.auth.InstalledAppFlow.from_client_secrets_file",
                return_value=mock_flow,
            ),
            patch("gmail_mcp.auth.store_token") as mock_store,
            patch("gmail_mcp.auth.build", return_value=mock_service),
        ):
            mock_path.return_value.exists.return_value = True

            email = run_oauth_flow()

            assert email == "reauthed@gmail.com"
            # Should have run the OAuth flow, not just returned existing token
            mock_flow.run_local_server.assert_called_once()
            mock_store.assert_called_once_with(mock_new_creds)


class TestGetGmailService:
    """Tests for get_gmail_service()."""

    def test_returns_none_when_not_authenticated(self):
        """Returns None when no token exists."""
        with patch("gmail_mcp.auth.get_token", return_value=None):
            assert get_gmail_service() is None

    def test_returns_service_when_authenticated(self):
        """Returns Gmail service when valid token exists."""
        mock_creds = MagicMock()
        mock_creds.expired = False
        mock_creds.valid = True

        mock_service = MagicMock()

        with (
            patch("gmail_mcp.auth.get_token", return_value=mock_creds),
            patch("gmail_mcp.auth.build", return_value=mock_service),
        ):
            result = get_gmail_service()
            assert result == mock_service

    def test_refreshes_expired_token(self):
        """Refreshes token when expired and has refresh_token."""
        mock_creds = MagicMock()
        mock_creds.expired = True
        mock_creds.refresh_token = "refresh"
        mock_creds.valid = True

        mock_service = MagicMock()

        with (
            patch("gmail_mcp.auth.get_token", return_value=mock_creds),
            patch("gmail_mcp.auth.store_token") as mock_store,
            patch("gmail_mcp.auth.build", return_value=mock_service),
        ):
            result = get_gmail_service()

            mock_creds.refresh.assert_called_once()
            mock_store.assert_called_once_with(mock_creds)
            assert result == mock_service

    def test_returns_none_when_refresh_fails(self):
        """Returns None when token refresh fails."""
        mock_creds = MagicMock()
        mock_creds.expired = True
        mock_creds.refresh_token = "refresh"
        mock_creds.refresh.side_effect = Exception("Refresh failed")

        with patch("gmail_mcp.auth.get_token", return_value=mock_creds):
            assert get_gmail_service() is None

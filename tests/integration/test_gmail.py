"""Integration tests for Gmail MCP server.

These tests require real Gmail credentials and will interact with
a real Gmail account. They are skipped in CI environments.

To run these tests locally:
1. Set up credentials.json in ~/.config/gmail-mcp/
2. Run: pytest tests/integration/ -v

The first run will open a browser for OAuth authentication.
"""

import os

import pytest

from gmail_mcp.auth import is_authenticated, run_oauth_flow
from gmail_mcp.config import get_credentials_path
from gmail_mcp.server import _authenticate, _list_emails

# Skip all tests in this module if running in CI or if credentials don't exist
pytestmark = pytest.mark.skipif(
    os.environ.get("CI") == "true",
    reason="Integration tests skipped in CI - requires real credentials",
)


@pytest.fixture(scope="module")
def ensure_credentials():
    """Check that credentials.json exists before running tests."""
    creds_path = get_credentials_path()
    if not creds_path.exists():
        pytest.skip(
            f"credentials.json not found at {creds_path}. "
            "Download from Google Cloud Console to run integration tests."
        )


@pytest.fixture(scope="module")
def ensure_authenticated(ensure_credentials):
    """Ensure we're authenticated before running tests that need it."""
    if not is_authenticated():
        pytest.skip(
            "Not authenticated. Run pytest tests/integration/test_gmail.py::"
            "test_authenticate_flow -v first."
        )


class TestAuthenticateFlow:
    """Tests for the authentication flow."""

    def test_authenticate_flow(self, ensure_credentials):
        """Test that OAuth flow works and saves token.

        This test will open a browser for authentication if not already authenticated.
        After successful auth, the token is stored in Keychain.
        """
        if is_authenticated():
            pytest.skip("Already authenticated - skipping OAuth flow test")

        # This will open browser for OAuth
        email = run_oauth_flow()

        assert email is not None
        assert "@" in email
        assert is_authenticated()
        domain = email.split("@", 1)[1] if "@" in email else "unknown domain"
        print(f"\n✓ Successfully authenticated (email domain: {domain})")


class TestAuthenticateTool:
    """Tests for the authenticate MCP tool."""

    @pytest.mark.asyncio
    async def test_authenticate_tool_returns_success(self, ensure_credentials):
        """Test authenticate tool returns success message."""
        if is_authenticated():
            # If already authenticated, this should still work (re-auth)
            pass

        result = await _authenticate()

        assert len(result) == 1
        # Should either succeed or already be authenticated
        assert "Successfully authenticated" in result[0].text or "Error" not in result[0].text


class TestListEmailsTool:
    """Tests for the list_emails MCP tool."""

    @pytest.mark.asyncio
    async def test_list_emails_without_auth_returns_error(self, ensure_credentials):
        """Test that list_emails returns error when not authenticated.

        Note: This test is tricky because if you're already authenticated,
        it will skip. To truly test this, you'd need to clear Keychain first.
        """
        if is_authenticated():
            pytest.skip("Already authenticated - can't test unauthenticated state")

        result = await _list_emails({})

        assert len(result) == 1
        assert "Not authenticated" in result[0].text

    @pytest.mark.asyncio
    async def test_list_emails_returns_results(self, ensure_authenticated):
        """Test that list_emails returns actual emails from Gmail."""
        result = await _list_emails({"max_results": 5})

        assert len(result) == 1
        text = result[0].text

        # Should either find emails or say no emails found
        assert "Found" in text or "No emails found" in text

        # If emails found, verify format
        if "Found" in text:
            assert "ID:" in text
            assert "From:" in text
            assert "Subject:" in text
            print(f"\n{text}")

    @pytest.mark.asyncio
    async def test_list_emails_respects_max_results(self, ensure_authenticated):
        """Test that max_results parameter is respected."""
        result = await _list_emails({"max_results": 3})

        assert len(result) == 1
        text = result[0].text

        if "Found" in text:
            # Count how many emails were returned (look for "ID:" occurrences)
            id_count = text.count("ID:")
            assert id_count <= 3

    @pytest.mark.asyncio
    async def test_list_emails_default_max_results(self, ensure_authenticated):
        """Test that default max_results (10) is used when not specified."""
        result = await _list_emails({})

        assert len(result) == 1
        text = result[0].text

        if "Found" in text:
            id_count = text.count("ID:")
            assert id_count <= 10

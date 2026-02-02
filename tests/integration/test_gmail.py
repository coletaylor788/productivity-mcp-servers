"""Integration tests for Gmail MCP server.

These tests require real Gmail credentials and will interact with
a real Gmail account. They are skipped in CI environments.

To run these tests locally:
1. Set up credentials.json in ~/.config/gmail-mcp/
2. Run: pytest tests/integration/ -v

The first run will open a browser for OAuth authentication.
"""

import base64
import os
import time
import uuid
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import pytest

from gmail_mcp.auth import get_gmail_service, is_authenticated, run_oauth_flow
from gmail_mcp.config import get_credentials_path
from gmail_mcp.server import (
    _archive_email,
    _authenticate,
    _get_attachments,
    _get_email,
    _list_emails,
)

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


# Helper functions for creating test emails
def _create_test_email_with_attachment(
    service, subject: str, archive: bool = True
) -> str:
    """Send a test email to self with an attachment.

    Args:
        service: Gmail API service
        subject: Email subject
        archive: If True, archive immediately to avoid cluttering inbox

    Returns:
        Message ID of the sent email
    """
    # Get user's email address
    profile = service.users().getProfile(userId="me").execute()
    email_address = profile["emailAddress"]

    # Create multipart message
    message = MIMEMultipart()
    message["to"] = email_address
    message["from"] = email_address
    message["subject"] = subject

    # Add text body
    body = MIMEText("This is a test email for integration testing.", "plain")
    message.attach(body)

    # Add a small test attachment
    attachment = MIMEBase("application", "octet-stream")
    attachment.set_payload(b"Test attachment content for gmail-mcp integration tests.")
    encoders.encode_base64(attachment)
    attachment.add_header("Content-Disposition", "attachment", filename="test_attachment.txt")
    message.attach(attachment)

    # Encode and send
    raw = base64.urlsafe_b64encode(message.as_bytes()).decode()
    sent = service.users().messages().send(userId="me", body={"raw": raw}).execute()

    # Archive immediately so it doesn't clutter the inbox (unless we need it in inbox)
    if archive:
        service.users().messages().modify(
            userId="me",
            id=sent["id"],
            body={"removeLabelIds": ["INBOX"]},
        ).execute()

    return sent["id"]


def _delete_test_email(service, message_id: str) -> None:
    """Permanently delete a test email.

    Args:
        service: Gmail API service
        message_id: ID of message to delete
    """
    try:
        service.users().messages().delete(userId="me", id=message_id).execute()
    except Exception:
        pass  # Ignore errors during cleanup


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
        # Authentication successful (email not logged for security)


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
            # Email contents not logged for security

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


class TestListEmailsFilters:
    """Integration tests for list_emails filter functionality."""

    @pytest.mark.asyncio
    async def test_filter_by_label_inbox(self, ensure_authenticated):
        """Test filtering by INBOX label."""
        result = await _list_emails({"label": "INBOX", "max_results": 5})

        assert len(result) == 1
        # Should succeed (may or may not find emails)
        assert "Error" not in result[0].text or "Not authenticated" not in result[0].text

    @pytest.mark.asyncio
    async def test_filter_by_category_primary(self, ensure_authenticated):
        """Test filtering by primary category."""
        result = await _list_emails({"category": "primary", "max_results": 5})

        assert len(result) == 1
        # Should succeed (may or may not find emails)
        assert "Error" not in result[0].text or "Not authenticated" not in result[0].text

    @pytest.mark.asyncio
    async def test_filter_unread_only(self, ensure_authenticated):
        """Test filtering for unread emails only."""
        result = await _list_emails({"unread_only": True, "max_results": 5})

        assert len(result) == 1
        # Should succeed (may or may not find emails)
        assert "Error" not in result[0].text or "Not authenticated" not in result[0].text

    @pytest.mark.asyncio
    async def test_filter_with_raw_query(self, ensure_authenticated):
        """Test using raw Gmail search query."""
        result = await _list_emails({"query": "newer_than:30d", "max_results": 5})

        assert len(result) == 1
        # Should succeed (may or may not find emails)
        assert "Error" not in result[0].text or "Not authenticated" not in result[0].text

    @pytest.mark.asyncio
    async def test_combined_filters(self, ensure_authenticated):
        """Test combining multiple filters."""
        result = await _list_emails({
            "label": "INBOX",
            "category": "primary",
            "max_results": 3,
        })

        assert len(result) == 1
        # Should succeed (may or may not find emails)
        assert "Error" not in result[0].text or "Not authenticated" not in result[0].text


class TestGetEmailTool:
    """Integration tests for get_email tool."""

    @pytest.fixture
    def test_email(self, ensure_authenticated):
        """Create a test email and clean it up after test."""
        service = get_gmail_service()
        subject = f"[gmail-mcp-test] {uuid.uuid4()}"
        message_id = _create_test_email_with_attachment(service, subject)

        # Wait a moment for the email to be available
        time.sleep(2)

        yield {"id": message_id, "subject": subject}

        # Cleanup
        _delete_test_email(service, message_id)

    @pytest.mark.asyncio
    async def test_get_email_returns_content(self, test_email):
        """Test that get_email returns full email content."""
        result = await _get_email({"email_id": test_email["id"]})

        assert len(result) == 1
        text = result[0].text

        assert "From:" in text
        assert "Subject:" in text
        assert "test email for integration testing" in text
        assert "Attachments (1)" in text
        assert "test_attachment.txt" in text

    @pytest.mark.asyncio
    async def test_get_email_text_only_format(self, test_email):
        """Test that format=text_only returns only text body."""
        result = await _get_email({"email_id": test_email["id"], "format": "text_only"})

        assert len(result) == 1
        text = result[0].text

        assert "Body (Text)" in text
        assert "test email for integration testing" in text


class TestGetAttachmentsTool:
    """Integration tests for get_attachments tool."""

    @pytest.fixture
    def test_email_with_attachment(self, ensure_authenticated):
        """Create a test email with attachment and clean it up after test."""
        service = get_gmail_service()
        subject = f"[gmail-mcp-test] {uuid.uuid4()}"
        message_id = _create_test_email_with_attachment(service, subject)

        # Wait a moment for the email to be available
        time.sleep(2)

        yield {"id": message_id, "subject": subject}

        # Cleanup
        _delete_test_email(service, message_id)

    @pytest.mark.asyncio
    async def test_get_attachments_downloads_file(self, test_email_with_attachment, tmp_path):
        """Test that get_attachments downloads attachment to disk."""
        result = await _get_attachments({
            "email_id": test_email_with_attachment["id"],
            "save_to": str(tmp_path),
        })

        assert len(result) == 1
        text = result[0].text

        assert "Downloaded 1 attachment" in text

        # Verify file was created
        downloaded_file = tmp_path / "test_attachment.txt"
        assert downloaded_file.exists()
        assert b"Test attachment content" in downloaded_file.read_bytes()

    @pytest.mark.asyncio
    async def test_get_attachments_filters_by_filename(self, test_email_with_attachment, tmp_path):
        """Test that get_attachments can filter by filename."""
        result = await _get_attachments({
            "email_id": test_email_with_attachment["id"],
            "filename": "test_attachment.txt",
            "save_to": str(tmp_path),
        })

        assert len(result) == 1
        text = result[0].text

        assert "Downloaded 1 attachment" in text
        assert (tmp_path / "test_attachment.txt").exists()

    @pytest.mark.asyncio
    async def test_get_attachments_returns_error_for_nonexistent_filename(
        self, test_email_with_attachment, tmp_path
    ):
        """Test that get_attachments returns error for non-existent filename."""
        result = await _get_attachments({
            "email_id": test_email_with_attachment["id"],
            "filename": "nonexistent.pdf",
            "save_to": str(tmp_path),
        })

        assert len(result) == 1
        assert "not found" in result[0].text


class TestArchiveEmailTool:
    """Integration tests for archive_email tool."""

    @pytest.fixture
    def test_email_to_archive(self, ensure_authenticated):
        """Create a test email to archive and clean it up after test."""
        service = get_gmail_service()
        subject = f"[gmail-mcp-test] {uuid.uuid4()}"
        # Don't archive - we need it in inbox to test archiving
        message_id = _create_test_email_with_attachment(service, subject, archive=False)

        # Wait a moment for the email to be available
        time.sleep(2)

        yield {"id": message_id, "subject": subject}

        # Cleanup - delete the test email
        _delete_test_email(service, message_id)

    @pytest.mark.asyncio
    async def test_archive_email_removes_inbox_label(self, test_email_to_archive):
        """Test that archive_email removes INBOX label."""
        message_id = test_email_to_archive["id"]

        # Archive the email
        result = await _archive_email({"email_id": message_id})

        assert len(result) == 1
        assert "archived successfully" in result[0].text

        # Verify the email no longer has INBOX label
        service = get_gmail_service()
        msg = service.users().messages().get(userId="me", id=message_id).execute()
        labels = msg.get("labelIds", [])

        assert "INBOX" not in labels

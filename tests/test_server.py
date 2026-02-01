"""Unit tests for server module."""

from unittest.mock import MagicMock, patch

import pytest

from gmail_mcp.server import _authenticate, _list_emails


class TestAuthenticate:
    """Tests for authenticate tool."""

    @pytest.mark.asyncio
    async def test_returns_success_message(self):
        """Returns success message with email on successful auth."""
        with patch("gmail_mcp.server.run_oauth_flow", return_value="test@gmail.com"):
            result = await _authenticate()

            assert len(result) == 1
            assert "Successfully authenticated as test@gmail.com" in result[0].text

    @pytest.mark.asyncio
    async def test_returns_error_when_credentials_missing(self):
        """Returns error message when credentials.json is missing."""
        with patch(
            "gmail_mcp.server.run_oauth_flow",
            side_effect=FileNotFoundError("credentials.json not found"),
        ):
            result = await _authenticate()

            assert len(result) == 1
            assert "credentials.json not found" in result[0].text

    @pytest.mark.asyncio
    async def test_returns_error_on_exception(self):
        """Returns error message on unexpected exception."""
        with patch("gmail_mcp.server.run_oauth_flow", side_effect=Exception("OAuth failed")):
            result = await _authenticate()

            assert len(result) == 1
            assert "Error during authentication" in result[0].text


class TestListEmails:
    """Tests for list_emails tool."""

    @pytest.mark.asyncio
    async def test_returns_error_when_not_authenticated(self):
        """Returns error prompting authentication when not authenticated."""
        with patch("gmail_mcp.server.is_authenticated", return_value=False):
            result = await _list_emails({})

            assert len(result) == 1
            assert "Not authenticated" in result[0].text
            assert "authenticate" in result[0].text

    @pytest.mark.asyncio
    async def test_returns_error_when_service_unavailable(self):
        """Returns error when Gmail service can't be obtained."""
        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=None),
        ):
            result = await _list_emails({})

            assert len(result) == 1
            assert "Failed to connect" in result[0].text

    @pytest.mark.asyncio
    async def test_returns_no_emails_message(self):
        """Returns message when no emails found."""
        mock_service = MagicMock()
        mock_list = mock_service.users.return_value.messages.return_value.list
        mock_list.return_value.execute.return_value = {"messages": []}

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            result = await _list_emails({})

            assert len(result) == 1
            assert "No emails found" in result[0].text

    @pytest.mark.asyncio
    async def test_returns_formatted_emails(self):
        """Returns formatted list of emails."""
        mock_service = MagicMock()
        mock_list = mock_service.users.return_value.messages.return_value.list
        mock_list.return_value.execute.return_value = {"messages": [{"id": "msg1"}]}
        mock_get = mock_service.users.return_value.messages.return_value.get
        mock_get.return_value.execute.return_value = {
            "payload": {
                "headers": [
                    {"name": "From", "value": "sender@example.com"},
                    {"name": "Subject", "value": "Test Subject"},
                    {"name": "Date", "value": "2026-02-01"},
                ]
            },
            "snippet": "This is a test email snippet",
        }

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            result = await _list_emails({"max_results": 5})

            assert len(result) == 1
            text = result[0].text
            assert "Found 1 emails" in text
            assert "sender@example.com" in text
            assert "Test Subject" in text
            assert "This is a test email" in text

    @pytest.mark.asyncio
    async def test_respects_max_results_limit(self):
        """Caps max_results at 50."""
        mock_service = MagicMock()
        mock_list = mock_service.users.return_value.messages.return_value.list
        mock_list.return_value.execute.return_value = {"messages": []}

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            await _list_emails({"max_results": 100})

            # Verify the API was called with max 50
            call_args = mock_service.users.return_value.messages.return_value.list.call_args
            assert call_args.kwargs["maxResults"] == 50

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


class TestListEmailsFilters:
    """Tests for list_emails filter functionality."""

    @pytest.mark.asyncio
    async def test_label_filter_uses_label_ids_for_system_labels(self):
        """System labels (INBOX, SENT, etc.) use labelIds parameter."""
        mock_service = MagicMock()
        mock_list = mock_service.users.return_value.messages.return_value.list
        mock_list.return_value.execute.return_value = {"messages": []}

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            await _list_emails({"label": "INBOX"})

            call_args = mock_list.call_args
            assert "labelIds" in call_args.kwargs
            assert "INBOX" in call_args.kwargs["labelIds"]

    @pytest.mark.asyncio
    async def test_label_filter_case_insensitive(self):
        """Label filter is case-insensitive for system labels."""
        mock_service = MagicMock()
        mock_list = mock_service.users.return_value.messages.return_value.list
        mock_list.return_value.execute.return_value = {"messages": []}

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            await _list_emails({"label": "inbox"})

            call_args = mock_list.call_args
            assert "INBOX" in call_args.kwargs["labelIds"]

    @pytest.mark.asyncio
    async def test_custom_label_uses_query(self):
        """Custom labels use the query parameter."""
        mock_service = MagicMock()
        mock_list = mock_service.users.return_value.messages.return_value.list
        mock_list.return_value.execute.return_value = {"messages": []}

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            await _list_emails({"label": "MyCustomLabel"})

            call_args = mock_list.call_args
            assert "q" in call_args.kwargs
            assert "label:MyCustomLabel" in call_args.kwargs["q"]

    @pytest.mark.asyncio
    async def test_category_filter_adds_to_query(self):
        """Category filter adds category:{name} to query."""
        mock_service = MagicMock()
        mock_list = mock_service.users.return_value.messages.return_value.list
        mock_list.return_value.execute.return_value = {"messages": []}

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            await _list_emails({"category": "primary"})

            call_args = mock_list.call_args
            assert "q" in call_args.kwargs
            assert "category:primary" in call_args.kwargs["q"]

    @pytest.mark.asyncio
    async def test_unread_only_filter_adds_to_query(self):
        """unread_only filter adds is:unread to query."""
        mock_service = MagicMock()
        mock_list = mock_service.users.return_value.messages.return_value.list
        mock_list.return_value.execute.return_value = {"messages": []}

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            await _list_emails({"unread_only": True})

            call_args = mock_list.call_args
            assert "q" in call_args.kwargs
            assert "is:unread" in call_args.kwargs["q"]

    @pytest.mark.asyncio
    async def test_raw_query_passed_through(self):
        """Raw query parameter is passed through to API."""
        mock_service = MagicMock()
        mock_list = mock_service.users.return_value.messages.return_value.list
        mock_list.return_value.execute.return_value = {"messages": []}

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            await _list_emails({"query": "from:boss@example.com newer_than:7d"})

            call_args = mock_list.call_args
            assert "q" in call_args.kwargs
            assert "from:boss@example.com newer_than:7d" in call_args.kwargs["q"]

    @pytest.mark.asyncio
    async def test_filters_combine_with_and_logic(self):
        """Multiple filters combine with AND logic (space-separated)."""
        mock_service = MagicMock()
        mock_list = mock_service.users.return_value.messages.return_value.list
        mock_list.return_value.execute.return_value = {"messages": []}

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            await _list_emails({
                "category": "primary",
                "unread_only": True,
                "query": "has:attachment",
            })

            call_args = mock_list.call_args
            query = call_args.kwargs["q"]
            assert "category:primary" in query
            assert "is:unread" in query
            assert "has:attachment" in query

    @pytest.mark.asyncio
    async def test_label_and_query_combine(self):
        """System label (labelIds) and query can combine."""
        mock_service = MagicMock()
        mock_list = mock_service.users.return_value.messages.return_value.list
        mock_list.return_value.execute.return_value = {"messages": []}

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            await _list_emails({
                "label": "INBOX",
                "unread_only": True,
            })

            call_args = mock_list.call_args
            assert "INBOX" in call_args.kwargs["labelIds"]
            assert "is:unread" in call_args.kwargs["q"]

    @pytest.mark.asyncio
    async def test_no_filters_no_query(self):
        """When no filters provided, no query parameter is set."""
        mock_service = MagicMock()
        mock_list = mock_service.users.return_value.messages.return_value.list
        mock_list.return_value.execute.return_value = {"messages": []}

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            await _list_emails({})

            call_args = mock_list.call_args
            assert "q" not in call_args.kwargs or call_args.kwargs.get("q") is None

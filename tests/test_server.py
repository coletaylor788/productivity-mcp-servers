"""Unit tests for server module."""

from unittest.mock import MagicMock, patch

import pytest

from gmail_mcp.server import (
    _archive_email,
    _authenticate,
    _extract_body_parts,
    _get_attachments,
    _get_email,
    _list_emails,
    _sanitize_filename,
)


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


class TestExtractBodyParts:
    """Tests for _extract_body_parts helper."""

    def test_extracts_text_body(self):
        """Extracts plain text body from simple message."""
        import base64
        body_content = "Hello world"
        encoded = base64.urlsafe_b64encode(body_content.encode()).decode()

        payload = {
            "mimeType": "text/plain",
            "body": {"data": encoded},
        }

        text, html, attachments = _extract_body_parts(payload)

        assert text == "Hello world"
        assert html is None
        assert attachments == []

    def test_extracts_html_body(self):
        """Extracts HTML body from simple message."""
        import base64
        body_content = "<html><body>Hello</body></html>"
        encoded = base64.urlsafe_b64encode(body_content.encode()).decode()

        payload = {
            "mimeType": "text/html",
            "body": {"data": encoded},
        }

        text, html, attachments = _extract_body_parts(payload)

        assert text is None
        assert html == "<html><body>Hello</body></html>"
        assert attachments == []

    def test_extracts_multipart_content(self):
        """Extracts text and HTML from multipart message."""
        import base64
        text_content = "Plain text"
        html_content = "<p>HTML</p>"

        payload = {
            "mimeType": "multipart/alternative",
            "parts": [
                {
                    "mimeType": "text/plain",
                    "body": {"data": base64.urlsafe_b64encode(text_content.encode()).decode()},
                },
                {
                    "mimeType": "text/html",
                    "body": {"data": base64.urlsafe_b64encode(html_content.encode()).decode()},
                },
            ],
        }

        text, html, attachments = _extract_body_parts(payload)

        assert text == "Plain text"
        assert html == "<p>HTML</p>"

    def test_extracts_attachments(self):
        """Extracts attachment metadata from message."""
        payload = {
            "mimeType": "multipart/mixed",
            "parts": [
                {
                    "mimeType": "text/plain",
                    "body": {"data": "SGVsbG8="},  # "Hello"
                },
                {
                    "mimeType": "application/pdf",
                    "filename": "document.pdf",
                    "body": {"attachmentId": "att123", "size": 1024},
                },
            ],
        }

        text, html, attachments = _extract_body_parts(payload)

        assert len(attachments) == 1
        assert attachments[0]["id"] == "att123"
        assert attachments[0]["filename"] == "document.pdf"
        assert attachments[0]["mimeType"] == "application/pdf"
        assert attachments[0]["size"] == 1024


class TestSanitizeFilename:
    """Tests for _sanitize_filename helper."""

    def test_removes_path_separators(self):
        """Removes forward and back slashes."""
        assert _sanitize_filename("path/to/file.txt") == "path_to_file.txt"
        assert _sanitize_filename("path\\to\\file.txt") == "path_to_file.txt"

    def test_removes_special_characters(self):
        """Removes characters that are invalid on some filesystems."""
        assert _sanitize_filename('file<>:"|?*.txt') == "file_______.txt"

    def test_handles_empty_filename(self):
        """Returns default for empty filename."""
        assert _sanitize_filename("") == "attachment"

    def test_handles_dot_prefix(self):
        """Handles filenames starting with dot."""
        assert _sanitize_filename(".hidden") == "attachment.hidden"

    def test_truncates_long_filenames(self):
        """Truncates very long filenames."""
        long_name = "a" * 300 + ".txt"
        result = _sanitize_filename(long_name)
        assert len(result) <= 255


class TestGetEmail:
    """Tests for get_email tool."""

    @pytest.mark.asyncio
    async def test_returns_error_when_not_authenticated(self):
        """Returns error when not authenticated."""
        with patch("gmail_mcp.server.is_authenticated", return_value=False):
            result = await _get_email({"email_id": "123"})
            assert "Not authenticated" in result[0].text

    @pytest.mark.asyncio
    async def test_returns_error_when_email_id_missing(self):
        """Returns error when email_id not provided."""
        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=MagicMock()),
        ):
            result = await _get_email({})
            assert "email_id is required" in result[0].text

    @pytest.mark.asyncio
    async def test_returns_full_email_content(self):
        """Returns formatted email with headers and body."""
        import base64
        body_text = "Test email body"
        encoded_body = base64.urlsafe_b64encode(body_text.encode()).decode()

        mock_service = MagicMock()
        mock_get = mock_service.users.return_value.messages.return_value.get
        mock_get.return_value.execute.return_value = {
            "payload": {
                "mimeType": "text/plain",
                "headers": [
                    {"name": "From", "value": "sender@test.com"},
                    {"name": "To", "value": "recipient@test.com"},
                    {"name": "Subject", "value": "Test Subject"},
                    {"name": "Date", "value": "2026-02-01"},
                ],
                "body": {"data": encoded_body},
            },
        }

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            result = await _get_email({"email_id": "123"})

            assert "From: sender@test.com" in result[0].text
            assert "Subject: Test Subject" in result[0].text
            assert "Test email body" in result[0].text

    @pytest.mark.asyncio
    async def test_text_only_format(self):
        """Returns only text body when format is text_only."""
        import base64
        text_body = "Plain text"
        html_body = "<p>HTML</p>"

        mock_service = MagicMock()
        mock_get = mock_service.users.return_value.messages.return_value.get
        text_encoded = base64.urlsafe_b64encode(text_body.encode()).decode()
        html_encoded = base64.urlsafe_b64encode(html_body.encode()).decode()
        mock_get.return_value.execute.return_value = {
            "payload": {
                "mimeType": "multipart/alternative",
                "headers": [{"name": "From", "value": "test@test.com"}],
                "parts": [
                    {"mimeType": "text/plain", "body": {"data": text_encoded}},
                    {"mimeType": "text/html", "body": {"data": html_encoded}},
                ],
            },
        }

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            result = await _get_email({"email_id": "123", "format": "text_only"})

            assert "Plain text" in result[0].text
            assert "<p>HTML</p>" not in result[0].text


class TestGetAttachments:
    """Tests for get_attachments tool."""

    @pytest.mark.asyncio
    async def test_returns_error_when_not_authenticated(self):
        """Returns error when not authenticated."""
        with patch("gmail_mcp.server.is_authenticated", return_value=False):
            result = await _get_attachments({"email_id": "123"})
            assert "Not authenticated" in result[0].text

    @pytest.mark.asyncio
    async def test_returns_error_when_email_id_missing(self):
        """Returns error when email_id not provided."""
        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=MagicMock()),
        ):
            result = await _get_attachments({})
            assert "email_id is required" in result[0].text

    @pytest.mark.asyncio
    async def test_returns_no_attachments_message(self):
        """Returns message when email has no attachments."""
        mock_service = MagicMock()
        mock_get = mock_service.users.return_value.messages.return_value.get
        mock_get.return_value.execute.return_value = {
            "payload": {
                "mimeType": "text/plain",
                "body": {"data": "SGVsbG8="},  # "Hello"
            },
        }

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            result = await _get_attachments({"email_id": "123"})
            assert "No attachments found" in result[0].text

    @pytest.mark.asyncio
    async def test_downloads_attachments_to_directory(self, tmp_path):
        """Downloads attachments and saves to specified directory."""
        import base64
        file_content = b"PDF content here"
        encoded_content = base64.urlsafe_b64encode(file_content).decode()

        mock_service = MagicMock()
        mock_get = mock_service.users.return_value.messages.return_value.get
        mock_get.return_value.execute.return_value = {
            "payload": {
                "mimeType": "multipart/mixed",
                "parts": [
                    {
                        "mimeType": "application/pdf",
                        "filename": "test.pdf",
                        "body": {"attachmentId": "att123", "size": 100},
                    },
                ],
            },
        }

        mock_att = mock_service.users.return_value.messages.return_value.attachments
        mock_att_get = mock_att.return_value.get
        mock_att_get.return_value.execute.return_value = {"data": encoded_content}

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            result = await _get_attachments({
                "email_id": "123",
                "save_to": str(tmp_path),
            })

            assert "Downloaded 1 attachment" in result[0].text
            assert (tmp_path / "test.pdf").exists()
            assert (tmp_path / "test.pdf").read_bytes() == file_content

    @pytest.mark.asyncio
    async def test_filters_by_filename(self, tmp_path):
        """Downloads only the attachment matching the filename filter."""
        import base64
        txt_content = b"Text content"

        mock_service = MagicMock()
        mock_get = mock_service.users.return_value.messages.return_value.get
        mock_get.return_value.execute.return_value = {
            "payload": {
                "mimeType": "multipart/mixed",
                "parts": [
                    {
                        "mimeType": "application/pdf",
                        "filename": "document.pdf",
                        "body": {"attachmentId": "att1", "size": 100},
                    },
                    {
                        "mimeType": "text/plain",
                        "filename": "notes.txt",
                        "body": {"attachmentId": "att2", "size": 50},
                    },
                ],
            },
        }

        mock_att = mock_service.users.return_value.messages.return_value.attachments
        mock_att_get = mock_att.return_value.get
        # Return txt content when requested
        mock_att_get.return_value.execute.return_value = {
            "data": base64.urlsafe_b64encode(txt_content).decode()
        }

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            result = await _get_attachments({
                "email_id": "123",
                "filename": "notes.txt",
                "save_to": str(tmp_path),
            })

            assert "Downloaded 1 attachment" in result[0].text
            assert (tmp_path / "notes.txt").exists()
            # PDF should NOT be downloaded
            assert not (tmp_path / "document.pdf").exists()

    @pytest.mark.asyncio
    async def test_returns_error_when_filename_not_found(self, tmp_path):
        """Returns error when specified filename doesn't exist."""
        mock_service = MagicMock()
        mock_get = mock_service.users.return_value.messages.return_value.get
        mock_get.return_value.execute.return_value = {
            "payload": {
                "mimeType": "multipart/mixed",
                "parts": [
                    {
                        "mimeType": "application/pdf",
                        "filename": "document.pdf",
                        "body": {"attachmentId": "att1", "size": 100},
                    },
                ],
            },
        }

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            result = await _get_attachments({
                "email_id": "123",
                "filename": "nonexistent.txt",
                "save_to": str(tmp_path),
            })

            assert "Attachment 'nonexistent.txt' not found" in result[0].text


class TestArchiveEmail:
    """Tests for archive_email tool."""

    @pytest.mark.asyncio
    async def test_returns_error_when_not_authenticated(self):
        """Returns error when not authenticated."""
        with patch("gmail_mcp.server.is_authenticated", return_value=False):
            result = await _archive_email({"email_ids": ["123"]})
            assert "Not authenticated" in result[0].text

    @pytest.mark.asyncio
    async def test_returns_error_when_email_ids_missing(self):
        """Returns error when email_ids not provided."""
        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=MagicMock()),
        ):
            result = await _archive_email({})
            assert "email_ids is required" in result[0].text

    @pytest.mark.asyncio
    async def test_archives_single_email_successfully(self):
        """Archives a single email by removing INBOX label."""
        mock_service = MagicMock()
        mock_modify = mock_service.users.return_value.messages.return_value.modify
        mock_modify.return_value.execute.return_value = {}

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            result = await _archive_email({"email_ids": ["123"]})

            assert "Archived 1 email(s)" in result[0].text
            mock_modify.assert_called_once_with(
                userId="me",
                id="123",
                body={"removeLabelIds": ["INBOX"]},
            )

    @pytest.mark.asyncio
    async def test_archives_multiple_emails_successfully(self):
        """Archives multiple emails in a single call."""
        mock_service = MagicMock()
        mock_modify = mock_service.users.return_value.messages.return_value.modify
        mock_modify.return_value.execute.return_value = {}

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            result = await _archive_email({"email_ids": ["123", "456", "789"]})

            assert "Archived 3 email(s)" in result[0].text
            assert mock_modify.call_count == 3

    @pytest.mark.asyncio
    async def test_reports_partial_failures(self):
        """Reports both successes and failures when some emails fail."""
        mock_service = MagicMock()
        mock_modify = mock_service.users.return_value.messages.return_value.modify

        # First call succeeds, second fails, third succeeds
        mock_modify.return_value.execute.side_effect = [
            {},
            Exception("Not found"),
            {},
        ]

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            result = await _archive_email({"email_ids": ["123", "456", "789"]})

            assert "Archived 2 email(s)" in result[0].text
            assert "Failed to archive 1 email(s)" in result[0].text
            assert "456: Not found" in result[0].text

    @pytest.mark.asyncio
    async def test_returns_error_when_all_fail(self):
        """Reports all failures when every email fails."""
        mock_service = MagicMock()
        mock_modify = mock_service.users.return_value.messages.return_value.modify
        mock_modify.return_value.execute.side_effect = Exception("API error")

        with (
            patch("gmail_mcp.server.is_authenticated", return_value=True),
            patch("gmail_mcp.server.get_gmail_service", return_value=mock_service),
        ):
            result = await _archive_email({"email_ids": ["123", "456"]})

            assert "Failed to archive 2 email(s)" in result[0].text
            assert "123: API error" in result[0].text
            assert "456: API error" in result[0].text

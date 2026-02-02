"""Gmail MCP Server implementation."""

import asyncio
import base64
import os
import re
from pathlib import Path
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from .auth import get_gmail_service, is_authenticated, run_oauth_flow

# Initialize MCP server
server = Server("gmail-mcp")


@server.list_tools()
async def list_tools() -> list[Tool]:
    """List available Gmail tools."""
    return [
        Tool(
            name="authenticate",
            description="Authenticate with Gmail. Opens browser for OAuth login.",
            inputSchema={
                "type": "object",
                "properties": {},
            },
        ),
        Tool(
            name="list_emails",
            description=(
                "List emails from Gmail with optional filters. "
                "Use 'query' for advanced Gmail search syntax."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "max_results": {
                        "type": "integer",
                        "description": (
                            "Maximum number of emails to return (default: 10, max: 50)"
                        ),
                        "default": 10,
                    },
                    "label": {
                        "type": "string",
                        "description": (
                            "Filter by Gmail label: INBOX, SENT, DRAFTS, SPAM, TRASH, "
                            "STARRED, IMPORTANT, or custom label name"
                        ),
                    },
                    "category": {
                        "type": "string",
                        "enum": ["primary", "social", "promotions", "updates", "forums"],
                        "description": "Filter by Gmail category tab",
                    },
                    "unread_only": {
                        "type": "boolean",
                        "description": "Only return unread emails",
                        "default": False,
                    },
                    "query": {
                        "type": "string",
                        "description": (
                            "Raw Gmail search query. Examples: 'from:sender@example.com', "
                            "'subject:meeting', 'has:attachment', 'newer_than:7d'"
                        ),
                    },
                },
            },
        ),
        Tool(
            name="get_email",
            description="Get the full contents of an email by ID.",
            inputSchema={
                "type": "object",
                "properties": {
                    "email_id": {
                        "type": "string",
                        "description": "The email ID (from list_emails)",
                    },
                    "format": {
                        "type": "string",
                        "enum": ["full", "text_only", "html_only"],
                        "description": "Response format (default: full)",
                        "default": "full",
                    },
                },
                "required": ["email_id"],
            },
        ),
        Tool(
            name="get_attachments",
            description="Download attachments from an email.",
            inputSchema={
                "type": "object",
                "properties": {
                    "email_id": {
                        "type": "string",
                        "description": "The email ID (from list_emails)",
                    },
                    "filename": {
                        "type": "string",
                        "description": (
                            "Specific attachment filename to download "
                            "(downloads all if omitted)"
                        ),
                    },
                    "save_to": {
                        "type": "string",
                        "description": "Directory to save files (default: ~/Downloads)",
                    },
                },
                "required": ["email_id"],
            },
        ),
        Tool(
            name="archive_email",
            description="Archive one or more emails (remove from inbox, keep in All Mail).",
            inputSchema={
                "type": "object",
                "properties": {
                    "email_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Array of email IDs to archive",
                    },
                },
                "required": ["email_ids"],
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    """Handle tool calls."""
    if name == "authenticate":
        return await _authenticate()
    elif name == "list_emails":
        return await _list_emails(arguments)
    elif name == "get_email":
        return await _get_email(arguments)
    elif name == "get_attachments":
        return await _get_attachments(arguments)
    elif name == "archive_email":
        return await _archive_email(arguments)
    else:
        raise ValueError(f"Unknown tool: {name}")


async def _authenticate() -> list[TextContent]:
    """Handle authenticate tool call."""
    try:
        email = run_oauth_flow()
        return [
            TextContent(
                type="text",
                text=f"Successfully authenticated as {email}\nGmail MCP is ready to use.",
            )
        ]
    except FileNotFoundError as e:
        return [TextContent(type="text", text=f"Error: {e}")]
    except Exception as e:
        return [TextContent(type="text", text=f"Error during authentication: {e}")]


async def _list_emails(arguments: dict[str, Any]) -> list[TextContent]:
    """Handle list_emails tool call."""
    if not is_authenticated():
        return [
            TextContent(
                type="text",
                text="Error: Not authenticated. Please call the 'authenticate' tool first.",
            )
        ]

    service = get_gmail_service()
    if not service:
        return [
            TextContent(
                type="text",
                text="Error: Failed to connect to Gmail. Please re-authenticate.",
            )
        ]

    max_results = min(arguments.get("max_results", 10), 50)

    # Build query string from filters
    query_parts = []
    label_ids = []

    # Handle label filter
    label = arguments.get("label")
    if label:
        # System labels can be used directly as labelIds
        system_labels = [
            "INBOX", "SENT", "DRAFTS", "SPAM", "TRASH",
            "STARRED", "IMPORTANT", "UNREAD",
        ]
        if label.upper() in system_labels:
            label_ids.append(label.upper())
        else:
            # Custom labels need to use label: query syntax
            query_parts.append(f"label:{label}")

    # Handle category filter
    category = arguments.get("category")
    if category:
        query_parts.append(f"category:{category}")

    # Handle unread_only filter
    if arguments.get("unread_only"):
        query_parts.append("is:unread")

    # Handle raw query
    raw_query = arguments.get("query")
    if raw_query:
        query_parts.append(raw_query)

    # Combine query parts
    query = " ".join(query_parts) if query_parts else None

    try:
        # Build API request
        request_kwargs = {"userId": "me", "maxResults": max_results}
        if label_ids:
            request_kwargs["labelIds"] = label_ids
        if query:
            request_kwargs["q"] = query

        results = service.users().messages().list(**request_kwargs).execute()

        messages = results.get("messages", [])
        if not messages:
            return [TextContent(type="text", text="No emails found.")]

        output = [f"Found {len(messages)} emails:\n"]

        for i, msg in enumerate(messages, 1):
            msg_data = (
                service.users()
                .messages()
                .get(userId="me", id=msg["id"], format="metadata")
                .execute()
            )
            headers = {h["name"]: h["value"] for h in msg_data["payload"]["headers"]}
            snippet = msg_data.get("snippet", "")

            output.append(
                f"{i}. ID: {msg['id']}\n"
                f"   From: {headers.get('From', 'Unknown')}\n"
                f"   Subject: {headers.get('Subject', 'No Subject')}\n"
                f"   Date: {headers.get('Date', 'Unknown')}\n"
                f"   Snippet: {snippet[:100]}{'...' if len(snippet) > 100 else ''}\n"
            )

        return [TextContent(type="text", text="\n".join(output))]

    except Exception as e:
        return [TextContent(type="text", text=f"Error listing emails: {e}")]


def _extract_body_parts(payload: dict) -> tuple[str | None, str | None, list[dict]]:
    """Extract text, HTML body, and attachments from email payload.

    Args:
        payload: Gmail API message payload

    Returns:
        Tuple of (text_body, html_body, attachments_list)
    """
    text_body = None
    html_body = None
    attachments = []

    def process_part(part: dict) -> None:
        nonlocal text_body, html_body
        mime_type = part.get("mimeType", "")
        filename = part.get("filename", "")

        # Check if this part is an attachment
        if filename and part.get("body", {}).get("attachmentId"):
            attachments.append({
                "id": part["body"]["attachmentId"],
                "filename": filename,
                "mimeType": mime_type,
                "size": part["body"].get("size", 0),
            })
            return

        # Extract body content
        if mime_type == "text/plain" and not text_body:
            body_data = part.get("body", {}).get("data")
            if body_data:
                text_body = base64.urlsafe_b64decode(body_data).decode("utf-8")
        elif mime_type == "text/html" and not html_body:
            body_data = part.get("body", {}).get("data")
            if body_data:
                html_body = base64.urlsafe_b64decode(body_data).decode("utf-8")

        # Recursively process multipart content
        if "parts" in part:
            for subpart in part["parts"]:
                process_part(subpart)

    # Process the payload (may be single part or multipart)
    process_part(payload)

    return text_body, html_body, attachments


async def _get_email(arguments: dict[str, Any]) -> list[TextContent]:
    """Handle get_email tool call."""
    if not is_authenticated():
        return [
            TextContent(
                type="text",
                text="Error: Not authenticated. Please call the 'authenticate' tool first.",
            )
        ]

    service = get_gmail_service()
    if not service:
        return [
            TextContent(
                type="text",
                text="Error: Failed to connect to Gmail. Please re-authenticate.",
            )
        ]

    email_id = arguments.get("email_id")
    if not email_id:
        return [TextContent(type="text", text="Error: email_id is required.")]

    format_type = arguments.get("format", "full")

    try:
        msg = (
            service.users()
            .messages()
            .get(userId="me", id=email_id, format="full")
            .execute()
        )

        headers = {h["name"]: h["value"] for h in msg["payload"]["headers"]}
        text_body, html_body, attachments = _extract_body_parts(msg["payload"])

        # Build output
        output = [
            f"From: {headers.get('From', 'Unknown')}",
            f"To: {headers.get('To', 'Unknown')}",
            f"Subject: {headers.get('Subject', 'No Subject')}",
            f"Date: {headers.get('Date', 'Unknown')}",
            "",
        ]

        # Add body based on format
        if format_type == "text_only":
            if text_body:
                output.append("--- Body (Text) ---")
                output.append(text_body)
            else:
                output.append("(No plain text body available)")
        elif format_type == "html_only":
            if html_body:
                output.append("--- Body (HTML) ---")
                output.append(html_body)
            else:
                output.append("(No HTML body available)")
        else:  # full
            if text_body:
                output.append("--- Body (Text) ---")
                output.append(text_body)
            if html_body:
                output.append("")
                output.append("--- Body (HTML) ---")
                output.append(html_body)
            if not text_body and not html_body:
                output.append("(No body content available)")

        # Add attachments list
        if attachments:
            output.append("")
            output.append(f"--- Attachments ({len(attachments)}) ---")
            for att in attachments:
                size_kb = att["size"] / 1024
                output.append(
                    f"- {att['filename']} ({att['mimeType']}, {size_kb:.1f} KB)"
                )

        return [TextContent(type="text", text="\n".join(output))]

    except Exception as e:
        return [TextContent(type="text", text=f"Error getting email: {e}")]


def _sanitize_filename(filename: str) -> str:
    """Sanitize filename to prevent path traversal and invalid characters.

    Args:
        filename: Original filename

    Returns:
        Sanitized filename safe for filesystem
    """
    # Remove path separators and null bytes
    filename = filename.replace("/", "_").replace("\\", "_").replace("\x00", "")
    # Remove other potentially problematic characters
    filename = re.sub(r'[<>:"|?*]', "_", filename)
    # Limit length
    if len(filename) > 255:
        name, ext = os.path.splitext(filename)
        filename = name[: 255 - len(ext)] + ext
    # Ensure non-empty
    if not filename or filename.startswith("."):
        filename = "attachment" + filename
    return filename


async def _get_attachments(arguments: dict[str, Any]) -> list[TextContent]:
    """Handle get_attachments tool call."""
    if not is_authenticated():
        return [
            TextContent(
                type="text",
                text="Error: Not authenticated. Please call the 'authenticate' tool first.",
            )
        ]

    service = get_gmail_service()
    if not service:
        return [
            TextContent(
                type="text",
                text="Error: Failed to connect to Gmail. Please re-authenticate.",
            )
        ]

    email_id = arguments.get("email_id")
    if not email_id:
        return [TextContent(type="text", text="Error: email_id is required.")]

    filename_filter = arguments.get("filename")
    save_to = arguments.get("save_to", "~/Downloads")
    save_dir = Path(save_to).expanduser()

    # Ensure save directory exists
    try:
        save_dir.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return [TextContent(type="text", text=f"Error creating directory: {e}")]

    try:
        # Get email to find attachments
        msg = (
            service.users()
            .messages()
            .get(userId="me", id=email_id, format="full")
            .execute()
        )

        _, _, attachments = _extract_body_parts(msg["payload"])

        if not attachments:
            return [TextContent(type="text", text="No attachments found in this email.")]

        # Filter to specific attachment if filename specified
        if filename_filter:
            attachments = [a for a in attachments if a["filename"] == filename_filter]
            if not attachments:
                return [
                    TextContent(
                        type="text",
                        text=f"Attachment '{filename_filter}' not found.",
                    )
                ]

        saved_files = []
        for att in attachments:
            # Download attachment
            att_data = (
                service.users()
                .messages()
                .attachments()
                .get(userId="me", messageId=email_id, id=att["id"])
                .execute()
            )

            # Decode and save
            file_data = base64.urlsafe_b64decode(att_data["data"])
            safe_filename = _sanitize_filename(att["filename"])
            file_path = save_dir / safe_filename

            # Handle duplicate filenames
            counter = 1
            while file_path.exists():
                name, ext = os.path.splitext(safe_filename)
                file_path = save_dir / f"{name}_{counter}{ext}"
                counter += 1

            file_path.write_bytes(file_data)
            saved_files.append(str(file_path))

        output = [f"Downloaded {len(saved_files)} attachment(s):"]
        for path in saved_files:
            output.append(f"  - {path}")

        return [TextContent(type="text", text="\n".join(output))]

    except Exception as e:
        return [TextContent(type="text", text=f"Error downloading attachments: {e}")]


async def _archive_email(arguments: dict[str, Any]) -> list[TextContent]:
    """Handle archive_email tool call."""
    if not is_authenticated():
        return [
            TextContent(
                type="text",
                text="Error: Not authenticated. Please call the 'authenticate' tool first.",
            )
        ]

    service = get_gmail_service()
    if not service:
        return [
            TextContent(
                type="text",
                text="Error: Failed to connect to Gmail. Please re-authenticate.",
            )
        ]

    email_ids = arguments.get("email_ids", [])
    if not email_ids:
        return [TextContent(type="text", text="Error: email_ids is required.")]

    successes = []
    failures = []

    for email_id in email_ids:
        try:
            service.users().messages().modify(
                userId="me",
                id=email_id,
                body={"removeLabelIds": ["INBOX"]},
            ).execute()
            successes.append(email_id)
        except Exception as e:
            failures.append(f"{email_id}: {e}")

    # Build response
    lines = []
    if successes:
        lines.append(f"Archived {len(successes)} email(s).")
    if failures:
        lines.append(f"Failed to archive {len(failures)} email(s):")
        for failure in failures:
            lines.append(f"  - {failure}")

    return [TextContent(type="text", text="\n".join(lines))]


async def main():
    """Run the MCP server."""
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())

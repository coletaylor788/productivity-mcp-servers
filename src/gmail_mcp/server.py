"""Gmail MCP Server implementation."""

import asyncio
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
            description="List recent emails from Gmail inbox",
            inputSchema={
                "type": "object",
                "properties": {
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of emails to return (default: 10, max: 50)",
                        "default": 10,
                    },
                },
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

    try:
        results = (
            service.users()
            .messages()
            .list(userId="me", maxResults=max_results)
            .execute()
        )

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


async def main():
    """Run the MCP server."""
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())

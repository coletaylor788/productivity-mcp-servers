#!/bin/bash
# Wrapper script for debugging MCP server startup

exec /Users/cole/git/gmail-mcp/.venv/bin/python -m gmail_mcp 2>> /tmp/gmail-mcp-debug.log

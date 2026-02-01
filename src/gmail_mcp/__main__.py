"""Entry point for running as a module: python -m gmail_mcp"""

import asyncio

from .server import main

if __name__ == "__main__":
    asyncio.run(main())

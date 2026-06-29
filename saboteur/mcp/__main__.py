"""``python -m saboteur.mcp`` → the stdio shim."""

import sys

from .server import main

if __name__ == "__main__":
    sys.exit(main())

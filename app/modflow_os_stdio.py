"""MODFLOW OS over stdio: the same MCP server the app serves at /mcp, run in-process wherever an agent lives.

Used inside Databricks Sandboxes (Omnigent sessions) and jobs, where the only credentials are the host's own
workspace identity. Everything runs as that identity: Unity Catalog reads through the SQL warehouse, the mf6 engine
locally, filing to the same Delta tables, MLflow experiment and model-files volume.

    MODFLOW_OS_HOST=sandbox python modflow_os_stdio.py
"""
import io
import os
import sys

os.environ.setdefault("MODFLOW_OS_HOST", "sandbox")
# The protocol gets private copies of fd 0/1. Everything else that writes to stdout, at the fd level (mf6, flopy) or
# through sys.stdout (MLflow prints a "View run" line when a run is filed), goes to stderr instead of onto the wire.
_proto_in = io.TextIOWrapper(os.fdopen(os.dup(0), "rb"), encoding="utf-8", errors="replace")
_proto_out = io.TextIOWrapper(os.fdopen(os.dup(1), "wb"), encoding="utf-8", line_buffering=True)
os.dup2(2, 1)
sys.stdout = sys.stderr
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import anyio  # noqa: E402
from mcp.server.stdio import stdio_server  # noqa: E402

import app  # noqa: E402


async def main():
    server = app.MCP._mcp_server
    async with stdio_server(stdin=anyio.wrap_file(_proto_in), stdout=anyio.wrap_file(_proto_out)) as (r, w):
        await server.run(r, w, server.create_initialization_options())


app.WORK.mkdir(parents=True, exist_ok=True)
app._install_mf6()
anyio.run(main)

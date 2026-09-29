#!/usr/bin/env bash
# Groundwater Studio installer.
#
#   ./install.sh                                   # uses your DEFAULT Databricks CLI profile
#   ./install.sh --profile my-workspace            # or a named profile
#   ./install.sh --profile my-workspace --catalog research --share-with groundwater-team
#
# Needs the Databricks CLI (https://docs.databricks.com/dev-tools/cli/install) signed in to the workspace
# (`databricks auth login --host https://<your-workspace>`) and Python 3.10+. ./install.sh --help lists every option.
set -euo pipefail
cd "$(dirname "$0")"

command -v databricks >/dev/null || { echo "The Databricks CLI is not installed: https://docs.databricks.com/dev-tools/cli/install"; exit 1; }
PY=$(command -v python3 || command -v python || true)
[ -n "$PY" ] || { echo "Python 3.10 or newer is needed."; exit 1; }
"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 10))' || { echo "Python 3.10 or newer is needed ($("$PY" --version))."; exit 1; }

if [ ! -x .install/venv/bin/python ]; then
  echo "Setting up the installer's Python environment (once)..."
  "$PY" -m venv .install/venv
  .install/venv/bin/python -m pip install -q --disable-pip-version-check "databricks-sdk>=0.81"
fi
exec .install/venv/bin/python installer/install.py "$@"

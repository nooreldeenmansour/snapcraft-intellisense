#!/usr/bin/env python3
"""
Extract all user-facing extension URLs for link checking.

This script reads the snapcraft.json schema and urls.json (single source
of truth) and generates all documentation URLs that users encounter through:
- Hover tooltips (plugin docs, base docs)
- Command palette (snapcraft documentation links)
- Interface documentation
"""

import json
import sys
from pathlib import Path


def load_config(base_path):
    """Load URL configuration from urls.json."""
    config_path = base_path / "schemas" / "urls.json"
    try:
        with config_path.open() as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"Error loading URL config: {e}", file=sys.stderr)
        sys.exit(1)


def load_schema(base_path):
    """Load schema from snapcraft.json."""
    schema_path = base_path / "schemas" / "snapcraft.json"
    try:
        with schema_path.open() as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"Error loading schema: {e}", file=sys.stderr)
        sys.exit(1)


def build_urls(config, schema):
    """Build all user-facing extension URLs."""
    # Build URL constants from config
    docs_base = config["baseUrls"]["docs"]
    docs_plugins = f"{docs_base}{config['paths']['plugins']}"
    docs_reference = f"{docs_base}{config['paths']['reference']}"
    docs_bases = f"{docs_base}{config['paths']['bases']}"
    interfaces_docs = config["baseUrls"]["interfaces"]

    urls = []

    # Base Documentation URLs (for hover context)
    urls.extend(
        [
            docs_base,
            docs_reference,
            docs_bases,
            interfaces_docs,
        ]
    )

    # Command Palette URLs (from extension.ts showDocumentation command)
    command_palette_urls = [
        f"{docs_base}{config['paths']['referencePlugins']}",
        f"{docs_base}{config['paths']['extensions']}",
        f"{docs_base}{config['paths']['layouts']}",
        f"{docs_base}{config['paths']['hooks']}",
        f"{docs_base}{config['paths']['packageRepositories']}",
        f"{docs_base}{config['paths']['components']}",
    ]
    urls.extend(command_palette_urls)

    # Plugin Documentation URLs (from schema + hover provider logic)
    try:
        plugins = schema["$defs"]["Part"]["properties"]["plugin"]["enum"]
    except KeyError as e:
        print(f"Error: Could not find plugins in schema: {e}", file=sys.stderr)
        sys.exit(1)

    # Reference plugins use different base path (from config)
    reference_plugins = set(config["pluginSpecialCases"]["referencePlugins"])
    plugin_aliases = config["pluginSpecialCases"]["aliasMapping"]

    for plugin in plugins:
        # Handle plugin aliases (e.g., .net -> dotnet)
        normalized_plugin = plugin_aliases.get(plugin, plugin)

        # Reference plugins go to /reference/plugins/, others to common craft-parts
        if plugin in reference_plugins:
            base_url = f"{docs_base}{config['paths']['referencePlugins']}"
        else:
            base_url = docs_plugins

        # Replace hyphens with underscores in plugin name
        plugin_name = normalized_plugin.replace("-", "_")
        url = f"{base_url}{plugin_name}_plugin/"

        urls.append(url)

    # Base Snap Documentation URLs (anchor links from hover)
    try:
        # Get bases from both 'base' and 'build-base' properties
        bases = set(schema["properties"]["base"]["enum"])
        build_bases = set(schema["properties"]["build-base"]["enum"])
        all_bases = bases.union(build_bases)
    except KeyError as e:
        print(f"Error: Could not find bases in schema: {e}", file=sys.stderr)
        sys.exit(1)

    for base in sorted(all_bases):
        # Generate anchor link (e.g., #core24, #core22)
        url = f"{docs_bases}#{base}"
        urls.append(url)

    # Infrastructure URLs (canonical/snapcraft repository dependencies)
    # These raw GitHub URLs are used by sync.py to fetch extension data.
    # Check them to catch early if Canonical restructures their repository.
    infrastructure_urls = [
        "https://raw.githubusercontent.com/canonical/snapcraft/main/snapcraft/extensions/registry.py",
        "https://raw.githubusercontent.com/canonical/snapcraft/main/schema/snapcraft-legacy.json",
    ]
    urls.extend(infrastructure_urls)

    # Remove duplicates while preserving order
    unique_urls = list(dict.fromkeys(urls))
    return unique_urls


def main():
    """Extract and print all user-facing extension URLs."""
    base_path = Path(__file__).parent.parent

    config = load_config(base_path)
    schema = load_schema(base_path)
    urls = build_urls(config, schema)

    for url in urls:
        print(url)

    print(f"# Total URLs: {len(urls)}", file=sys.stderr)


if __name__ == "__main__":
    main()

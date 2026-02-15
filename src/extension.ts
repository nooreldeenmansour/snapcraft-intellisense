import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import urlsConfig from '../schemas/urls.json';
const DOCS_BASE = urlsConfig.baseUrls.docs;
const DOCS_REFERENCE = `${DOCS_BASE}${urlsConfig.paths.reference}`;
const DOCS_PLUGINS = `${DOCS_BASE}${urlsConfig.paths.plugins}`;
const DOCS_BASES = `${DOCS_BASE}${urlsConfig.paths.bases}`;
const INTERFACES_DOCS = urlsConfig.baseUrls.interfaces;

// Plugin special cases (from config)
const REFERENCE_PLUGINS = new Set(urlsConfig.pluginSpecialCases.referencePlugins);
const PLUGIN_ALIASES = urlsConfig.pluginSpecialCases.aliasMapping as Record<string, string>;

// Documentation menu items for command palette
const DOCUMENTATION_ITEMS = [
  { label: 'Snapcraft YAML Reference', url: DOCS_REFERENCE },
  { label: 'Plugins', url: `${DOCS_BASE}${urlsConfig.paths.referencePlugins}` },
  { label: 'Interfaces', url: INTERFACES_DOCS },
  { label: 'Extensions', url: `${DOCS_BASE}${urlsConfig.paths.extensions}` },
  { label: 'Bases', url: DOCS_BASES },
  { label: 'Layouts', url: `${DOCS_BASE}${urlsConfig.paths.layouts}` },
  { label: 'Hooks', url: `${DOCS_BASE}${urlsConfig.paths.hooks}` },
  { label: 'Package Repositories', url: `${DOCS_BASE}${urlsConfig.paths.packageRepositories}` },
  { label: 'Components', url: `${DOCS_BASE}${urlsConfig.paths.components}` },
] as const;

/**
 * Schema data manager - handles loading and caching of dynamic schema data.
 * Provides type-safe access to plugins, bases, and interfaces from the schema.
 */
class SchemaDataManager {
  private interfaces: ReadonlySet<string> = new Set();
  private plugins: ReadonlySet<string> = new Set();
  private bases: ReadonlySet<string> = new Set();
  private loaded: boolean = false;

  /**
   * Load schema data from the snapcraft.json file.
   */
  load(context: vscode.ExtensionContext): void {
    try {
      const schemaPath = path.join(context.extensionPath, 'schemas', 'snapcraft.json');
      const schemaContent = fs.readFileSync(schemaPath, 'utf8');
      const schema: {
        properties?: {
          slots?: { propertyNames?: { enum?: string[] } };
          base?: { enum?: string[] };
        };
        $defs?: {
          Part?: { properties?: { plugin?: { enum?: string[] } } };
        };
      } = JSON.parse(schemaContent);

      this.interfaces = this.extractEnumValues(schema.properties?.slots?.propertyNames?.enum);
      this.plugins = this.extractEnumValues(schema.$defs?.Part?.properties?.plugin?.enum);
      this.bases = this.extractEnumValues(schema.properties?.base?.enum);

      this.loaded = true;
      console.log(`Schema data loaded: ${this.plugins.size} plugins, ${this.bases.size} bases, ${this.interfaces.size} interfaces`);
    } catch (error) {
      console.error('Failed to load schema data:', error);
      // Keep empty sets on error
      this.loaded = false;
    }
  }

  /**
   * Extract enum values from schema, returning empty set if invalid.
   */
  private extractEnumValues(enumArray: unknown): ReadonlySet<string> {
    return Array.isArray(enumArray) ? new Set(enumArray) : new Set();
  }

  /**
   * Check if a plugin name is valid.
   */
  isValidPlugin(name: string): boolean {
    return this.plugins.has(name);
  }

  /**
   * Check if a base name is valid.
   */
  isValidBase(name: string): boolean {
    return this.bases.has(name);
  }

  /**
   * Check if an interface name is valid.
   */
  isValidInterface(name: string): boolean {
    return this.interfaces.has(name);
  }

  /**
   * Get loading status.
   */
  isLoaded(): boolean {
    return this.loaded;
  }
}

// Global schema data manager instance
const schemaData = new SchemaDataManager();

function isHoverEnabled(): boolean {
  return vscode.workspace.getConfiguration('snapcraft').get<boolean>('hover.enable', true);
}

/**
 * Build documentation URL for a property key.
 * URLs follow the pattern: base-url#property-name
 */
function getPropertyDocUrl(key: string): string {
  // Properties use lowercase with hyphens as anchors
  return `${DOCS_REFERENCE}#${key}`;
}

/**
 * Build plugin documentation URL.
 * Some plugins are in /common/craft-parts/reference/plugins/, others in /reference/plugins/
 * Uses urls.json for plugin routing (single source of truth)
 */
function getPluginDocUrl(plugin: string): string | null {
  // Handle plugin aliases (e.g., .net -> dotnet)
  const normalizedPlugin = PLUGIN_ALIASES[plugin] || plugin;

  // Reference plugins use different base path
  const baseUrl = REFERENCE_PLUGINS.has(plugin)
    ? `${DOCS_BASE}${urlsConfig.paths.referencePlugins}`
    : DOCS_PLUGINS;

  // Most plugins follow: plugin_name_plugin/
  return `${baseUrl}${normalizedPlugin.replace(/-/g, '_')}_plugin/`;
}

/**
 * Build base documentation URL.
 */
function getBaseDocUrl(base: string): string {
  return `${DOCS_BASES}#${base}`;
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Snapcraft YAML extension is now active');

  // Load schema data for hover providers
  schemaData.load(context);

  // Register hover provider for enhanced documentation links
  const hoverProvider = vscode.languages.registerHoverProvider(
    { language: 'yaml', pattern: '**/snapcraft.{yml,yaml}' },
    new SnapcraftHoverProvider()
  );
  context.subscriptions.push(hoverProvider);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('snapcraft.showDocumentation', () => showDocumentation())
  );

  // Show welcome message on first activation
  const hasShownWelcome = context.globalState.get('snapcraft.hasShownWelcome');
  if (!hasShownWelcome) {
    vscode.window.showInformationMessage(
      'Snapcraft YAML extension activated! IntelliSense and schema validation are now available for snapcraft.yaml and snapcraft.yml files.',
      'View Documentation'
    ).then(selection => {
      if (selection === 'View Documentation') {
        vscode.env.openExternal(vscode.Uri.parse(DOCS_REFERENCE));
      }
    });
    context.globalState.update('snapcraft.hasShownWelcome', true);
  }
}

/**
 * Hover provider for enhanced documentation links.
 * The JSON schema provides basic descriptions; this adds clickable doc links.
 */
class SnapcraftHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.Hover | null {
    if (!isHoverEnabled()) return null;

    const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_-]+/);
    if (!wordRange) return null;

    const word = document.getText(wordRange);
    const lineText = document.lineAt(position.line).text;

    // Check if this is a key or value
    const colonIndex = lineText.indexOf(':');
    const isKey = colonIndex === -1 || position.character < colonIndex;

    if (isKey) {
      // Provide documentation link for top-level keys
      const docUrl = getPropertyDocUrl(word);
      const content = new vscode.MarkdownString();
      content.appendMarkdown(`**${word}**\n\n`);
      content.appendMarkdown(`[View Documentation](${docUrl})`);
      content.isTrusted = true;
      return new vscode.Hover(content, wordRange);
    } else {
      // Provide documentation for values
      const key = lineText.substring(0, colonIndex).trim();

      // Plugin documentation (loaded from schema)
      if (key === 'plugin' && schemaData.isValidPlugin(word)) {
        const pluginUrl = getPluginDocUrl(word);
        if (pluginUrl) {
          const content = new vscode.MarkdownString();
          content.appendMarkdown(`**${word}** plugin\n\n`);
          content.appendMarkdown(`[View Plugin Documentation](${pluginUrl})`);
          content.isTrusted = true;
          return new vscode.Hover(content, wordRange);
        }
      }

      // Base snap documentation (loaded from schema)
      if ((key === 'base' || key === 'build-base') && schemaData.isValidBase(word)) {
        const content = new vscode.MarkdownString();
        content.appendMarkdown(`**${word}** base snap\n\n`);
        content.appendMarkdown(`[View Base Documentation](${getBaseDocUrl(word)})`);
        content.isTrusted = true;
        return new vscode.Hover(content, wordRange);
      }

      // Interface documentation (loaded from schema)
      if (schemaData.isValidInterface(word)) {
        const context = this.getInterfaceContext(document, position);
        if (context.isInPlugsOrSlots) {
          const content = new vscode.MarkdownString();
          content.appendMarkdown(`**${word}** interface\n\n`);
          content.appendMarkdown(`Part of Snapcraft's interface system for controlled access to system resources.\n\n`);
          content.appendMarkdown(`[View All Supported Interfaces](${INTERFACES_DOCS})`);
          content.isTrusted = true;
          return new vscode.Hover(content, wordRange);
        }
      }
    }

    return null;
  }

  /**
   * Determine if the current position is within a plugs or slots section.
   */
  private getInterfaceContext(document: vscode.TextDocument, position: vscode.Position): { isInPlugsOrSlots: boolean } {
    const currentLine = position.line;
    let isInPlugsOrSlots = false;

    // Look backwards for plugs: or slots: key at the same or lower indentation level
    for (let i = currentLine; i >= Math.max(0, currentLine - 50); i--) {
      const line = document.lineAt(i).text;
      const match = line.match(/^(\s*)(plugs|slots):/);

      if (match) {
        const keyIndent = match[1].length;
        const currentIndent = document.lineAt(currentLine).text.match(/^(\s*)/)?.[1].length ?? 0;

        // Check if we're at a deeper indentation (inside the section)
        if (currentIndent > keyIndent) {
          isInPlugsOrSlots = true;
        }
        break;
      }
    }

    return { isInPlugsOrSlots };
  }
}

async function showDocumentation(): Promise<void> {
  const choice = await vscode.window.showQuickPick(DOCUMENTATION_ITEMS, {
    placeHolder: 'Select documentation to view'
  });

  if (choice) {
    vscode.env.openExternal(vscode.Uri.parse(choice.url));
  }
}

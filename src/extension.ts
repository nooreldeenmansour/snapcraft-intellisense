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

// Properties that have valid documentation anchors in the reference docs
const VALID_PROPERTY_KEYS = new Set(urlsConfig.websiteAnchors);

/**
 * Schema data manager - handles loading and caching of dynamic schema data.
 * Provides type-safe access to plugins, bases, and interfaces from the schema.
 */
class SchemaDataManager {
  private interfaces = new Set<string>();
  private plugins = new Set<string>();
  private bases = new Set<string>();

  load(context: vscode.ExtensionContext): void {
    try {
      const schemaPath = path.join(context.extensionPath, 'schemas', 'snapcraft.json');
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as {
        properties?: { base?: { enum?: string[] } };
        $defs?: {
          Part?: { properties?: { plugin?: { enum?: string[] } } };
          App?: {
            properties?: {
              plugs?: {
                items?: {
                  oneOf?: Array<{ enum?: string[] }>;
                  anyOf?: Array<{ enum?: string[] }>;
                };
              };
            };
          };
        };
      };

      const plugsItems = schema.$defs?.App?.properties?.plugs?.items;
      const interfaceEnum = plugsItems?.oneOf?.[0]?.enum || plugsItems?.anyOf?.[0]?.enum;

      this.interfaces = this.extractEnum(interfaceEnum);
      this.plugins = this.extractEnum(schema.$defs?.Part?.properties?.plugin?.enum);
      this.bases = this.extractEnum(schema.properties?.base?.enum);
      console.log(`Schema loaded: ${this.plugins.size} plugins, ${this.bases.size} bases, ${this.interfaces.size} interfaces`);
    } catch (e) {
      console.error('Schema load failed:', e);
    }
  }

  private extractEnum(arr: unknown): Set<string> {
    return new Set(Array.isArray(arr) ? arr : []);
  }

  isValidPlugin(name: string): boolean { return this.plugins.has(name); }
  isValidBase(name: string): boolean { return this.bases.has(name); }
  isValidInterface(name: string): boolean { return this.interfaces.has(name); }
}

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
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | null {
    if (!isHoverEnabled()) return null;

    const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_-]+/);
    if (!wordRange) return null;

    const word = document.getText(wordRange);
    const lineText = document.lineAt(position.line).text;
    const colonIndex = lineText.indexOf(':');
    const isKey = colonIndex === -1 || position.character < colonIndex;

    const content = new vscode.MarkdownString();
    content.isTrusted = true;

    if (isKey) {
      if (VALID_PROPERTY_KEYS.has(word)) {
        content.appendMarkdown(`[View Documentation](${getPropertyDocUrl(word)})\n\n`);
      } else {
        return null;
      }
    } else {
      const key = lineText.substring(0, colonIndex).trim();

      if (key === 'plugin' && schemaData.isValidPlugin(word)) {
        const url = getPluginDocUrl(word);
        if (url) content.appendMarkdown(`[View Plugin Documentation](${url})\n\n`);
      } else if (schemaData.isValidInterface(word)) {
        if (this.isInInterfaceContext(document, position)) {
          content.appendMarkdown(`[View All Supported Interfaces](${INTERFACES_DOCS})\n\n`);
          content.appendMarkdown(`Part of Snapcraft's interface system for controlled access to system resources.`);
        }
      }
    }

    return content.value ? new vscode.Hover(content, wordRange) : null;
  }

  private isInInterfaceContext(document: vscode.TextDocument, position: vscode.Position): boolean {
    const currentIndent = document.lineAt(position.line).firstNonWhitespaceCharacterIndex;

    for (let i = position.line - 1; i >= Math.max(0, position.line - 100); i--) {
      const line = document.lineAt(i);
      if (line.isEmptyOrWhitespace) continue;

      const match = line.text.match(/^(\s*)(plugs|slots):\s*$/);
      if (match) {
        const keyIndent = match[1].length;
        if (currentIndent > keyIndent) return true;
        if (currentIndent <= keyIndent) return false;
      }
    }
    return false;
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

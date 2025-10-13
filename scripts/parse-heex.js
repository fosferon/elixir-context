#!/usr/bin/env node

const fs = require('fs');
const crypto = require('crypto');

/**
 * Parse .heex template files and extract searchable content
 * Returns JSONL format compatible with ingest.js
 */
function parseHeexFile(filePath, content) {
  const results = [];

  // Extract module name from file path (e.g., lib/mobus_web/live/company_live/index.html.heex -> MobusWeb.CompanyLive.Index)
  const moduleName = extractModuleName(filePath);

  // Extract components like <.modal>, <.form>, <.live_component>
  const components = extractComponents(content);

  // Extract assigns like @user, @socket, @company
  const assigns = extractAssigns(content);

  // Extract function calls like Routes.company_path(@socket, :index)
  const functionCalls = extractFunctionCalls(content);

  // Build searchable lexical text
  const lexicalParts = [
    moduleName,
    'template',
    'heex',
    ...components.map(c => c.name),
    ...assigns,
    ...functionCalls
  ];

  const lexicalText = lexicalParts.join(' ');

  // Create a pseudo-function entry for the template
  const id = crypto.createHash('sha256').update(`${moduleName}|template|0|${filePath}`).digest('hex');

  results.push({
    id: id,
    module: moduleName,
    name: 'template',
    arity: 0,
    path: filePath,
    start_line: 1,
    end_line: content.split('\n').length,
    signature: 'template',
    spec: null,
    doc: `Phoenix template file with components: ${components.map(c => c.name).join(', ')}`,
    lexical_text: lexicalText,
    struct_text: content.slice(0, 500), // First 500 chars for preview
    calls: functionCalls
  });

  return results;
}

function extractModuleName(filePath) {
  // Convert path like lib/mobus_web/live/company_live/index.html.heex
  // to MobusWeb.CompanyLive.Index
  const match = filePath.match(/lib\/([^\/]+)\/(.+)\.html\.heex$/);
  if (!match) return 'Template';

  const parts = [match[1], ...match[2].split('/')];
  return parts
    .map(p => p.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(''))
    .join('.');
}

function extractComponents(content) {
  const components = [];
  const regex = /<\.([a-z_][a-z0-9_]*)/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    components.push({
      name: match[1],
      line: content.slice(0, match.index).split('\n').length
    });
  }

  return components;
}

function extractAssigns(content) {
  const assigns = new Set();
  const regex = /@([a-z_][a-z0-9_]*)/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    assigns.add(match[1]);
  }

  return Array.from(assigns);
}

function extractFunctionCalls(content) {
  const calls = [];

  // Pattern 1: Module.function(args)
  const moduleCallRegex = /([A-Z][a-zA-Z0-9]*(?:\.[A-Z][a-zA-Z0-9]*)*)\.([a-z_][a-z0-9_]*)\(/g;
  let match;

  while ((match = moduleCallRegex.exec(content)) !== null) {
    calls.push(`${match[1]}.${match[2]}`);
  }

  // Pattern 2: function(args) - common helpers
  const functionRegex = /\b([a-z_][a-z0-9_]*)\(/g;
  while ((match = functionRegex.exec(content)) !== null) {
    if (!['if', 'for', 'case', 'cond', 'with'].includes(match[1])) {
      calls.push(match[1]);
    }
  }

  return Array.from(new Set(calls));
}

module.exports = { parseHeexFile };

// CLI usage
if (require.main === module) {
  const filePath = process.argv[2];

  if (!filePath) {
    console.error('Usage: node parse-heex.js <heex_file>');
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const results = parseHeexFile(filePath, content);

  for (const result of results) {
    console.log(JSON.stringify(result));
  }
}

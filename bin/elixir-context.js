#!/usr/bin/env node

const path = require('path');
const { spawn } = require('child_process');

const command = process.argv[2];

if (!command) {
  console.log('Usage: elixir-context <command> [options]');
  console.log('Commands: query, mcp-stdio, ingest, watch');
  process.exit(1);
}

const scriptPath = path.join(__dirname, '..', 'scripts', `${command}.js`);

const child = spawn('node', [scriptPath, ...process.argv.slice(3)], {
  stdio: 'inherit',
  cwd: process.cwd()
});

child.on('exit', (code) => {
  process.exit(code);
});
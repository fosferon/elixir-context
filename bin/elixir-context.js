#!/usr/bin/env node

const path = require('path');
const { spawn } = require('child_process');

const command = process.argv[2];
const commands = ['build', 'query', 'mcp-stdio', 'ingest', 'watch'];

function usage() {
  console.log('Usage: elixir-context <command> [options]');
  console.log(`Commands: ${commands.join(', ')}`);
}

if (!command || command === '--help' || command === '-h') {
  usage();
  process.exit(command ? 0 : 1);
}

if (!commands.includes(command)) {
  console.error(`Unknown command: ${command}`);
  usage();
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
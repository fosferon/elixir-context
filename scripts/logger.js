#!/usr/bin/env node

// Minimal structured logger that writes to stderr to avoid interfering with MCP stdout
function format(level, msg, extra) {
  const base = { ts: new Date().toISOString(), level, msg };
  const payload = extra ? { ...base, ...extra } : base;
  return JSON.stringify(payload);
}

const logger = {
  info: (msg, extra) => process.stderr.write(format('info', msg, extra) + '\n'),
  warn: (msg, extra) => process.stderr.write(format('warn', msg, extra) + '\n'),
  error: (msg, extra) => process.stderr.write(format('error', msg, extra) + '\n')
};

module.exports = { logger };
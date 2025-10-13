#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const rgPath = require('@vscode/ripgrep').rgPath;

/**
 * Fallback search using ripgrep for full-text code search
 * @param {string} query - Search query
 * @param {string} rootPath - Project root path
 * @param {number} limit - Max results to return
 * @returns {Promise<Array>} Array of search results
 */
function ripgrepSearch(query, rootPath, limit = 10) {
  return new Promise((resolve, reject) => {
    const args = [
      '--json',
      '--smart-case',
      '--type', 'elixir',
      '--max-count', '3', // Max 3 matches per file
      query,
      rootPath
    ];

    const rg = spawn(rgPath, args);
    let output = '';
    let errorOutput = '';

    rg.stdout.on('data', (data) => {
      output += data.toString();
    });

    rg.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    rg.on('close', (code) => {
      // ripgrep returns 0 for matches found, 1 for no matches, 2+ for errors
      if (code === 1) {
        resolve([]);
        return;
      }

      if (code > 1) {
        reject(new Error(`ripgrep failed: ${errorOutput}`));
        return;
      }

      try {
        const results = parseRipgrepOutput(output, limit);
        resolve(results);
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Parse ripgrep JSON output into structured results
 */
function parseRipgrepOutput(output, limit) {
  const lines = output.trim().split('\n').filter(Boolean);
  const matches = [];

  for (const line of lines) {
    try {
      const json = JSON.parse(line);

      if (json.type === 'match') {
        const match = json.data;
        matches.push({
          path: match.path.text,
          line_number: match.line_number,
          line_text: match.lines.text.trim(),
          score: calculateRelevanceScore(match),
          source: 'ripgrep'
        });
      }
    } catch (err) {
      // Skip invalid JSON lines
      continue;
    }
  }

  // Sort by relevance score and limit
  return matches
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Calculate relevance score for a ripgrep match
 */
function calculateRelevanceScore(match) {
  let score = 100;

  const text = match.lines.text;
  const filePath = match.path.text;

  // Boost if match is in a function definition
  if (text.includes('def ') || text.includes('defp ') || text.includes('defmodule ')) {
    score += 50;
  }

  // Boost if match is in lib/ directory (core code)
  if (filePath.includes('/lib/')) {
    score += 20;
  }

  // Penalize test files slightly
  if (filePath.includes('/test/')) {
    score -= 10;
  }

  // Penalize very long lines (likely generated code)
  if (text.length > 200) {
    score -= 20;
  }

  return score;
}

/**
 * Group ripgrep results by file for better presentation
 */
function groupByFile(results) {
  const grouped = {};

  for (const result of results) {
    if (!grouped[result.path]) {
      grouped[result.path] = [];
    }
    grouped[result.path].push(result);
  }

  return grouped;
}

module.exports = {
  ripgrepSearch,
  groupByFile
};

// CLI usage
if (require.main === module) {
  const query = process.argv[2];
  const root = process.argv[3] || process.cwd();
  const limit = parseInt(process.argv[4]) || 10;

  if (!query) {
    console.error('Usage: node ripgrep-search.js <query> [root] [limit]');
    process.exit(1);
  }

  ripgrepSearch(query, root, limit)
    .then(results => {
      console.log(JSON.stringify(results, null, 2));
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

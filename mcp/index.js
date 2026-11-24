#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createStore } = require('../src/task-store.js');
const { createTools } = require('../src/mcp-tools.js');
const { version } = require('../package.json');

// TDY_DATA_DIR points the server at another data folder (e.g. the tdy-test one used by `npm run dev:seed`)
const dataDir = process.env.TDY_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'tdy');
const readPrefs = () => {
  try { return JSON.parse(readFileSync(join(dataDir, 'prefs.json'), 'utf8')); } catch { return {}; }
};
const { tools, prompts, call } = createTools(createStore(dataDir), { readPrefs });

const server = new Server({ name: 'tdy', version }, { capabilities: { tools: {}, prompts: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { text, isError } = call(request.params.name, request.params.arguments);
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: prompts.map(({ name, description }) => ({ name, description })),
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const prompt = prompts.find(p => p.name === request.params.name);
  if (!prompt) throw new Error(`Unknown prompt: ${request.params.name}`);
  return {
    description: prompt.description,
    messages: [{ role: 'user', content: { type: 'text', text: prompt.text } }],
  };
});

await server.connect(new StdioServerTransport());

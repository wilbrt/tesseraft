#!/usr/bin/env node
import express, { type ErrorRequestHandler } from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiRouter, routeApi } from './routes/api.js';
import type { PiSessionAdapter } from './lib/piSessionAdapter.js';
import { errorBody, jsonResponse } from './lib/http.js';
import { STATIC_DIR } from './lib/paths.js';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7341;

type ParsedArgs = { host: string; port: number; help?: boolean };

export { routeApi };

const apiErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const err = error as Error & { status?: number; code?: string; type?: string };
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  const code = err.code || (status === 400 ? 'bad_request' : 'internal_error');
  jsonResponse(res, status, errorBody(status, code, err.message || 'Unhandled server error'));
};

export const createApp = (options: { piSessionAdapter?: PiSessionAdapter } = {}): express.Express => {
  const app = express();
  app.use('/api', createApiRouter(options.piSessionAdapter));
  app.use(express.static(STATIC_DIR, { index: 'index.html' }));
  app.use((_req, res) => jsonResponse(res, 404, errorBody(404, 'not_found', 'Resource not found')));
  app.use(apiErrorHandler);
  return app;
};

export const createServer = (options: { piSessionAdapter?: PiSessionAdapter } = {}): http.Server => http.createServer(createApp(options));

export const parseArgs = (argv: string[]): ParsedArgs => {
  const opts: ParsedArgs = { host: DEFAULT_HOST, port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') {
      const value = argv[++i];
      if (value === undefined) throw new Error('Missing value for --port');
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid --port: ${value}`);
      opts.port = port;
    } else if (arg === '--host') {
      const value = argv[++i];
      if (value === undefined) throw new Error('Missing value for --host');
      opts.host = value;
    } else if (arg === '-h' || arg === '--help' || arg === 'help') {
      opts.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
};

const printUsage = (): void => {
  console.log('Usage: tesseraft web [--host 127.0.0.1] [--port <port>]');
  console.log('Serve the local Tesseraft Web UI.');
};

export const main = (): void => {
  let opts: ParsedArgs;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    process.exit(2);
  }

  if (opts.help) {
    printUsage();
    process.exit(0);
  }

  const server = createServer();
  server.listen(opts.port, opts.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : opts.port;
    console.log(`Tesseraft web UI listening on http://${opts.host}:${port}`);
  });
};

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) main();

#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const STATIC_DIR = path.join(__dirname, 'static');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7341;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function errorBody(status, code, message, details = {}) {
  return { status, error: { code, message, details } };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return null;
  }
}

function statusFromControlPlane(data, fallback) {
  if (data && typeof data.status === 'number') return data.status;
  return fallback;
}

function runControlPlane(args, options = {}) {
  const bin = path.join(ROOT_DIR, 'bin', 'tesseraft');
  return new Promise((resolve) => {
    execFile(bin, ['control-plane', ...args], {
      cwd: ROOT_DIR,
      timeout: options.timeout || 15000,
      maxBuffer: 10 * 1024 * 1024
    }, (error, stdout, stderr) => {
      let parsed;
      try {
        parsed = JSON.parse(stdout || '{}');
      } catch (parseError) {
        resolve({
          status: 502,
          body: errorBody(502, 'bad_gateway', 'Control-plane returned invalid JSON', {
            message: parseError.message,
            stderr: String(stderr || '').trim(),
            exit_code: error && typeof error.code === 'number' ? error.code : null
          })
        });
        return;
      }

      if (error || parsed.error) {
        resolve({
          status: statusFromControlPlane(parsed, error && error.code === 2 ? 400 : 500),
          body: parsed.error ? parsed : errorBody(500, 'control_plane_error', 'Control-plane command failed', {
            stderr: String(stderr || '').trim(),
            exit_code: error && typeof error.code === 'number' ? error.code : null
          })
        });
        return;
      }

      resolve({ status: 200, body: parsed });
    });
  });
}

function routeApi(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api') return null;

  if (parts.length === 2 && parts[1] === 'workflows') return ['workflows'];
  if (parts.length === 3 && parts[1] === 'workflows') {
    const name = safeDecode(parts[2]);
    return name === null ? { badRequest: 'Malformed workflow name' } : ['workflow', name];
  }
  if (parts.length === 4 && parts[1] === 'workflows' && parts[3] === 'graph') {
    const name = safeDecode(parts[2]);
    return name === null ? { badRequest: 'Malformed workflow name' } : ['graph', name];
  }
  if (parts.length === 2 && parts[1] === 'runs') return ['runs'];
  if (parts.length === 3 && parts[1] === 'runs') {
    const runId = safeDecode(parts[2]);
    return runId === null ? { badRequest: 'Malformed run id' } : ['run', runId];
  }
  if (parts.length === 4 && parts[1] === 'runs' && parts[3] === 'events') {
    const runId = safeDecode(parts[2]);
    return runId === null ? { badRequest: 'Malformed run id' } : ['events', runId];
  }

  return { notFound: true };
}

async function handleApi(req, res, pathname) {
  if (req.method !== 'GET') {
    jsonResponse(res, 405, errorBody(405, 'method_not_allowed', 'Only GET is supported'));
    return;
  }

  const routed = routeApi(pathname);
  if (routed === null) return false;
  if (routed.badRequest) {
    jsonResponse(res, 400, errorBody(400, 'bad_request', routed.badRequest));
    return true;
  }
  if (routed.notFound) {
    jsonResponse(res, 404, errorBody(404, 'not_found', 'API route not found'));
    return true;
  }

  const result = await runControlPlane(routed);
  jsonResponse(res, result.status, result.body);
  return true;
}

function staticPath(pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const decoded = safeDecode(requested);
  if (decoded === null) return null;
  const resolved = path.resolve(STATIC_DIR, `.${decoded}`);
  if (!resolved.startsWith(STATIC_DIR + path.sep) && resolved !== STATIC_DIR) return null;
  return resolved;
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    jsonResponse(res, 405, errorBody(405, 'method_not_allowed', 'Only GET and HEAD are supported for static assets'));
    return;
  }

  const filePath = staticPath(pathname);
  if (!filePath) {
    jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed static asset path'));
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      jsonResponse(res, 404, errorBody(404, 'not_found', 'Resource not found'));
      return;
    }
    const type = CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': data.length });
    if (req.method === 'HEAD') res.end();
    else res.end(data);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    let parsed;
    try {
      parsed = new URL(req.url, 'http://127.0.0.1');
    } catch (error) {
      jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed URL'));
      return;
    }

    try {
      const handled = await handleApi(req, res, parsed.pathname);
      if (!handled) serveStatic(req, res, parsed.pathname);
    } catch (error) {
      jsonResponse(res, 500, errorBody(500, 'internal_error', 'Unhandled server error', { message: error.message }));
    }
  });
}

function parseArgs(argv) {
  const opts = { host: DEFAULT_HOST, port: DEFAULT_PORT };
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
}

function printUsage() {
  console.log('Usage: tesseraft web [--host 127.0.0.1] [--port <port>]');
  console.log('Serve the local read-only Tesseraft Web UI.');
}

if (require.main === module) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
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
    console.log(`Tesseraft web UI listening on http://${opts.host}:${address.port}`);
  });
}

module.exports = { createServer, runControlPlane, routeApi, parseArgs };

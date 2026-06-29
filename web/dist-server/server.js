#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const STATIC_DIR = path.join(ROOT_DIR, 'web', 'static');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7341;
const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml; charset=utf-8'
};
const jsonResponse = (res, status, body) => {
    const payload = JSON.stringify(body, null, 2);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload)
    });
    res.end(payload);
};
const errorBody = (status, code, message, details = {}) => ({ status, error: { code, message, details } });
const safeDecode = (value) => {
    try {
        return decodeURIComponent(value);
    }
    catch (_error) {
        return null;
    }
};
const statusFromControlPlane = (data, fallback) => {
    if (data && typeof data === 'object' && 'status' in data && typeof data.status === 'number')
        return data.status;
    return fallback;
};
const hasControlPlaneError = (data) => (Boolean(data && typeof data === 'object' && 'error' in data));
export const runControlPlane = (args, options = {}) => {
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
            }
            catch (parseError) {
                const message = parseError instanceof Error ? parseError.message : String(parseError);
                resolve({
                    status: 502,
                    body: errorBody(502, 'bad_gateway', 'Control-plane returned invalid JSON', {
                        message,
                        stderr: String(stderr || '').trim(),
                        exit_code: error && typeof error.code === 'number' ? error.code : null
                    })
                });
                return;
            }
            if (error || hasControlPlaneError(parsed)) {
                resolve({
                    status: statusFromControlPlane(parsed, error && error.code === 2 ? 400 : 500),
                    body: hasControlPlaneError(parsed) ? parsed : errorBody(500, 'control_plane_error', 'Control-plane command failed', {
                        stderr: String(stderr || '').trim(),
                        exit_code: error && typeof error.code === 'number' ? error.code : null
                    })
                });
                return;
            }
            resolve({ status: 200, body: parsed });
        });
    });
};
export const routeApi = (pathname, searchParams = new URLSearchParams()) => {
    const parts = pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api')
        return null;
    if (parts.length === 2 && parts[1] === 'workflows')
        return ['workflows'];
    if (parts.length === 3 && parts[1] === 'workflows') {
        const name = safeDecode(parts[2]);
        return name === null ? { badRequest: 'Malformed workflow name' } : ['workflow', name];
    }
    if (parts.length === 4 && parts[1] === 'workflows' && parts[3] === 'graph') {
        const name = safeDecode(parts[2]);
        return name === null ? { badRequest: 'Malformed workflow name' } : ['graph', name];
    }
    if (parts.length === 2 && parts[1] === 'runs')
        return ['runs'];
    if (parts.length === 3 && parts[1] === 'runs') {
        const runId = safeDecode(parts[2]);
        return runId === null ? { badRequest: 'Malformed run id' } : ['run', runId];
    }
    if (parts.length === 4 && parts[1] === 'runs' && parts[3] === 'events') {
        const runId = safeDecode(parts[2]);
        return runId === null ? { badRequest: 'Malformed run id' } : ['events', runId];
    }
    if (parts.length === 4 && parts[1] === 'runs' && parts[3] === 'artifacts') {
        const runId = safeDecode(parts[2]);
        return runId === null ? { badRequest: 'Malformed run id' } : ['artifacts', runId];
    }
    if (parts.length === 5 && parts[1] === 'runs' && parts[3] === 'artifact') {
        const runId = safeDecode(parts[2]);
        const artifactPath = safeDecode(parts[4]);
        if (runId === null)
            return { badRequest: 'Malformed run id' };
        if (artifactPath === null)
            return { badRequest: 'Malformed artifact path' };
        return ['artifact', runId, artifactPath];
    }
    if (parts.length === 4 && parts[1] === 'runs' && parts[3] === 'artifact') {
        const runId = safeDecode(parts[2]);
        const artifactPath = searchParams.get('path');
        if (runId === null)
            return { badRequest: 'Malformed run id' };
        if (!artifactPath)
            return { badRequest: 'Missing artifact path' };
        return ['artifact', runId, artifactPath];
    }
    return { notFound: true };
};
const handleApi = async (req, res, pathname) => {
    if (req.method !== 'GET') {
        jsonResponse(res, 405, errorBody(405, 'method_not_allowed', 'Only GET is supported'));
        return true;
    }
    const routed = routeApi(pathname, new URL(req.url || '/', 'http://127.0.0.1').searchParams);
    if (routed === null)
        return false;
    if ('badRequest' in routed) {
        jsonResponse(res, 400, errorBody(400, 'bad_request', routed.badRequest));
        return true;
    }
    if ('notFound' in routed) {
        jsonResponse(res, 404, errorBody(404, 'not_found', 'API route not found'));
        return true;
    }
    const result = await runControlPlane(routed);
    jsonResponse(res, result.status, result.body);
    return true;
};
const staticPath = (pathname) => {
    const requested = pathname === '/' ? '/index.html' : pathname;
    const decoded = safeDecode(requested);
    if (decoded === null)
        return null;
    const resolved = path.resolve(STATIC_DIR, `.${decoded}`);
    if (!resolved.startsWith(STATIC_DIR + path.sep) && resolved !== STATIC_DIR)
        return null;
    return resolved;
};
const serveStatic = (req, res, pathname) => {
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
        if (req.method === 'HEAD')
            res.end();
        else
            res.end(data);
    });
};
export const createServer = () => http.createServer(async (req, res) => {
    let parsed;
    try {
        parsed = new URL(req.url || '/', 'http://127.0.0.1');
    }
    catch (_error) {
        jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed URL'));
        return;
    }
    try {
        const handled = await handleApi(req, res, parsed.pathname);
        if (!handled)
            serveStatic(req, res, parsed.pathname);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        jsonResponse(res, 500, errorBody(500, 'internal_error', 'Unhandled server error', { message }));
    }
});
export const parseArgs = (argv) => {
    const opts = { host: DEFAULT_HOST, port: DEFAULT_PORT };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--port') {
            const value = argv[++i];
            if (value === undefined)
                throw new Error('Missing value for --port');
            const port = Number(value);
            if (!Number.isInteger(port) || port < 0 || port > 65535)
                throw new Error(`Invalid --port: ${value}`);
            opts.port = port;
        }
        else if (arg === '--host') {
            const value = argv[++i];
            if (value === undefined)
                throw new Error('Missing value for --host');
            opts.host = value;
        }
        else if (arg === '-h' || arg === '--help' || arg === 'help') {
            opts.help = true;
        }
        else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }
    return opts;
};
const printUsage = () => {
    console.log('Usage: tesseraft web [--host 127.0.0.1] [--port <port>]');
    console.log('Serve the local read-only Tesseraft Web UI.');
};
export const main = () => {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    }
    catch (error) {
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
if (process.argv[1] && path.resolve(process.argv[1]) === __filename)
    main();

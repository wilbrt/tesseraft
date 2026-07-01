#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { createServer, main, parseArgs, routeApi } from './dist-server/server.js';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

export { createServer, parseArgs, routeApi };

import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';
import { errorBody, jsonResponse } from '../lib/http.js';
import { ROOT_DIR } from '../lib/paths.js';
import { resolveWithin } from '../lib/pathConfinement.js';

type BrowseEntry = { name: string; is_dir: boolean; is_file: boolean };

export const createBrowseRouter = (): Router => {
  const router = express.Router();
  router.get('/browse', async (req, res, next) => {
    try {
      const rawPath = typeof req.query.path === 'string' && req.query.path.trim() !== '' ? req.query.path : '.';
      const resolved = resolveWithin(ROOT_DIR, rawPath);
      if (!resolved) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Path is outside the allowed root', { root: ROOT_DIR, requested: rawPath }));
      let real: string;
      let stat: fs.Stats;
      try { real = await fs.promises.realpath(resolved); stat = await fs.promises.stat(real); }
      catch { return jsonResponse(res, 404, errorBody(404, 'not_found', 'Path not found', { path: rawPath })); }
      if (!resolveWithin(ROOT_DIR, path.relative(ROOT_DIR, real))) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Resolved path is outside the allowed root', { root: ROOT_DIR }));
      if (!stat.isDirectory()) return jsonResponse(res, 200, { root: ROOT_DIR, path: real, is_file: true, is_dir: false, entries: [] });
      let names: string[];
      try { names = await fs.promises.readdir(real); } catch { names = []; }
      const entries: BrowseEntry[] = [];
      for (const name of names) {
        if (name.startsWith('.')) continue;
        try {
          const entryStat = await fs.promises.stat(path.join(real, name));
          entries.push({ name, is_dir: entryStat.isDirectory(), is_file: entryStat.isFile() });
        } catch { /* entry disappeared during listing */ }
      }
      entries.sort((a, b) => (Number(b.is_dir) - Number(a.is_dir)) || a.name.localeCompare(b.name));
      return jsonResponse(res, 200, { root: ROOT_DIR, path: real, is_file: false, is_dir: true, entries });
    } catch (error) { next(error); }
  });
  return router;
};

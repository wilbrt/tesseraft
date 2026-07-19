import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
export const SRC_SERVER_DIR = path.dirname(path.dirname(__filename));
// ROOT_DIR is always the real repo (where bin/tesseraft lives and where static
// assets live). It does NOT move with the workspace override.
export const ROOT_DIR = path.resolve(SRC_SERVER_DIR, '..', '..');
// WORKSPACE_ROOT is the mutable project workspace for control-plane/runtime
// subprocesses and Studio writes. Defaults to ROOT_DIR but tests can redirect it
// to a temp dir via env without moving the tesseraft binary or static assets.
export const WORKSPACE_ROOT = process.env.TESSERAFT_WORKSPACE_ROOT ? path.resolve(process.env.TESSERAFT_WORKSPACE_ROOT) : ROOT_DIR;
export const STATIC_DIR = path.join(ROOT_DIR, 'web', 'static');
export const tesseraftBin = (): string => path.join(ROOT_DIR, 'bin', 'tesseraft');

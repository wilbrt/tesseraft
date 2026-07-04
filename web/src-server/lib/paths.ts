import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
export const SRC_SERVER_DIR = path.dirname(path.dirname(__filename));
// ROOT_DIR is always the real repo (where bin/tesseraft lives and where the
// control plane runs). It does NOT move with the workspace override.
export const ROOT_DIR = path.resolve(SRC_SERVER_DIR, '..', '..');
// WORKSPACE_ROOT is where Studio writes workflow files (.tesseraft/workflows).
// Defaults to ROOT_DIR but tests can redirect it to a temp dir via env without
// moving the tesseraft binary or control-plane cwd.
export const WORKSPACE_ROOT = process.env.TESSERAFT_WORKSPACE_ROOT ? path.resolve(process.env.TESSERAFT_WORKSPACE_ROOT) : ROOT_DIR;
export const STATIC_DIR = path.join(ROOT_DIR, 'web', 'static');
export const tesseraftBin = (): string => path.join(ROOT_DIR, 'bin', 'tesseraft');

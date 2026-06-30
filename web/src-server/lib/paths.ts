import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
export const SRC_SERVER_DIR = path.dirname(path.dirname(__filename));
export const ROOT_DIR = path.resolve(SRC_SERVER_DIR, '..', '..');
export const STATIC_DIR = path.join(ROOT_DIR, 'web', 'static');
export const tesseraftBin = (): string => path.join(ROOT_DIR, 'bin', 'tesseraft');

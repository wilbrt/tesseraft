import { createContext, useContext } from 'react';

export const DEFAULT_PROJECT_ID = 'default';
const STORAGE_KEY = 'tesseraft.projectId';

export type ProjectContextValue = {
  projectId: string;
  setProjectId: (id: string) => void;
};

export const ProjectContext = createContext<ProjectContextValue>({
  projectId: DEFAULT_PROJECT_ID,
  setProjectId: () => {},
});

export const useProject = (): ProjectContextValue => useContext(ProjectContext);

export const loadProjectId = (): string => {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    return v && v.trim() !== '' ? v : DEFAULT_PROJECT_ID;
  } catch {
    return DEFAULT_PROJECT_ID;
  }
};

export const storeProjectId = (id: string): void => {
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
};

/** Build the canonical project-scoped API URL for a feature request. */
export const projectApiUrl = (path: string, projectId: string): string => {
  const trimmed = projectId && projectId.trim() !== '' ? projectId : DEFAULT_PROJECT_ID;
  if (!path.startsWith('/api/')) return path;
  const rest = path.slice('/api/'.length);
  return `/api/projects/${encodeURIComponent(trimmed)}/${rest}`;
};

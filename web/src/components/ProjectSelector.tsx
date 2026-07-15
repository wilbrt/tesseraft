import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson } from '../lib/api';
import { useProject } from '../lib/project';
import { Popover } from './Popover';

type ProjectListItem = { project_id: string; name?: string; source?: string };

export const ProjectSelector = (): JSX.Element => {
  const { projectId, setProjectId } = useProject();
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    getJson<{ projects: ProjectListItem[] }>('/api/projects')
      .then((data) => setProjects(data.projects || []))
      .catch(() => setProjects([]));
  }, []);

  return (
    <div className="project-selector" aria-label="Project selector">
      <button ref={buttonRef} type="button" className="project-selector-button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? 'project-selector-menu' : undefined}>
        <span className="project-selector-label"><strong>Project</strong>{projectId}</span>
        <span className="project-selector-caret" aria-hidden>▾</span>
      </button>
      <Popover anchorRef={buttonRef} open={open} onClose={close} className="project-selector-popover" testId="project-selector-popover">
        <ul id="project-selector-menu" className="project-selector-menu" role="listbox" data-testid="project-selector-menu">
          {projects.map((p) => (
            <li key={p.project_id}>
              <button
                type="button"
                role="option"
                aria-selected={p.project_id === projectId}
                className={p.project_id === projectId ? 'project-selector-item active' : 'project-selector-item'}
                onClick={() => { setProjectId(p.project_id); close(); }}
              >
                <span className="project-selector-id">{p.project_id}</span>
                {p.name && p.name !== p.project_id ? <span className="project-selector-name">{p.name}</span> : null}
              </button>
            </li>
          ))}
          {projects.length === 0 ? <li className="project-selector-empty">No projects</li> : null}
        </ul>
      </Popover>
    </div>
  );
};

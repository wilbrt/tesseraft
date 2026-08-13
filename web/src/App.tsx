import { useMemo, useState } from 'react';
import { WorkflowPanels } from './components/WorkflowPanels';
import { WorkflowStudio } from './components/WorkflowStudio';
import { RunListTable } from './components/RunListTable';
import { ApprovalInbox } from './components/ApprovalInbox';
import { RunControls } from './components/RunControls';
import { PiSessionsPanel } from './components/PiSessionsPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { FullWidthPage } from './components/PageLayout';
import { ProjectSelector } from './components/ProjectSelector';
import { useColorScheme } from './features/console/useColorScheme';
import { useConsoleData } from './features/console/useConsoleData';
import { isActiveRun } from './lib/runConsole';
import { ProjectContext, loadProjectId, storeProjectId } from './lib/project';
import './style.css';

type ActiveTab = 'workflows' | 'runs' | 'approvals' | 'pi-sessions' | 'settings' | 'studio';

export const App = () => {
  const [projectId, setProjectIdState] = useState<string>(loadProjectId);
  const setProjectId = (id: string): void => { storeProjectId(id); setProjectIdState(id); };
  const projectContextValue = useMemo(() => ({ projectId, setProjectId }), [projectId]);
  const [activeTab, setActiveTab] = useState<ActiveTab>('workflows');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [studioWorkflowName, setStudioWorkflowName] = useState<string | null>(null);
  const [colorScheme, setColorScheme] = useColorScheme(projectId);
  const consoleData = useConsoleData(projectId, () => setActiveTab('runs'));
  const { workflows, runs, selectedWorkflow, workflowDetail, graph, selectedNodeId,
    workflowError, selectedRun, runDetail, events, artifacts, runError, lastRunRefresh,
    setSelectedNodeId, selectWorkflow, refreshWorkflows, refreshAfterMutation, handleToggleRow } = consoleData;
  const activeSectionLabel: Record<ActiveTab, string> = {
    workflows: 'Workflows',
    runs: 'Runs',
    approvals: 'Approvals',
    'pi-sessions': 'Pi Sessions',
    'settings': 'Settings',
    studio: 'Workflow Studio'
  };
  const runStatus = runDetail?.status || (selectedRun ? 'loading' : null);
  const streamFreshness = runDetail && isActiveRun(runDetail) ? `Streaming · ${lastRunRefresh || 'pending'}` : 'Stream idle';

  return (
    <ProjectContext.Provider value={projectContextValue}>
    <div className="app-shell" data-color-scheme={colorScheme}>
      <header>
        <div className="header-topline">
          <h1>Tesseraft Console</h1>
          <ProjectSelector />
          <span className="status-pill">{activeSectionLabel[activeTab]}</span>
          {(activeTab === 'workflows' || activeTab === 'runs') && (
            <button type="button" className="header-start-button" onClick={() => setWizardOpen(true)}>Start workflow</button>
          )}
          {activeTab === 'workflows' && (
            <button type="button" className="header-start-button" onClick={() => { setStudioWorkflowName(null); setActiveTab('studio'); }}>Studio</button>
          )}
        </div>
        <div className="context-strip" aria-label="Current console context">
          <span className="context-chip"><strong>Workflow</strong>{selectedWorkflow || 'No workflow selected'}</span>
          <span className="context-chip"><strong>Run</strong>{selectedRun ? `${selectedRun}${runStatus ? ` · ${runStatus}` : ''}` : 'No run selected'}</span>
          <span className="context-chip"><strong>Graph node</strong>{selectedNodeId || 'No node selected'}</span>
          <span className="context-chip"><strong>Project</strong>{projectId}</span>
          <span className="context-chip"><strong>Refresh</strong>{streamFreshness}</span>
        </div>
        <nav className="tabs" aria-label="Run Console sections">
          <button type="button" className={activeTab === 'workflows' ? 'active' : ''} aria-pressed={activeTab === 'workflows'} aria-label="Workflows: inspect workflow graphs" onClick={() => setActiveTab('workflows')}>Workflows <span>inspect</span></button>
          <button type="button" className={activeTab === 'runs' ? 'active' : ''} aria-pressed={activeTab === 'runs'} aria-label="Runs: operate and inspect run status" onClick={() => setActiveTab('runs')}>Runs <span>operate</span></button>
          <button type="button" className={activeTab === 'approvals' ? 'active' : ''} aria-pressed={activeTab === 'approvals'} aria-label="Approvals: review pending decisions" onClick={() => setActiveTab('approvals')}>Approvals <span>review</span></button>
          <button type="button" className={activeTab === 'pi-sessions' ? 'active' : ''} aria-pressed={activeTab === 'pi-sessions'} aria-label="Pi Sessions: chat with Pi sessions" onClick={() => setActiveTab('pi-sessions')}>Pi Sessions <span>chat</span></button>
          <button type="button" className={activeTab === 'settings' ? 'active' : ''} aria-pressed={activeTab === 'settings'} aria-label="Settings: configure Pi defaults, credential references, repo root, and git identity" onClick={() => setActiveTab('settings')}>Settings <span>config</span></button>
          <button type="button" className={activeTab === 'studio' ? 'active' : ''} aria-pressed={activeTab === 'studio'} aria-label="Workflow Studio: author workflows on a canvas" onClick={() => { setActiveTab('studio'); setStudioWorkflowName(studioWorkflowName); }}>Studio <span>author</span></button>
        </nav>
      </header>
      <main>
        {activeTab === 'workflows' && (
          <WorkflowPanels workflows={workflows} selectedWorkflow={selectedWorkflow} workflowDetail={workflowDetail} graph={graph} selectedNodeId={selectedNodeId} workflowError={workflowError} onSelectWorkflow={selectWorkflow} onSelectNode={setSelectedNodeId} onOpenStudio={(name) => { setStudioWorkflowName(name); setActiveTab('studio'); }} onCreateWorkflow={() => { setStudioWorkflowName(null); setActiveTab('studio'); }} />
        )}
        {activeTab === 'runs' && (
          <>
            <RunListTable
              runs={runs}
              expandedRunId={selectedRun}
              runDetail={runDetail}
              events={events}
              artifacts={artifacts}
              runError={runError}
              selectedNodeId={selectedNodeId}
              lastRunRefresh={lastRunRefresh}
              onToggleRow={handleToggleRow}
              onSelectNode={setSelectedNodeId}
            />
          </>
        )}
        {activeTab === 'approvals' && <ApprovalInbox />}
        {activeTab === 'pi-sessions' && <PiSessionsPanel />}
        {activeTab === 'settings' && <FullWidthPage><SettingsPanel onColorSchemeChange={setColorScheme} /></FullWidthPage>}
        {activeTab === 'studio' && <WorkflowStudio initialWorkflowName={studioWorkflowName} onExit={() => setActiveTab('workflows')} onWorkflowsChanged={refreshWorkflows} />}
        {activeTab !== 'pi-sessions' && activeTab !== 'settings' && activeTab !== 'studio' && activeTab !== 'approvals' && <RunControls workflows={workflows.data} selectedWorkflow={selectedWorkflow} workflowDetail={workflowDetail} selectedRun={selectedRun} runDetail={runDetail} onRefresh={refreshAfterMutation} wizardOpen={wizardOpen} onWizardOpenChange={setWizardOpen} />}
      </main>
    </div>
    </ProjectContext.Provider>
  );
};

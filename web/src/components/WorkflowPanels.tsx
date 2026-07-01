import { WorkflowGraph } from './WorkflowGraph';
import { FieldList } from './FieldList';
import type { WorkflowDetail, WorkflowGraphState, WorkflowSummary } from '../types/runConsole';

export const WorkflowPanels = ({ workflows, selectedWorkflow, workflowDetail, graph, selectedNodeId, workflowError, onSelectWorkflow, onSelectNode }: {
  workflows: { data: WorkflowSummary[]; error: string | null };
  selectedWorkflow: string | null;
  workflowDetail: WorkflowDetail | null;
  graph: WorkflowGraphState;
  selectedNodeId: string | null;
  workflowError: string | null;
  onSelectWorkflow: (name: string) => Promise<void>;
  onSelectNode: (nodeId: string) => void;
}) => (
  <>
    <section className="panel">
      <h2>Workflows</h2>
      {workflows.error && <div className="error">{workflows.error}</div>}
      <ul className="item-list">
        {workflows.data.length === 0 && <li className="muted">No workflows found.</li>}
        {workflows.data.map((workflow) => {
          const selected = workflow.name === selectedWorkflow;
          return (
            <li key={workflow.name} className={selected ? 'selected-row' : undefined} aria-current={selected ? 'true' : undefined}>
              <button type="button" onClick={() => onSelectWorkflow(workflow.name)}>{workflow.name || '(unnamed)'}</button>
              <span>{workflow.path}</span>
            </li>
          );
        })}
      </ul>
    </section>
    <section className="panel detail">
      <h2>Workflow detail</h2>
      {workflowError && <div className="error">{workflowError}</div>}
      {!workflowDetail && !workflowError && <div className="empty">{selectedWorkflow ? 'Loading workflow...' : 'Select a workflow.'}</div>}
      {workflowDetail && <FieldList fields={[["Name", workflowDetail.name], ["Path", workflowDetail.path], ["API version", workflowDetail.api_version], ["Lint status", workflowDetail.lint?.ok ? 'Pass' : 'Has issues'], ["Graph node selected", selectedNodeId || 'None']]} />}
      <WorkflowGraph nodes={graph.nodes} edges={graph.edges} selectedNodeId={selectedNodeId} onSelectNode={(node) => onSelectNode(node.id)} />
    </section>
  </>
);

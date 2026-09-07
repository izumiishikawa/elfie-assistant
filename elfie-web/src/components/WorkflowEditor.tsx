import {
  ReactFlow, Background, Controls, addEdge, useNodesState, useEdgesState, Handle, Position,
  type Connection, type Edge as RFEdge, type Node as RFNode, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft, Clock, Copy, GitBranch, Globe, History, MessageSquare, Play, Plus, RefreshCw, Repeat, Trash2,
  Webhook as WebhookIcon, X,
} from 'lucide-react';
import { API_BASE } from '../constants';
import { TelegramIcon } from './icons/TelegramIcon';
import { Character } from '../stores/mainStore';
import { Routine } from '../stores/routinesStore';
import {
  Workflow, WorkflowNode, WorkflowNodeType, WorkflowRun, useWorkflowsStore,
} from '../stores/workflowsStore';


const fieldLabel = 'text-gray-400 text-[10px] font-bold tracking-widest mb-1.5 m-0';
const smallInput = 'text-white text-[13px] bg-foreground border border-foreground rounded-xl px-3 py-2 outline-none w-full placeholder:text-gray-400';
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad2 = (n: number) => String(n).padStart(2, '0');

const Spinner = () => <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent spin" />;

const Switch = ({ checked, onChange, size = 'md' }: { checked: boolean; onChange: () => void; size?: 'sm' | 'md' }) => {
  const dims = size === 'sm' ? { w: 34, h: 20, thumb: 14 } : { w: 40, h: 24, thumb: 18 };
  const pad = (dims.h - dims.thumb) / 2;
  return (
    <motion.button
      type="button"
      onClick={onChange}
      whileTap={{ scale: 0.92 }}
      className="relative rounded-full border-none cursor-pointer p-0 flex-shrink-0"
      style={{ width: dims.w, height: dims.h, backgroundColor: checked ? '#3a3a46' : '#232329' }}
      animate={{ backgroundColor: checked ? '#3a3a46' : '#232329' }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        className="absolute rounded-full shadow-sm"
        style={{ width: dims.thumb, height: dims.thumb, top: pad }}
        animate={{ x: checked ? dims.w - dims.thumb - pad : pad, backgroundColor: checked ? 'var(--accent)' : '#8a8a94' }}
        transition={{ type: 'spring', stiffness: 500, damping: 32 }}
      />
    </motion.button>
  );
};


const TRIGGER_TYPES = new Set<WorkflowNodeType>(['webhook', 'schedule', 'routine']);

const NODE_META: Record<WorkflowNodeType, { label: string; icon: React.ReactNode; color: string }> = {
  webhook: { label: 'Webhook', icon: <WebhookIcon size={13} />, color: '#5b9cff' },
  schedule: { label: 'Scheduled', icon: <Clock size={13} />, color: '#5b9cff' },
  routine: { label: 'Routine', icon: <Repeat size={13} />, color: '#5b9cff' },
  prompt: { label: 'Prompt', icon: <MessageSquare size={13} />, color: '#7dd3a8' },
  condition: { label: 'Condition', icon: <GitBranch size={13} />, color: '#f0c674' },
  http_request: { label: 'HTTP', icon: <Globe size={13} />, color: '#e29ce2' },
  telegram_message: { label: 'Telegram', icon: <TelegramIcon size={13} />, color: '#2AABEE' },
};

const NODE_DEFAULT_DATA: Record<WorkflowNodeType, Record<string, any>> = {
  webhook: {},
  schedule: { hour: 9, minute: 0, daysOfWeek: [] },
  routine: {},
  prompt: { prompt: '', forceTts: false, notify: false },
  condition: { mode: 'field', field: '', operator: 'equals', value: '' },
  http_request: { method: 'GET', urlTemplate: '', headers: [], bodyTemplate: '' },
  telegram_message: { message: '' },
};

function nodeSummary(type: WorkflowNodeType, data: Record<string, any>): string {
  switch (type) {
    case 'webhook':
      return 'Receives an external call';
    case 'schedule':
      return `${pad2(data.hour ?? 9)}:${pad2(data.minute ?? 0)}`;
    case 'routine':
      return 'Triggered by a routine';
    case 'prompt':
      return (data.prompt || 'Empty prompt').slice(0, 70);
    case 'condition':
      return data.mode === 'llm'
        ? (data.question || 'Empty question').slice(0, 60)
        : `${data.field || '?'} ${data.operator || '?'} ${data.value ?? ''}`.trim();
    case 'http_request':
      return `${data.method || 'GET'} ${data.urlTemplate || ''}`.slice(0, 70);
    case 'telegram_message':
      return (data.message || 'Empty message').slice(0, 70);
    default:
      return '';
  }
}

let nodeIdCounter = 0;
function newNodeId() {
  return `node_${Date.now()}_${nodeIdCounter++}`;
}
function newEdgeId() {
  return `edge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const handleStyle: React.CSSProperties = {
  width: 16,
  height: 16,
  border: '2px solid #0e0e11',
};

function GenericNode({ id, data, selected, kind }: NodeProps & { kind: WorkflowNodeType }) {
  const meta = NODE_META[kind];
  const isTrigger = TRIGGER_TYPES.has(kind);
  const isCondition = kind === 'condition';
  return (
    <div
      className="rounded-2xl border px-4 py-3.5"
      style={{
        minWidth: 240,
        maxWidth: 280,
        background: '#17171b',
        borderColor: selected ? 'var(--accent)' : '#2a2a30',
        borderWidth: selected ? 2 : 1,
      }}
    >
      {!isTrigger && (
        <Handle type="target" position={Position.Left} style={{ ...handleStyle, background: meta.color, left: -8 }} />
      )}
      <div className="flex items-center gap-1.5 mb-1.5">
        <span style={{ color: meta.color }}>{meta.icon}</span>
        <span className="text-white text-[12px] font-bold">{meta.label}</span>
      </div>
      <p className="text-gray-300 text-[11px] m-0 break-words leading-snug">{nodeSummary(kind, (data as any) || {})}</p>
      {isCondition ? (
        <>
          <Handle type="source" position={Position.Right} id="true" style={{ ...handleStyle, top: '28%', right: -8, background: '#3ecf6e' }} />
          <Handle type="source" position={Position.Right} id="false" style={{ ...handleStyle, top: '78%', right: -8, background: '#ff5c5c' }} />
          <div className="flex flex-col mt-3" style={{ gap: 14 }}>
            <span className="text-[10px] font-bold text-green-400 text-right">Yes</span>
            <span className="text-[10px] font-bold text-red-400 text-right">No</span>
          </div>
        </>
      ) : (
        <Handle type="source" position={Position.Right} style={{ ...handleStyle, background: meta.color, right: -8 }} />
      )}
    </div>
  );
}

const NODE_TYPES = {
  webhook: (props: NodeProps) => <GenericNode {...props} kind="webhook" />,
  schedule: (props: NodeProps) => <GenericNode {...props} kind="schedule" />,
  routine: (props: NodeProps) => <GenericNode {...props} kind="routine" />,
  prompt: (props: NodeProps) => <GenericNode {...props} kind="prompt" />,
  condition: (props: NodeProps) => <GenericNode {...props} kind="condition" />,
  http_request: (props: NodeProps) => <GenericNode {...props} kind="http_request" />,
  telegram_message: (props: NodeProps) => <GenericNode {...props} kind="telegram_message" />,
};


function HttpRequestFields({ data, onPatch }: { data: Record<string, any>; onPatch: (patch: Record<string, any>) => void }) {
  const headers: { key: string; value: string }[] = data.headers ?? [];
  const updateHeader = (idx: number, patch: Partial<{ key: string; value: string }>) => {
    onPatch({ headers: headers.map((h, i) => (i === idx ? { ...h, ...patch } : h)) });
  };
  const addHeader = () => onPatch({ headers: [...headers, { key: '', value: '' }] });
  const removeHeader = (idx: number) => onPatch({ headers: headers.filter((_, i) => i !== idx) });
  const hasBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(data.method || 'GET');

  return (
    <>
      <p className={fieldLabel}>METHOD AND URL</p>
      <div className="flex gap-2 mb-4">
        <select value={data.method ?? 'GET'} onChange={(e) => onPatch({ method: e.target.value })} className={smallInput} style={{ width: 92, flexShrink: 0 }}>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input
          value={data.urlTemplate ?? ''}
          onChange={(e) => onPatch({ urlTemplate: e.target.value })}
          placeholder="https://api.example.com/reports/{{trigger.body.id}}"
          className={smallInput}
        />
      </div>

      <p className={fieldLabel}>HEADERS</p>
      <div className="flex flex-col gap-1.5 mb-2">
        {headers.map((h, idx) => (
          <div key={idx} className="flex gap-1.5">
            <input value={h.key} onChange={(e) => updateHeader(idx, { key: e.target.value })} placeholder="Header" className={smallInput} />
            <input value={h.value} onChange={(e) => updateHeader(idx, { value: e.target.value })} placeholder="Value" className={smallInput} />
            <button onClick={() => removeHeader(idx)} className="p-2 rounded-lg border-none cursor-pointer bg-transparent hover:bg-destructive/10 flex-shrink-0">
              <Trash2 size={12} color="#ff382b" />
            </button>
          </div>
        ))}
      </div>
      <motion.button
        onClick={addHeader}
        whileHover={{ scale: 1.03 }}
        whileTap={{ scale: 0.96 }}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border-none cursor-pointer bg-foreground hover:bg-foreground/70 mb-4"
      >
        <Plus size={11} color="#aaa" />
        <span className="text-gray-300 text-[11px] font-semibold">Add header</span>
      </motion.button>

      {hasBody && (
        <>
          <p className={fieldLabel}>BODY</p>
          <textarea
            value={data.bodyTemplate ?? ''}
            onChange={(e) => onPatch({ bodyTemplate: e.target.value })}
            placeholder='{"status": "{{trigger.body.status}}"}'
            className="text-white text-[12px] font-mono border border-foreground rounded-2xl px-4 py-3 outline-none resize-none w-full placeholder:text-gray-400 bg-foreground"
            style={{ minHeight: 100 }}
          />
        </>
      )}
    </>
  );
}


function NodeConfigPanel({ node, onPatch, onDelete, webhookUrl, webhookSecret, onRegenerate, onCopy, copied, linkedRoutines }: {
  node: RFNode;
  onPatch: (patch: Record<string, any>) => void;
  onDelete: () => void;
  webhookUrl: string | null;
  webhookSecret: string | null;
  onRegenerate: () => void;
  onCopy: (text: string) => void;
  copied: boolean;
  linkedRoutines: Routine[];
}) {
  const data = (node.data as Record<string, any>) || {};
  const type = node.type as WorkflowNodeType;
  const meta = NODE_META[type];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3.5 border-b border-foreground flex-shrink-0">
        <span style={{ color: meta.color }}>{meta.icon}</span>
        <span className="text-white font-semibold text-[13px] flex-1 truncate">{meta.label}</span>
        <button onClick={onDelete} className="p-1.5 rounded-full border-none cursor-pointer bg-transparent hover:bg-destructive/10">
          <Trash2 size={13} color="#ff382b" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {type === 'webhook' && (
          webhookUrl ? (
            <>
              <p className={fieldLabel}>WEBHOOK URL</p>
              <div className="flex items-center gap-1.5 mb-3">
                <input readOnly value={webhookUrl} onFocus={(e) => e.target.select()} className={`${smallInput} text-[11px]`} />
                <button onClick={() => onCopy(webhookUrl)} className="p-2 rounded-lg border-none cursor-pointer bg-foreground hover:bg-foreground/70 flex-shrink-0">
                  <Copy size={12} color="#aaa" />
                </button>
              </div>
              <p className={fieldLabel}>SECRET (header X-Webhook-Secret)</p>
              <div className="flex items-center gap-1.5 mb-2">
                <input readOnly value={webhookSecret ?? ''} onFocus={(e) => e.target.select()} className={`${smallInput} text-[11px]`} />
                <button
                  onClick={() => webhookSecret && onCopy(webhookSecret)}
                  className="p-2 rounded-lg border-none cursor-pointer bg-foreground hover:bg-foreground/70 flex-shrink-0"
                >
                  <Copy size={12} color="#aaa" />
                </button>
              </div>
              {copied && <p className="text-accent text-[11px] mb-2 m-0">Copied!</p>}
              <motion.button
                onClick={onRegenerate}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.96 }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border-none cursor-pointer bg-foreground hover:bg-foreground/70 mt-1"
              >
                <RefreshCw size={11} color="#aaa" />
                <span className="text-gray-300 text-[11px] font-semibold">Generate new token/secret</span>
              </motion.button>
              <p className="text-gray-300 text-[11px] mt-3 m-0">
                Whoever calls this URL needs to send the secret above in the <code>X-Webhook-Secret</code> header.
              </p>
            </>
          ) : (
            <p className="text-gray-300 text-[12px] m-0">Save the automation to generate the webhook URL.</p>
          )
        )}

        {type === 'schedule' && (
          <>
            <p className={fieldLabel}>TIME</p>
            <input
              type="time"
              value={`${pad2(data.hour ?? 9)}:${pad2(data.minute ?? 0)}`}
              onChange={(e) => {
                const [h, m] = e.target.value.split(':').map(Number);
                onPatch({ hour: h, minute: m });
              }}
              className={smallInput}
            />
            <p className={`${fieldLabel} mt-4`}>DAYS OF THE WEEK</p>
            <div className="flex flex-wrap gap-1.5">
              {DAY_LABELS.map((label, d) => {
                const days: number[] = data.daysOfWeek ?? [];
                const active = days.includes(d);
                return (
                  <button
                    key={d}
                    onClick={() => onPatch({ daysOfWeek: active ? days.filter((x) => x !== d) : [...days, d].sort() })}
                    className={`px-3 py-1.5 rounded-full text-[11px] font-semibold border-none cursor-pointer ${active ? 'bg-accent text-white' : 'bg-foreground text-gray-400'}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <p className="text-gray-300 text-[11px] mt-1.5 m-0">No day selected = every day.</p>
          </>
        )}

        {type === 'routine' && (
          <>
            <p className="text-gray-300 text-[12px] mb-4 m-0">
              This node triggers whenever a routine configured to point to this automation runs
              (the "Triggered automations" field on the Routines screen).
            </p>
            <p className={fieldLabel}>ROUTINES LINKED TO THIS AUTOMATION</p>
            {linkedRoutines.length === 0 ? (
              <p className="text-gray-500 text-[12px] m-0">None yet.</p>
            ) : (
              <div className="flex flex-col gap-1">
                {linkedRoutines.map((r) => (
                  <p key={r._id} className="text-white text-[12px] m-0">{r.name}</p>
                ))}
              </div>
            )}
          </>
        )}

        {type === 'prompt' && (
          <>
            <p className={fieldLabel}>PROMPT</p>
            <textarea
              value={data.prompt ?? ''}
              onChange={(e) => onPatch({ prompt: e.target.value })}
              placeholder="E.g.: Read the report {{trigger.body.title}} and decide what to do..."
              className="text-white text-[13px] border border-foreground rounded-2xl px-4 py-3 outline-none resize-none w-full placeholder:text-gray-400 bg-foreground"
              style={{ minHeight: 140 }}
            />
            <p className="text-gray-300 text-[11px] mt-1.5 mb-4 m-0">
              Use {'{{trigger.body.x}}'} for the trigger payload, or {'{{steps.<id>.output}}'} for the output of a previous
              step. It can use the same tools as a normal conversation.
            </p>
            <div className="mb-3 flex items-center justify-between">
              <p className={`${fieldLabel} mb-0`}>PUSH NOTIFICATION</p>
              <Switch checked={!!data.notify} onChange={() => onPatch({ notify: !data.notify })} />
            </div>
            <div className="flex items-center justify-between">
              <p className={`${fieldLabel} mb-0`}>FORCE TTS</p>
              <Switch checked={!!data.forceTts} onChange={() => onPatch({ forceTts: !data.forceTts })} />
            </div>
          </>
        )}

        {type === 'condition' && (
          <>
            <p className={fieldLabel}>MODE</p>
            <div className="flex gap-1.5 mb-4">
              <button
                onClick={() => onPatch({ mode: 'field' })}
                className={`flex-1 py-1.5 rounded-full text-[11px] font-semibold border-none cursor-pointer ${data.mode !== 'llm' ? 'bg-accent text-white' : 'bg-foreground text-gray-400'}`}
              >
                Field
              </button>
              <button
                onClick={() => onPatch({ mode: 'llm' })}
                className={`flex-1 py-1.5 rounded-full text-[11px] font-semibold border-none cursor-pointer ${data.mode === 'llm' ? 'bg-accent text-white' : 'bg-foreground text-gray-400'}`}
              >
                Ask Elfie
              </button>
            </div>
            {data.mode === 'llm' ? (
              <>
                <p className={fieldLabel}>QUESTION (yes/no)</p>
                <textarea
                  value={data.question ?? ''}
                  onChange={(e) => onPatch({ question: e.target.value })}
                  placeholder="E.g.: Does the report {{trigger.body.title}} mention a critical bug?"
                  className="text-white text-[13px] border border-foreground rounded-2xl px-4 py-3 outline-none resize-none w-full placeholder:text-gray-400 bg-foreground"
                  style={{ minHeight: 100 }}
                />
              </>
            ) : (
              <>
                <p className={fieldLabel}>FIELD</p>
                <input
                  value={data.field ?? ''}
                  onChange={(e) => onPatch({ field: e.target.value })}
                  placeholder="{{trigger.body.status}}"
                  className={`${smallInput} mb-3`}
                />
                <p className={fieldLabel}>OPERATOR</p>
                <select
                  value={data.operator ?? 'equals'}
                  onChange={(e) => onPatch({ operator: e.target.value })}
                  className={`${smallInput} mb-3`}
                >
                  <option value="equals">Equals</option>
                  <option value="not_equals">Not equal to</option>
                  <option value="contains">Contains</option>
                  <option value="greater_than">Greater than</option>
                  <option value="less_than">Less than</option>
                  <option value="exists">Exists / is not empty</option>
                </select>
                {data.operator !== 'exists' && (
                  <>
                    <p className={fieldLabel}>VALUE</p>
                    <input value={data.value ?? ''} onChange={(e) => onPatch({ value: e.target.value })} className={smallInput} />
                  </>
                )}
              </>
            )}
            <p className="text-gray-300 text-[11px] mt-3 m-0">The node's two outputs ("Yes" / "No") decide which path to follow.</p>
          </>
        )}

        {type === 'http_request' && <HttpRequestFields data={data} onPatch={onPatch} />}

        {type === 'telegram_message' && (
          <>
            <p className={fieldLabel}>MESSAGE</p>
            <textarea
              value={data.message ?? ''}
              onChange={(e) => onPatch({ message: e.target.value })}
              placeholder="E.g.: New report received: {{trigger.body.title}}"
              className="text-white text-[13px] border border-foreground rounded-2xl px-4 py-3 outline-none resize-none w-full placeholder:text-gray-400 bg-foreground"
              style={{ minHeight: 140 }}
            />
            <p className="text-gray-300 text-[11px] mt-1.5 m-0">
              Use {'{{trigger.body.x}}'} for the trigger payload, or {'{{steps.<id>.output}}'} for the output of a previous
              step. Sent to the Telegram account currently linked in Settings.
            </p>
          </>
        )}
      </div>
    </div>
  );
}


function RunHistoryPanel({ runs, onClose }: { runs: WorkflowRun[]; onClose: () => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3.5 border-b border-foreground flex-shrink-0">
        <History size={14} color="#aaa" />
        <span className="text-white font-semibold text-[13px] flex-1">History</span>
        <button onClick={onClose} className="p-1.5 rounded-full border-none cursor-pointer bg-transparent hover:bg-foreground/60">
          <X size={13} color="#888" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {runs.length === 0 && <p className="text-gray-500 text-[12px] text-center py-8 m-0">No runs yet.</p>}
        <div className="flex flex-col gap-2">
          {runs.map((run) => (
            <div key={run._id} className="rounded-xl bg-foreground px-3 py-2.5 cursor-pointer" onClick={() => setExpanded((id) => (id === run._id ? null : run._id))}>
              <div className="flex items-center justify-between">
                <span
                  className={`text-[11px] font-bold ${run.status === 'success' ? 'text-green-400' : run.status === 'error' ? 'text-destructive' : 'text-gray-400'}`}
                >
                  {run.status === 'success' ? 'Success' : run.status === 'error' ? 'Error' : 'Running'}
                </span>
                <span className="text-gray-400 text-[10px]">{new Date(run.startedAt).toLocaleString('pt-BR')}</span>
              </div>
              <p className="text-gray-300 text-[10px] m-0 mt-0.5">trigger: {run.trigger.type}</p>
              {expanded === run._id && (
                <div className="mt-2 pt-2 border-t border-background flex flex-col gap-1.5">
                  {run.steps.map((s, i) => (
                    <div key={i}>
                      <p className={`text-[10px] font-semibold m-0 ${s.status === 'error' ? 'text-destructive' : 'text-white'}`}>
                        {s.nodeType} — {s.status}
                      </p>
                      {s.error && <p className="text-destructive text-[10px] m-0">{s.error}</p>}
                      {!s.error && s.output != null && (
                        <p className="text-gray-400 text-[10px] m-0 truncate">
                          {typeof s.output === 'string' ? s.output : JSON.stringify(s.output)}
                        </p>
                      )}
                    </div>
                  ))}
                  {run.error && <p className="text-destructive text-[10px] m-0">{run.error}</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


export default function WorkflowEditor({ workflowId, characters, routines, onClose }: {
  workflowId: string;
  characters: Character[];
  routines: Routine[];
  onClose: () => void;
}) {
  const { workflows, updateWorkflow, deleteWorkflow, regenerateWebhook, runWorkflowNow, loadRuns, runs } = useWorkflowsStore();
  const workflow = useMemo(() => workflows.find((w) => w._id === workflowId) ?? null, [workflows, workflowId]);
  const [deleting, setDeleting] = useState(false);

  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>([]);
  const [name, setName] = useState(workflow?.name ?? '');
  const [enabled, setEnabled] = useState(workflow?.enabled ?? true);
  const [characterId, setCharacterId] = useState(workflow?.characterId ?? '');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [showTestModal, setShowTestModal] = useState(false);
  const [testPayload, setTestPayload] = useState('{}');
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!workflow) return;
    setNodes(workflow.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data || {} })));
    setEdges(
      workflow.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        label: e.sourceHandle === 'true' ? 'Yes' : e.sourceHandle === 'false' ? 'No' : undefined,
      })),
    );
    setName(workflow.name);
    setEnabled(workflow.enabled);
    setCharacterId(workflow.characterId ?? '');
  }, [workflowId]);

  useEffect(() => {
    if (showHistory) loadRuns(workflowId);
  }, [showHistory, workflowId, loadRuns]);

  const onConnect = useCallback((connection: Connection) => {
    setEdges((eds) => addEdge(
      {
        ...connection,
        id: newEdgeId(),
        label: connection.sourceHandle === 'true' ? 'Yes' : connection.sourceHandle === 'false' ? 'No' : undefined,
      },
      eds,
    ));
  }, [setEdges]);

  const addNode = useCallback((type: WorkflowNodeType) => {
    const id = newNodeId();
    setNodes((nds) => [...nds, { id, type, position: { x: 120 + nds.length * 30, y: 100 + nds.length * 30 }, data: { ...NODE_DEFAULT_DATA[type] } }]);
    setSelectedNodeId(id);
    setShowHistory(false);
  }, [setNodes]);

  const onNodeClick = useCallback((_e: unknown, node: RFNode) => {
    setSelectedNodeId(node.id);
    setShowHistory(false);
  }, []);
  const onPaneClick = useCallback(() => setSelectedNodeId(null), []);

  const deleteSelectedNode = useCallback(() => {
    if (!selectedNodeId) return;
    setNodes((nds) => nds.filter((n) => n.id !== selectedNodeId));
    setEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
    setSelectedNodeId(null);
  }, [selectedNodeId, setNodes, setEdges]);

  const onNodesDelete = useCallback((deleted: RFNode[]) => {
    const ids = new Set(deleted.map((n) => n.id));
    setEdges((eds) => eds.filter((e) => !ids.has(e.source) && !ids.has(e.target)));
    setSelectedNodeId((sel) => (sel && ids.has(sel) ? null : sel));
  }, [setEdges]);

  const patchSelectedNodeData = useCallback((patch: Record<string, any>) => {
    if (!selectedNodeId) return;
    setNodes((nds) => nds.map((n) => (n.id === selectedNodeId ? { ...n, data: { ...(n.data as any), ...patch } } : n)));
  }, [selectedNodeId, setNodes]);

  const save = useCallback(async () => {
    if (!name.trim()) { setError('Name required.'); return; }
    setError('');
    setSaving(true);
    const payloadNodes: WorkflowNode[] = nodes.map((n) => ({
      id: n.id,
      type: n.type as WorkflowNodeType,
      position: n.position,
      data: (n.data as Record<string, any>) || {},
    }));
    const payloadEdges = edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: (e.sourceHandle as 'true' | 'false' | undefined) ?? null,
    }));
    const result = await updateWorkflow(workflowId, {
      name: name.trim(), enabled, characterId: characterId || null, nodes: payloadNodes, edges: payloadEdges,
    });
    setSaving(false);
    if (!result.ok) setError(result.error || 'Failed to save.');
  }, [name, enabled, characterId, nodes, edges, workflowId, updateWorkflow]);

  const handleDelete = useCallback(async () => {
    if (!window.confirm(`Delete automation "${name || 'untitled'}"? This cannot be undone.`)) return;
    setDeleting(true);
    await deleteWorkflow(workflowId);
    setDeleting(false);
    onClose();
  }, [name, workflowId, deleteWorkflow, onClose]);

  const runTest = useCallback(async () => {
    let payload: any = {};
    try {
      payload = testPayload.trim() ? JSON.parse(testPayload) : {};
    } catch {
      setError('Invalid test JSON.');
      return;
    }
    setError('');
    setTesting(true);
    const result = await runWorkflowNow(workflowId, payload);
    setTesting(false);
    if (result.ok) {
      setShowTestModal(false);
      setShowHistory(true);
      setSelectedNodeId(null);
    } else {
      setError(result.error || 'Test failed.');
    }
  }, [testPayload, workflowId, runWorkflowNow]);

  const regenerate = useCallback(async () => {
    if (!window.confirm('Generate a new token/secret? The old URL will stop working.')) return;
    await regenerateWebhook(workflowId);
  }, [workflowId, regenerateWebhook]);

  const copyText = useCallback((text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, []);

  const webhookUrl = workflow?.webhookToken ? `${API_BASE}/api/webhooks/${workflowId}/${workflow.webhookToken}` : null;
  const linkedRoutines = useMemo(() => routines.filter((r) => r.triggeredWorkflowIds?.includes(workflowId)), [routines, workflowId]);
  const selectedNode = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) ?? null : null;
  const workflowRuns = runs[workflowId] ?? [];

  if (!workflow) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3">
        <span className="text-gray-500 text-[13px]">Automation not found.</span>
        <button onClick={onClose} className="text-accent text-[12px] font-semibold bg-transparent border-none cursor-pointer">Back</button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-foreground flex-shrink-0">
        <motion.button
          onClick={onClose}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          className="w-8 h-8 rounded-full flex items-center justify-center bg-foreground border-none cursor-pointer hover:bg-foreground transition-colors flex-shrink-0"
        >
          <ChevronLeft size={16} color="#888" />
        </motion.button>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Automation name"
          className="text-white font-semibold text-[14px] bg-transparent border-none outline-none flex-1 min-w-0 placeholder:text-gray-500"
        />
        <select
          value={characterId}
          onChange={(e) => setCharacterId(e.target.value)}
          className="text-[11px] bg-foreground border-none rounded-full px-2.5 py-1.5 text-gray-300 outline-none flex-shrink-0"
        >
          <option value="">Active character</option>
          {characters.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
        </select>
        <Switch checked={enabled} onChange={() => setEnabled((v) => !v)} size="sm" />
        <motion.button
          onClick={() => { setShowHistory((v) => !v); setSelectedNodeId(null); }}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.94 }}
          className={`p-2 rounded-full border-none cursor-pointer flex-shrink-0 ${showHistory ? 'bg-accent/20' : 'bg-foreground hover:bg-foreground/70'}`}
        >
          <History size={14} color={showHistory ? 'var(--accent)' : '#aaa'} />
        </motion.button>
        <motion.button
          onClick={() => setShowTestModal(true)}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.95 }}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border-none cursor-pointer transition-colors bg-accent/[0.12] hover:bg-accent/20 flex-shrink-0"
        >
          <Play size={11} color="var(--accent)" />
          <span className="text-accent font-semibold text-[12px]">Test</span>
        </motion.button>
        <motion.button
          onClick={handleDelete}
          disabled={deleting}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.94 }}
          title="Delete automation"
          className="p-2 rounded-full border-none cursor-pointer flex-shrink-0 bg-foreground hover:bg-destructive/10 disabled:opacity-50 transition-colors"
        >
          {deleting ? <Spinner /> : <Trash2 size={14} color="#ff382b" />}
        </motion.button>
        <motion.button
          onClick={save}
          disabled={saving}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.95 }}
          className="h-8 px-5 rounded-full bg-accent border-none cursor-pointer flex items-center justify-center min-w-[70px] disabled:opacity-50 transition-opacity flex-shrink-0"
        >
          {saving ? <Spinner /> : <span className="text-white font-bold text-[12px]">Save</span>}
        </motion.button>
      </div>

      {error && (
        <div className="px-4 py-2 bg-destructive/10 border-b border-destructive/30 flex-shrink-0">
          <span className="text-destructive text-[12px]">{error}</span>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 relative">
          <div className="absolute top-3 left-3 z-10 flex flex-col gap-1 bg-background/95 border border-foreground rounded-2xl p-2" style={{ backdropFilter: 'blur(6px)' }}>
            {(Object.keys(NODE_META) as WorkflowNodeType[]).map((type) => {
              const meta = NODE_META[type];
              return (
                <button
                  key={type}
                  onClick={() => addNode(type)}
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl border-none cursor-pointer bg-transparent hover:bg-foreground text-left"
                >
                  <span style={{ color: meta.color }}>{meta.icon}</span>
                  <span className="text-gray-300 text-[11px] font-medium whitespace-nowrap">{meta.label}</span>
                </button>
              );
            })}
          </div>

          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onNodesDelete={onNodesDelete}
            nodeTypes={NODE_TYPES}
            colorMode="dark"
            fitView
            minZoom={0.4}
            connectionRadius={40}
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background gap={16} size={1} color="#2a2a30" />
            <Controls showInteractive={false} />
          </ReactFlow>

          {showTestModal && (
            <div
              className="absolute inset-0 z-20 flex items-center justify-center"
              style={{ background: 'rgba(0,0,0,0.6)' }}
              onClick={() => setShowTestModal(false)}
            >
              <div className="bg-background border border-foreground rounded-2xl p-5" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
                <p className="text-white font-semibold text-[14px] mb-3 m-0">Test automation</p>
                <p className={fieldLabel}>SAMPLE PAYLOAD (JSON)</p>
                <p className="text-gray-300 text-[11px] mt-0.5 mb-2 m-0">Becomes the {'{{trigger.body}}'} available to the nodes, as if it were the body of a real webhook.</p>
                <textarea
                  value={testPayload}
                  onChange={(e) => setTestPayload(e.target.value)}
                  className="text-white text-[12px] font-mono border border-foreground rounded-xl px-3 py-2.5 outline-none resize-none w-full bg-foreground"
                  style={{ minHeight: 120 }}
                />
                <div className="flex justify-end gap-2 mt-3">
                  <button
                    onClick={() => setShowTestModal(false)}
                    className="px-4 py-2 rounded-full border-none cursor-pointer bg-foreground text-gray-300 text-[12px] font-semibold"
                  >
                    Cancel
                  </button>
                  <motion.button
                    onClick={runTest}
                    disabled={testing}
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.96 }}
                    className="px-4 py-2 rounded-full border-none cursor-pointer bg-accent text-white text-[12px] font-semibold disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {testing && <Spinner />}
                    {testing ? 'Running...' : 'Run'}
                  </motion.button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="border-l border-foreground flex flex-col overflow-hidden flex-shrink-0" style={{ width: 320 }}>
          {showHistory ? (
            <RunHistoryPanel runs={workflowRuns} onClose={() => setShowHistory(false)} />
          ) : selectedNode ? (
            <NodeConfigPanel
              node={selectedNode}
              onPatch={patchSelectedNodeData}
              onDelete={deleteSelectedNode}
              webhookUrl={webhookUrl}
              webhookSecret={workflow.webhookSecret}
              onRegenerate={regenerate}
              onCopy={copyText}
              copied={copied}
              linkedRoutines={linkedRoutines}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center p-6">
              <p className="text-gray-500 text-[12px] text-center m-0">
                Click a node in the palette to add it, connect the dots by dragging the handles, and click a node to edit it.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

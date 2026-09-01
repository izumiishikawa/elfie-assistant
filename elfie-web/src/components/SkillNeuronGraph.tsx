import { Brain, Maximize2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { Skill, SkillPackage } from '../stores/skillsStore';
import type { KnowledgeFolder } from '../stores/knowledgeStore';
import type { Integration, IntegrationService } from '../stores/integrationsStore';
import { GmailIcon, GoogleCalendarIcon, GoogleDriveIcon, GooglePlayIcon } from './icons/GoogleBrandIcons';


interface SimNode extends SimulationNodeDatum {
  id: string;
  kind: 'core' | 'nucleus' | 'package' | 'skill' | 'kfolder' | 'kfile' | 'integration' | 'itool';
  label: string;
  enabled?: boolean;
  service?: IntegrationService;
  radius: number;
  onClick?: () => void;
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  id: string;
  distance: number;
}

const SIM_SIZE = 640;

const LINK_CURVE_BEND = 0.15;

const PRIMARY_DISTANCE_FACTOR = 0.46;
const CHILD_DISTANCE_FACTOR = 0.185;
const NUCLEUS_DISTANCE_FACTOR = 0.95;

const EMPTY_KNOWLEDGE_FOLDERS: KnowledgeFolder[] = [];
const EMPTY_INTEGRATIONS: Integration[] = [];

const SERVICE_LABELS: Record<IntegrationService, string> = {
  gmail: 'Gmail',
  calendar: 'Google Calendar',
  drive: 'Google Drive',
  playconsole: 'Play Console',
};

function computeFit(dims: { width: number; height: number }) {
  const viewScale = dims.width > 0 && dims.height > 0 ? Math.min(dims.width, dims.height) / SIM_SIZE : 1;
  return {
    viewScale,
    offsetX: (dims.width - SIM_SIZE * viewScale) / 2,
    offsetY: (dims.height - SIM_SIZE * viewScale) / 2,
  };
}

const NUCLEUS_CAPACITY = 8;
const NUCLEUS_MESH_THRESHOLD = 3;

function buildGraphData(
  packages: SkillPackage[],
  skills: Skill[],
  knowledgeFolders: KnowledgeFolder[],
  integrations: Integration[],
  aiName: string,
  cbRef: React.MutableRefObject<{
    onOpenPackage: (pkg: SkillPackage) => void;
    onOpenSkill: (skill: Skill) => void;
    onOpenKnowledgeFolder?: (folder: KnowledgeFolder) => void;
    onOpenKnowledgeFile?: (folder: KnowledgeFolder, file: string) => void;
    onOpenIntegration?: (service: IntegrationService) => void;
  }>,
): { nodes: SimNode[]; links: SimLink[] } {
  const scale = SIM_SIZE;
  const coreR = Math.max(8, Math.min(30, scale * 0.09));
  const nucleusR = coreR * 0.7;
  const pkgR = Math.max(6, Math.min(20, scale * 0.06));
  const skillR = Math.max(3.5, Math.min(12, scale * 0.035));
  const primaryDistance = scale * PRIMARY_DISTANCE_FACTOR;
  const childDistance = scale * CHILD_DISTANCE_FACTOR;
  const nucleusDistance = scale * NUCLEUS_DISTANCE_FACTOR;

  const cx = scale / 2;
  const cy = scale / 2;
  const nodes: SimNode[] = [{ id: 'core', kind: 'core', label: aiName || 'Core', radius: coreR, x: cx, y: cy }];
  const links: SimLink[] = [];

  const ungrouped = skills.filter((s) => !s.packageId);
  const primary: (
    | { type: 'package'; ref: SkillPackage }
    | { type: 'skill'; ref: Skill }
    | { type: 'kfolder'; ref: KnowledgeFolder }
    | { type: 'integration'; ref: Integration }
  )[] = [
    ...packages.map((p) => ({ type: 'package' as const, ref: p })),
    ...ungrouped.map((s) => ({ type: 'skill' as const, ref: s })),
    ...knowledgeFolders.map((f) => ({ type: 'kfolder' as const, ref: f })),
    ...integrations.map((it) => ({ type: 'integration' as const, ref: it })),
  ];

  const hubCount = Math.max(1, Math.ceil(primary.length / NUCLEUS_CAPACITY));
  const hubIds: string[] = ['core'];
  for (let h = 1; h < hubCount; h++) {
    const angle = ((h - 1) / (hubCount - 1)) * Math.PI * 2 - Math.PI / 2;
    const nx = cx + nucleusDistance * Math.cos(angle);
    const ny = cy + nucleusDistance * Math.sin(angle);
    const nid = `nucleus-${h}`;
    nodes.push({ id: nid, kind: 'nucleus', label: '', radius: nucleusR, x: nx, y: ny });
    links.push({ id: `core-${nid}`, source: 'core', target: nid, distance: nucleusDistance });
    hubIds.push(nid);
  }

  const adjacentNuclei = hubIds.slice(1);
  if (adjacentNuclei.length >= NUCLEUS_MESH_THRESHOLD) {
    adjacentNuclei.forEach((id, i) => {
      const nextId = adjacentNuclei[(i + 1) % adjacentNuclei.length];
      links.push({ id: `mesh-${id}-${nextId}`, source: id, target: nextId, distance: nucleusDistance * 0.8 });
    });
  }

  primary.forEach((item, i) => {
    const hubIndex = Math.floor(i / NUCLEUS_CAPACITY);
    const hubId = hubIds[hubIndex];
    const hub = nodes.find((n) => n.id === hubId)!;
    const indexInHub = i % NUCLEUS_CAPACITY;
    const countInHub = Math.min(NUCLEUS_CAPACITY, primary.length - hubIndex * NUCLEUS_CAPACITY);
    const angle = (indexInHub / Math.max(countInHub, 1)) * Math.PI * 2 - Math.PI / 2;
    const x = (hub.x ?? cx) + primaryDistance * Math.cos(angle);
    const y = (hub.y ?? cy) + primaryDistance * Math.sin(angle);
    const id =
      item.type === 'package' ? `pkg-${item.ref._id}`
      : item.type === 'skill' ? `skill-${item.ref._id}`
      : item.type === 'kfolder' ? `kfolder-${item.ref.name}`
      : `int-${item.ref.service}`;
    const ref = item.ref;
    nodes.push({
      id,
      kind: item.type === 'kfolder' ? 'kfolder' : item.type,
      label: item.type === 'integration' ? SERVICE_LABELS[(item.ref as Integration).service] : (ref as SkillPackage | Skill | KnowledgeFolder).name,
      radius: item.type === 'package' || item.type === 'kfolder' || item.type === 'integration' ? pkgR : skillR,
      enabled: item.type === 'skill' ? (ref as Skill).enabled : item.type === 'integration' ? (ref as Integration).connected : undefined,
      service: item.type === 'integration' ? (item.ref as Integration).service : undefined,
      onClick:
        item.type === 'package'
          ? () => cbRef.current.onOpenPackage(ref as SkillPackage)
          : item.type === 'skill'
            ? () => cbRef.current.onOpenSkill(ref as Skill)
            : item.type === 'kfolder'
              ? () => cbRef.current.onOpenKnowledgeFolder?.(ref as KnowledgeFolder)
              : () => cbRef.current.onOpenIntegration?.((ref as Integration).service),
      x,
      y,
    });
    links.push({ id: `${hubId}-${id}`, source: hubId, target: id, distance: primaryDistance });

    if (item.type === 'package') {
      const pkgSkills = skills.filter((s) => s.packageId === item.ref._id);
      pkgSkills.forEach((s, j) => {
        const subAngle = angle + (j - (pkgSkills.length - 1) / 2) * 0.5;
        const sx = x + childDistance * Math.cos(subAngle);
        const sy = y + childDistance * Math.sin(subAngle);
        const sid = `skill-${s._id}`;
        nodes.push({ id: sid, kind: 'skill', label: s.name, radius: skillR, enabled: s.enabled, onClick: () => cbRef.current.onOpenSkill(s), x: sx, y: sy });
        links.push({ id: `${id}-${sid}`, source: id, target: sid, distance: childDistance });
      });
    } else if (item.type === 'kfolder') {
      const folder = item.ref;
      folder.files.forEach((file, j) => {
        const subAngle = angle + (j - (folder.files.length - 1) / 2) * 0.5;
        const fx = x + childDistance * Math.cos(subAngle);
        const fy = y + childDistance * Math.sin(subAngle);
        const fid = `kfile-${folder.name}-${file}`;
        nodes.push({
          id: fid,
          kind: 'kfile',
          label: file,
          radius: skillR,
          onClick: () => cbRef.current.onOpenKnowledgeFile?.(folder, file),
          x: fx,
          y: fy,
        });
        links.push({ id: `${id}-${fid}`, source: id, target: fid, distance: childDistance });
      });
    } else if (item.type === 'integration') {
      const integ = item.ref;
      integ.tools.forEach((tool, j) => {
        const subAngle = angle + (j - (integ.tools.length - 1) / 2) * 0.5;
        const tx = x + childDistance * Math.cos(subAngle);
        const ty = y + childDistance * Math.sin(subAngle);
        const tid = `itool-${integ.service}-${tool.name}`;
        nodes.push({
          id: tid,
          kind: 'itool',
          label: tool.label,
          radius: skillR,
          enabled: integ.connected,
          service: integ.service,
          onClick: () => cbRef.current.onOpenIntegration?.(integ.service),
          x: tx,
          y: ty,
        });
        links.push({ id: `${id}-${tid}`, source: id, target: tid, distance: childDistance });
      });
    }
  });

  return { nodes, links };
}

export default function SkillNeuronGraph({
  packages,
  skills,
  knowledgeFolders = EMPTY_KNOWLEDGE_FOLDERS,
  integrations = EMPTY_INTEGRATIONS,
  aiName,
  onOpenPackage,
  onOpenSkill,
  onOpenKnowledgeFolder,
  onOpenKnowledgeFile,
  onOpenIntegration,
  showLabels = true,
  emptyMessage = 'No skills added yet',
  zoomPan = true,
}: {
  packages: SkillPackage[];
  skills: Skill[];
  knowledgeFolders?: KnowledgeFolder[];
  integrations?: Integration[];
  aiName: string;
  onOpenPackage: (pkg: SkillPackage) => void;
  onOpenSkill: (skill: Skill) => void;
  onOpenKnowledgeFolder?: (folder: KnowledgeFolder) => void;
  onOpenKnowledgeFile?: (folder: KnowledgeFolder, file: string) => void;
  onOpenIntegration?: (service: IntegrationService) => void;
  showLabels?: boolean;
  emptyMessage?: string;
  zoomPan?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const nodeElRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const lineElRefs = useRef<Map<string, SVGPathElement>>(new Map());
  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null);
  const dragRef = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; origin: { x: number; y: number; k: number } } | null>(null);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const [dims, setDims] = useState({ width: 0, height: 0 });
  const [graph, setGraph] = useState<{ nodes: SimNode[]; links: SimLink[] }>({ nodes: [], links: [] });
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });

  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);

  const applyWorldTransform = useCallback(() => {
    if (!worldRef.current) return;
    const t = transformRef.current;
    const { viewScale, offsetX, offsetY } = computeFit(dims);
    worldRef.current.style.transform = `translate(${t.x + offsetX}px, ${t.y + offsetY}px) scale(${t.k * viewScale})`;
  }, [dims]);

  useEffect(() => {
    applyWorldTransform();
  }, [transform, applyWorldTransform]);

  const cbRef = useRef({ onOpenPackage, onOpenSkill, onOpenKnowledgeFolder, onOpenKnowledgeFile, onOpenIntegration });
  cbRef.current = { onOpenPackage, onOpenSkill, onOpenKnowledgeFolder, onOpenKnowledgeFile, onOpenIntegration };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let last = { width: 0, height: 0 };
    const measure = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (Math.abs(width - last.width) < 1 && Math.abs(height - last.height) < 1) return;
      last = { width, height };
      setDims({ width, height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !zoomPan) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const t = transformRef.current;
      const { viewScale, offsetX, offsetY } = computeFit(dims);
      const factor = Math.exp(-e.deltaY * 0.0012);
      const k = Math.min(3, Math.max(0.25, t.k * factor));
      const ratio = k / t.k;
      const x = px - offsetX - (px - t.x - offsetX) * ratio;
      const y = py - offsetY - (py - t.y - offsetY) * ratio;
      const next = { x, y, k };
      transformRef.current = next;
      setTransform(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomPan, dims]);

  useEffect(() => {
    const scale = SIM_SIZE;
    const data = buildGraphData(packages, skills, knowledgeFolders, integrations, aiName, cbRef);
    setGraph(data);

    const sim = forceSimulation<SimNode>(data.nodes)
      .force('link', forceLink<SimNode, SimLink>(data.links).id((d) => d.id).distance((l) => l.distance).strength(0.85))
      .force('charge', forceManyBody<SimNode>().strength((d) => (d.kind === 'core' || d.kind === 'nucleus' ? -scale * 2 : d.kind === 'package' || d.kind === 'kfolder' || d.kind === 'integration' ? -scale * 1.1 : -scale * 0.35)))
      .force('collide', forceCollide<SimNode>().radius((d) => d.radius + scale * 0.065).strength(1))
      .force('center', forceCenter(scale / 2, scale / 2).strength(0.08))
      .alpha(1)
      .alphaDecay(0.02);

    const cx = scale / 2;
    const cy = scale / 2;
    const hasNuclei = data.nodes.some((n) => n.kind === 'nucleus');
    const maxR = hasNuclei
      ? scale * (NUCLEUS_DISTANCE_FACTOR + PRIMARY_DISTANCE_FACTOR + CHILD_DISTANCE_FACTOR)
      : scale * 0.85;

    sim.on('tick', () => {
      for (const n of data.nodes) {
        const dx = (n.x ?? cx) - cx;
        const dy = (n.y ?? cy) - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > maxR) {
          const k = maxR / dist;
          n.x = cx + dx * k;
          n.y = cy + dy * k;
        }
        const el = nodeElRefs.current.get(n.id);
        if (el) el.style.transform = `translate(${n.x}px, ${n.y}px) translate(-50%, -50%)`;
      }
      for (const l of data.links) {
        const path = lineElRefs.current.get(l.id);
        const s = l.source as SimNode;
        const t = l.target as SimNode;
        if (path && s && t) {
          const x1 = s.x ?? 0, y1 = s.y ?? 0, x2 = t.x ?? 0, y2 = t.y ?? 0;
          const mx = (x1 + x2) / 2;
          const my = (y1 + y2) / 2;
          const dx = x2 - x1;
          const dy = y2 - y1;
          const cx = mx + dy * LINK_CURVE_BEND;
          const cy = my - dx * LINK_CURVE_BEND;
          path.setAttribute('d', `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`);
        }
      }
    });

    simRef.current = sim;
    return () => {
      sim.stop();
      simRef.current = null;
    };
  }, [packages, skills, knowledgeFolders, integrations, aiName]);

  const toGraphPoint = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const t = transformRef.current;
    const { viewScale, offsetX, offsetY } = computeFit(dims);
    const totalK = t.k * viewScale;
    return { x: (clientX - rect.left - t.x - offsetX) / totalK, y: (clientY - rect.top - t.y - offsetY) / totalK };
  }, [dims]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>, node: SimNode) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id: node.id, startX: e.clientX, startY: e.clientY, moved: false };
    node.fx = node.x ?? 0;
    node.fy = node.y ?? 0;
    simRef.current?.alphaTarget(0.3).restart();
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>, node: SimNode) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== node.id) return;
    if (Math.abs(e.clientX - drag.startX) > 3 || Math.abs(e.clientY - drag.startY) > 3) drag.moved = true;
    const p = toGraphPoint(e.clientX, e.clientY);
    node.fx = p.x;
    node.fy = p.y;
  }, [toGraphPoint]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>, node: SimNode) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== node.id) return;
    dragRef.current = null;
    node.fx = null;
    node.fy = null;
    simRef.current?.alphaTarget(0);
    if (!drag.moved) node.onClick?.();
  }, []);

  const handleBgPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!zoomPan) return;
    if (e.target !== containerRef.current && e.target !== worldRef.current) return;
    panRef.current = { startX: e.clientX, startY: e.clientY, origin: { ...transformRef.current } };
    containerRef.current?.setPointerCapture(e.pointerId);
  }, [zoomPan]);

  const handleBgPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan) return;
    const next = { x: pan.origin.x + (e.clientX - pan.startX), y: pan.origin.y + (e.clientY - pan.startY), k: pan.origin.k };
    transformRef.current = next;
    setTransform(next);
  }, []);

  const handleBgPointerUp = useCallback(() => {
    panRef.current = null;
  }, []);

  const resetView = useCallback(() => {
    const next = { x: 0, y: 0, k: 1 };
    transformRef.current = next;
    setTransform(next);
  }, []);

  if (packages.length === 0 && skills.length === 0 && knowledgeFolders.length === 0 && integrations.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="text-gray-500 text-[13px]">{emptyMessage}</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onPointerDown={handleBgPointerDown}
      onPointerMove={handleBgPointerMove}
      onPointerUp={handleBgPointerUp}
      className={`relative w-full h-full select-none overflow-hidden${zoomPan ? ' cursor-grab active:cursor-grabbing' : ''}`}
      style={{ touchAction: 'none' }}
    >
      {zoomPan && (
        <motion.button
          onClick={resetView}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.92 }}
          title="Center graph"
          className="absolute bottom-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-lg bg-foreground border-none cursor-pointer text-gray-400 hover:text-white transition-colors"
        >
          <Maximize2 size={13} />
        </motion.button>
      )}

      <div ref={worldRef} className="absolute inset-0" style={{ transformOrigin: '0 0' }}>
        <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ overflow: 'visible' }}>
          {graph.links.map((l) => (
            <path
              key={l.id}
              ref={(el) => {
                if (el) lineElRefs.current.set(l.id, el);
                else lineElRefs.current.delete(l.id);
              }}
              fill="none"
              stroke="rgba(209,213,219,0.4)"
              strokeWidth={2.5}
            />
          ))}
        </svg>

        {graph.nodes.map((n) => {
          const isCore = n.kind === 'core';
          const isNucleus = n.kind === 'nucleus';
          const isPkg = n.kind === 'package';
          const isIntegration = n.kind === 'integration';
          const dimmed = (n.kind === 'skill' || n.kind === 'itool' || n.kind === 'integration') && n.enabled === false;
          const d = n.radius * 2;
          const ServiceIcon = n.service === 'gmail' ? GmailIcon : n.service === 'calendar' ? GoogleCalendarIcon : n.service === 'drive' ? GoogleDriveIcon : n.service === 'playconsole' ? GooglePlayIcon : null;
          return (
            <div
              key={n.id}
              ref={(el) => {
                if (el) nodeElRefs.current.set(n.id, el);
                else nodeElRefs.current.delete(n.id);
              }}
              className="absolute flex flex-col items-center gap-1 cursor-grab active:cursor-grabbing"
              style={{ left: 0, top: 0, transform: `translate(${n.x ?? 0}px, ${n.y ?? 0}px) translate(-50%, -50%)`, touchAction: 'none' }}
              onPointerDown={(e) => handlePointerDown(e, n)}
              onPointerMove={(e) => handlePointerMove(e, n)}
              onPointerUp={(e) => handlePointerUp(e, n)}
            >
              {isCore ? (
                <div
                  className="rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ width: d, height: d, background: '#3a3a44', border: '1.5px solid #fff' }}
                >
                  <Brain size={n.radius * 0.75} color="#fff" />
                </div>
              ) : isNucleus ? (
                <div
                  className="rounded-full flex-shrink-0"
                  style={{ width: d, height: d, background: '#3a3a44', border: '1.5px solid rgba(255,255,255,0.5)' }}
                />
              ) : isIntegration && ServiceIcon ? (
                <div
                  className="rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ width: d, height: d, background: '#fff', opacity: dimmed ? 0.4 : 1 }}
                >
                  <ServiceIcon size={n.radius * 1.3} />
                </div>
              ) : (
                <div
                  className="rounded-full flex-shrink-0"
                  style={{
                    width: d,
                    height: d,
                    background: dimmed
                      ? '#4b4b55'
                      : isPkg
                        ? '#e5e7eb'
                        : n.kind === 'kfolder'
                          ? '#f2b84b'
                          : n.kind === 'kfile'
                            ? '#c9954f'
                            : n.kind === 'itool'
                              ? '#7aa2f7'
                              : '#9ca3af',
                  }}
                />
              )}
              {showLabels && n.label && (
                <span
                  className="text-[10px] font-semibold whitespace-nowrap"
                  style={{
                    color: dimmed ? '#666' : isPkg || isCore || n.kind === 'kfolder' || isIntegration ? '#fff' : '#c9c9d4',
                    maxWidth: 80,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    pointerEvents: 'none',
                  }}
                >
                  {n.label}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

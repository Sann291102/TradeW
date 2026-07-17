'use client';
import { useMemo, useState } from 'react';
import type { TreeNode } from '@/lib/knowledge';

/** Recursive file explorer with expand/collapse and a live filter. */
export function FileTree({
  tree,
  activePath,
  filter,
  onOpen,
}: {
  tree: TreeNode | null;
  activePath: string | null;
  filter: string;
  onOpen: (path: string) => void;
}) {
  if (!tree) return <p className="px-3 py-2 text-[12px] text-[#64769c]">Loading vault…</p>;
  const q = filter.trim().toLowerCase();
  return (
    <ul className="py-1">
      {tree.children?.map((child) => (
        <TreeItem key={child.path || child.name} node={child} depth={0} activePath={activePath} filter={q} onOpen={onOpen} />
      ))}
    </ul>
  );
}

function matches(node: TreeNode, q: string): boolean {
  if (!q) return true;
  if (node.type === 'file') return node.path.toLowerCase().includes(q);
  return node.children?.some((c) => matches(c, q)) ?? false;
}

function TreeItem({
  node,
  depth,
  activePath,
  filter,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  filter: string;
  onOpen: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const visible = useMemo(() => matches(node, filter), [node, filter]);
  if (!visible) return null;
  const expanded = open || filter.length > 0; // auto-expand while filtering

  if (node.type === 'dir') {
    return (
      <li>
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12.5px] text-[#c6d0e2] hover:bg-[#182642]"
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          <span className="w-3 text-[10px] text-[#64769c]">{expanded ? '▾' : '▸'}</span>
          <span className="text-[#f0a53c]">📁</span>
          <span className="truncate">{node.name}</span>
        </button>
        {expanded && (
          <ul>
            {node.children?.map((c) => (
              <TreeItem key={c.path || c.name} node={c} depth={depth + 1} activePath={activePath} filter={filter} onOpen={onOpen} />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const isActive = node.path === activePath;
  return (
    <li>
      <button
        onClick={() => onOpen(node.path)}
        className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12.5px] hover:bg-[#182642] ${
          isActive ? 'bg-[#12312f] text-[#14b8a6]' : 'text-[#8ea0c4]'
        }`}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={node.path}
      >
        <span className="w-3" />
        <span>📄</span>
        <span className="truncate">{node.name.replace(/\.md$/i, '')}</span>
      </button>
    </li>
  );
}

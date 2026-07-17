import { ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Knowledge Workspace — a read-only window over the git-tracked Obsidian vault
 * at TradeW/knowledge/. Markdown files on disk are the single source of truth;
 * this service never writes to the vault and keeps no database. A derived
 * in-memory index (rebuilt by a 2s snapshot-diff poller) backs tree/search/
 * graph/recent so requests don't re-walk the filesystem, and the same poll
 * emits change events consumed by the SSE stream for live updates.
 *
 * The poll-diff approach (rather than fs.watch) is deliberate: it's fully
 * cross-platform, reliably catches deletes, and needs no dependency — a good
 * fit for a small vault where a 2s scan is negligible.
 */

export type NodeType = 'dir' | 'file';

export interface TreeNode {
  name: string;
  path: string; // vault-relative, POSIX separators
  type: NodeType;
  children?: TreeNode[];
  size?: number;
  modified?: number;
}

export interface FileMeta {
  path: string;
  title: string;
  tags: string[];
  noteType?: string;
  size: number;
  created: number;
  modified: number;
}

export interface FileContent extends FileMeta {
  content: string;
  links: string[]; // resolved outbound links (vault-relative paths)
  backlinks: string[]; // files that link to this one
}

export interface RecentItem extends FileMeta {
  status: 'created' | 'modified';
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  matches: number;
  fields: string[]; // which of: filename | title | tags | content matched
}

export interface GraphNode {
  id: string;
  label: string;
  group: string; // top-level folder, drives colour/cluster
  degree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type ActivityType = 'created' | 'modified' | 'deleted';

export interface ActivityEvent {
  id: string;
  type: ActivityType;
  path: string;
  category: string; // inferred agent/domain from the top-level folder
  title: string;
  at: number;
}

interface IndexEntry {
  meta: FileMeta;
  content: string;
  rawLinks: string[]; // unresolved link targets as written in the note
}

const MAX_FILE_BYTES = 1_000_000;
const POLL_INTERVAL_MS = 2000;
const ACTIVITY_LIMIT = 200;

/** Human-friendly label for the top-level folder — the "which agent/domain" hint. */
const CATEGORY_LABELS: Record<string, string> = {
  Decisions: 'Decisions',
  Patterns: 'Patterns',
  Gotchas: 'Gotchas',
  Research: 'Research',
  Agents: 'Agents',
  Plans: 'Plans',
  API: 'API',
};

@Injectable()
export class KnowledgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KnowledgeService.name);
  private readonly root = KnowledgeService.resolveRoot();
  private readonly emitter = new EventEmitter();

  /** path -> derived entry; the single in-memory projection of the vault. */
  private index = new Map<string, IndexEntry>();
  /** path -> mtimeMs, the snapshot the poller diffs against. */
  private snapshot = new Map<string, number>();
  private activityLog: ActivityEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;
  private started = false;

  static resolveRoot(): string {
    // KNOWLEDGE_ROOT wins; otherwise the vault sits two levels up from the
    // service's working dir (services/api -> repo root -> knowledge/).
    return process.env.KNOWLEDGE_ROOT
      ? path.resolve(process.env.KNOWLEDGE_ROOT)
      : path.resolve(process.cwd(), '..', '..', 'knowledge');
  }

  async onModuleInit(): Promise<void> {
    try {
      await fs.access(this.root);
      await this.rebuildIndex(true);
      this.timer = setInterval(() => void this.rebuildIndex(false), POLL_INTERVAL_MS);
      if (this.timer.unref) this.timer.unref();
      this.started = true;
      this.logger.log(`watching knowledge vault at ${this.root} (${this.index.size} notes)`);
    } catch (err) {
      // Absent vault must not crash the API — the workspace just serves empty.
      this.logger.warn(`knowledge vault not available at ${this.root}: ${err}`);
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get rootPath(): string {
    return this.root;
  }

  // ----------------------------------------------------------------- queries

  tree(): TreeNode {
    const rootNode: TreeNode = { name: 'knowledge', path: '', type: 'dir', children: [] };
    const dirs = new Map<string, TreeNode>([['', rootNode]]);

    const ensureDir = (relDir: string): TreeNode => {
      if (dirs.has(relDir)) return dirs.get(relDir)!;
      const parentRel = relDir.includes('/') ? relDir.slice(0, relDir.lastIndexOf('/')) : '';
      const parent = ensureDir(parentRel);
      const node: TreeNode = { name: relDir.split('/').pop()!, path: relDir, type: 'dir', children: [] };
      parent.children!.push(node);
      dirs.set(relDir, node);
      return node;
    };

    for (const [rel, entry] of [...this.index.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const parentRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      const parent = ensureDir(parentRel);
      parent.children!.push({
        name: rel.split('/').pop()!,
        path: rel,
        type: 'file',
        size: entry.meta.size,
        modified: entry.meta.modified,
      });
    }

    const sortNode = (n: TreeNode) => {
      n.children?.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      n.children?.forEach(sortNode);
    };
    sortNode(rootNode);
    return rootNode;
  }

  async file(relRaw: string): Promise<FileContent> {
    const rel = this.toVaultRel(relRaw);
    const abs = this.safeResolve(rel);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new NotFoundException(`Note not found: ${rel}`);
    }
    if (!stat.isFile()) throw new NotFoundException(`Not a file: ${rel}`);
    // Read fresh from disk so the viewer never shows a stale (up-to-2s) copy.
    const content = (await fs.readFile(abs, 'utf8')).slice(0, MAX_FILE_BYTES);
    const meta = this.buildMeta(rel, content, stat.size, stat.birthtimeMs, stat.mtimeMs);
    const links = this.resolveLinks(this.extractLinks(content), rel);
    const backlinks: string[] = [];
    for (const [otherRel, entry] of this.index) {
      if (otherRel === rel) continue;
      if (this.resolveLinks(entry.rawLinks, otherRel).includes(rel)) backlinks.push(otherRel);
    }
    return { ...meta, content, links, backlinks: backlinks.sort() };
  }

  recent(limit = 20): RecentItem[] {
    return [...this.index.values()]
      .map((e) => ({
        ...e.meta,
        // birthtime === mtime (within a small window) reads as freshly created.
        status: (Math.abs(e.meta.modified - e.meta.created) < 1500 ? 'created' : 'modified') as RecentItem['status'],
      }))
      .sort((a, b) => b.modified - a.modified)
      .slice(0, Math.min(limit, 200));
  }

  search(query: string, limit = 50): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: SearchHit[] = [];
    for (const [rel, entry] of this.index) {
      const fields: string[] = [];
      if (rel.toLowerCase().includes(q)) fields.push('filename');
      if (entry.meta.title.toLowerCase().includes(q)) fields.push('title');
      if (entry.meta.tags.some((t) => t.toLowerCase().includes(q))) fields.push('tags');

      const lc = entry.content.toLowerCase();
      let contentMatches = 0;
      let idx = lc.indexOf(q);
      const first = idx;
      while (idx !== -1) {
        contentMatches++;
        idx = lc.indexOf(q, idx + q.length);
      }
      if (contentMatches > 0) fields.push('content');
      if (fields.length === 0) continue;

      const snippet =
        first !== -1
          ? this.snippetAround(entry.content, first, q.length)
          : entry.meta.title;
      hits.push({ path: rel, title: entry.meta.title, snippet, matches: contentMatches, fields });
    }
    // filename/title/tag matches rank above pure content matches, then by count.
    const weight = (h: SearchHit) =>
      (h.fields.includes('title') ? 100 : 0) +
      (h.fields.includes('filename') ? 50 : 0) +
      (h.fields.includes('tags') ? 25 : 0) +
      h.matches;
    return hits.sort((a, b) => weight(b) - weight(a)).slice(0, Math.min(limit, 200));
  }

  graph(): GraphData {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const degree = new Map<string, number>();
    const bump = (p: string) => degree.set(p, (degree.get(p) ?? 0) + 1);

    for (const [rel, entry] of this.index) {
      for (const target of this.resolveLinks(entry.rawLinks, rel)) {
        edges.push({ source: rel, target });
        bump(rel);
        bump(target);
      }
    }
    for (const [rel, entry] of this.index) {
      nodes.push({
        id: rel,
        label: entry.meta.title,
        group: this.categoryOf(rel),
        degree: degree.get(rel) ?? 0,
      });
    }
    return { nodes, edges };
  }

  activity(since?: number): ActivityEvent[] {
    if (since === undefined) return [...this.activityLog];
    return this.activityLog.filter((e) => e.at > since);
  }

  /** Node EventEmitter that fires 'change' with an ActivityEvent per file op. */
  get changes(): EventEmitter {
    return this.emitter;
  }

  get isStarted(): boolean {
    return this.started;
  }

  // -------------------------------------------------------------- index build

  private async rebuildIndex(initial: boolean): Promise<void> {
    let files: { rel: string; abs: string; size: number; birthtimeMs: number; mtimeMs: number }[];
    try {
      files = await this.walk(this.root);
    } catch (err) {
      this.logger.warn(`vault scan failed: ${err}`);
      return;
    }

    const nextSnapshot = new Map<string, number>();
    const nextIndex = new Map<string, IndexEntry>();
    const events: ActivityEvent[] = [];

    for (const f of files) {
      nextSnapshot.set(f.rel, f.mtimeMs);
      const prevMtime = this.snapshot.get(f.rel);
      const cached = this.index.get(f.rel);
      let entry: IndexEntry;
      if (cached && prevMtime === f.mtimeMs) {
        entry = cached; // unchanged — reuse without re-reading disk
      } else {
        let content = '';
        try {
          content = (await fs.readFile(f.abs, 'utf8')).slice(0, MAX_FILE_BYTES);
        } catch {
          continue;
        }
        entry = {
          meta: this.buildMeta(f.rel, content, f.size, f.birthtimeMs, f.mtimeMs),
          content,
          rawLinks: this.extractLinks(content),
        };
        if (!initial) {
          const created = prevMtime === undefined;
          events.push(this.makeEvent(created ? 'created' : 'modified', f.rel, entry.meta.title));
        }
      }
      nextIndex.set(f.rel, entry);
    }

    if (!initial) {
      for (const [rel] of this.snapshot) {
        if (!nextSnapshot.has(rel)) {
          const title = this.index.get(rel)?.meta.title ?? rel.split('/').pop()!;
          events.push(this.makeEvent('deleted', rel, title));
        }
      }
    }

    this.index = nextIndex;
    this.snapshot = nextSnapshot;
    for (const ev of events) this.pushActivity(ev);
  }

  private pushActivity(ev: ActivityEvent): void {
    this.activityLog.unshift(ev);
    if (this.activityLog.length > ACTIVITY_LIMIT) this.activityLog.length = ACTIVITY_LIMIT;
    this.emitter.emit('change', ev);
  }

  private makeEvent(type: ActivityType, rel: string, title: string): ActivityEvent {
    return { id: `${Date.now()}-${this.seq++}`, type, path: rel, category: this.categoryOf(rel), title, at: Date.now() };
  }

  // -------------------------------------------------------------- fs helpers

  private async walk(dir: string): Promise<{ rel: string; abs: string; size: number; birthtimeMs: number; mtimeMs: number }[]> {
    const out: { rel: string; abs: string; size: number; birthtimeMs: number; mtimeMs: number }[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // skip .obsidian, .git, dotfiles
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.push(...(await this.walk(abs)));
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        const stat = await fs.stat(abs);
        out.push({
          rel: this.toVaultRel(path.relative(this.root, abs)),
          abs,
          size: stat.size,
          birthtimeMs: stat.birthtimeMs,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
    return out;
  }

  /** Resolve a vault-relative path to an absolute one, rejecting traversal. */
  private safeResolve(rel: string): string {
    const abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new ForbiddenException('Path escapes the knowledge vault');
    }
    return abs;
  }

  private toVaultRel(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\/+/, '');
  }

  private categoryOf(rel: string): string {
    const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : 'root';
    return CATEGORY_LABELS[top] ?? top;
  }

  // ---------------------------------------------------------- markdown parse

  private buildMeta(rel: string, content: string, size: number, created: number, modified: number): FileMeta {
    const fm = this.parseFrontmatter(content);
    const title = fm.title ?? this.firstHeading(content) ?? rel.split('/').pop()!.replace(/\.md$/i, '');
    return { path: rel, title, tags: fm.tags, noteType: fm.type, size, created, modified };
  }

  private parseFrontmatter(content: string): { title?: string; tags: string[]; type?: string } {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (!m) return { tags: [] };
    const block = m[1];
    const title = /(^|\n)\s*(?:title|name):\s*["']?(.+?)["']?\s*(?:\n|$)/i.exec(block)?.[2]?.trim();
    const type = /(^|\n)\s*type:\s*["']?(.+?)["']?\s*(?:\n|$)/i.exec(block)?.[2]?.trim();
    const tags = this.parseTags(block);
    return { title, tags, type };
  }

  private parseTags(block: string): string[] {
    // inline form: tags: [a, b, c]
    const inline = /(^|\n)\s*tags:\s*\[([^\]]*)\]/i.exec(block);
    if (inline) {
      return inline[2]
        .split(',')
        .map((t) => t.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    // block form: tags:\n  - a\n  - b
    const start = /(^|\n)\s*tags:\s*(?:\n|$)/i.exec(block);
    if (!start) return [];
    const rest = block.slice(start.index + start[0].length);
    const tags: string[] = [];
    for (const line of rest.split(/\r?\n/)) {
      const item = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (item) tags.push(item[1].replace(/^["']|["']$/g, ''));
      else if (line.trim() && !/^\s/.test(line)) break; // dedent = end of list
    }
    return tags;
  }

  private firstHeading(content: string): string | undefined {
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    return /(^|\n)#\s+(.+)/.exec(body)?.[2]?.trim();
  }

  private extractLinks(content: string): string[] {
    const out = new Set<string>();
    // [[wiki links]] and [[wiki|alias]]
    for (const m of content.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) out.add(m[1].trim());
    // markdown links to .md files: [text](path.md) — ignore http(s)
    for (const m of content.matchAll(/\]\(([^)]+?\.md)(?:#[^)]*)?\)/g)) {
      const t = m[1].trim();
      if (!/^https?:/i.test(t)) out.add(t);
    }
    return [...out];
  }

  /** Map raw link targets to existing vault-relative paths, from the note at `fromRel`. */
  private resolveLinks(rawTargets: string[], fromRel: string): string[] {
    const paths = [...this.index.keys()];
    const resolved = new Set<string>();
    const fromDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';

    for (const raw of rawTargets) {
      const target = this.normalizeLinkTarget(raw, fromDir, paths);
      if (target && target !== fromRel) resolved.add(target);
    }
    return [...resolved].sort();
  }

  private normalizeLinkTarget(raw: string, fromDir: string, paths: string[]): string | null {
    let t = raw.replace(/\\/g, '/').trim();
    if (!t) return null;

    // relative markdown link — resolve against the source note's folder
    if (t.startsWith('./') || t.startsWith('../')) {
      const joined = this.toVaultRel(path.posix.normalize(path.posix.join(fromDir, t)));
      const withExt = joined.toLowerCase().endsWith('.md') ? joined : `${joined}.md`;
      return paths.find((p) => p.toLowerCase() === withExt.toLowerCase()) ?? null;
    }

    const withExt = t.toLowerCase().endsWith('.md') ? t : `${t}.md`;
    // exact vault-relative path
    const exact = paths.find((p) => p.toLowerCase() === withExt.toLowerCase());
    if (exact) return exact;
    // basename match (Obsidian-style short links, e.g. [[Sentinel Brain audit]])
    const base = withExt.slice(withExt.lastIndexOf('/') + 1).toLowerCase();
    const byBase = paths.filter((p) => p.slice(p.lastIndexOf('/') + 1).toLowerCase() === base);
    if (byBase.length === 1) return byBase[0];
    // suffix match (e.g. [[Decisions/2026-... ]] with or without leading segments)
    const bySuffix = paths.filter((p) => p.toLowerCase().endsWith('/' + withExt.toLowerCase()));
    if (bySuffix.length === 1) return bySuffix[0];
    return null;
  }

  private snippetAround(content: string, at: number, len: number): string {
    const clean = content.replace(/\r?\n+/g, ' ');
    const start = Math.max(0, at - 60);
    const end = Math.min(clean.length, at + len + 60);
    return `${start > 0 ? '…' : ''}${clean.slice(start, end).trim()}${end < clean.length ? '…' : ''}`;
  }
}

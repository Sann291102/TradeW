import { PromptLibrary, PromptTemplate } from './interfaces';

/** In-process prompt library; templates are registered from version-controlled files at boot. */
export class InMemoryPromptLibrary implements PromptLibrary {
  /** id -> version -> template */
  private templates = new Map<string, Map<number, PromptTemplate>>();

  async register(template: PromptTemplate): Promise<void> {
    if (!this.templates.has(template.id)) this.templates.set(template.id, new Map());
    this.templates.get(template.id)!.set(template.version, template);
  }

  async get(id: string, version?: number): Promise<PromptTemplate | null> {
    const versions = this.templates.get(id);
    if (!versions || versions.size === 0) return null;
    if (version !== undefined) return versions.get(version) ?? null;
    const latest = Math.max(...versions.keys());
    return versions.get(latest) ?? null;
  }

  async render(id: string, vars: Record<string, string>, version?: number): Promise<string> {
    const template = await this.get(id, version);
    if (!template) throw new Error(`prompt template not found: ${id}${version !== undefined ? `@v${version}` : ''}`);
    const missing = template.variables.filter((v) => vars[v] === undefined);
    if (missing.length) throw new Error(`prompt ${id}: missing variables ${missing.join(', ')}`);
    return template.template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars[name] ?? '');
  }

  async list(namespace?: string): Promise<PromptTemplate[]> {
    const out: PromptTemplate[] = [];
    for (const versions of this.templates.values()) {
      const latest = versions.get(Math.max(...versions.keys()));
      if (latest && (!namespace || latest.namespace === namespace)) out.push(latest);
    }
    return out;
  }
}

/**
 * ------------------------------------------------------------------
 *  Title    |  Local models: one-click download
 *  Ref      |  docs/models.md (Download a local model) · ROADMAP track E
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  From Admin → Models: pick a recommended local model, be
 *           |  told plainly whether it fits this computer, download it
 *           |  with progress (cancel, resume), and find it in the model
 *           |  picker, ready, when it is done.
 *  How      |  The list is config/local-models.yaml. Fit is hardware.ts.
 *           |  Chat models come through Ollama's pull (ollama.ts); the
 *           |  search embedder through the Knowledge service, which asks
 *           |  fastembed to fetch it. A download is a job held here:
 *           |  starting one for a model that has a job running answers
 *           |  that job; a stopped one is simply started again, and
 *           |  Ollama carries on from the layers it already has. Done
 *           |  means verified: Ollama shows the model (or Knowledge
 *           |  loaded the embedder), then the model is switched on, or
 *           |  added as an Ollama model, so every picker has it.
 *  Note     |  Nothing is installed without a click, and Ollama itself
 *           |  never is: when it is missing the view gives its official
 *           |  download page (and, on Linux, the command to copy).
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  Capability,
  type LocalDownload,
  type LocalModelEntry,
  type LocalModelsView,
  ModelConfig,
  type OllamaState,
} from '@nvx/contracts';
import { ulid } from 'ulid';
import type { ModelRegistry } from '../gateway/registry';
import type { KnowledgeClient } from '../knowledge/client';
import { logFor } from '../obs/logger';
import { detectHardware, fitOf, type HardwareProbe, ollamaModelsDir, realProbe } from './hardware';
import { isLocalUrl, OllamaClient, OllamaError, ollamaDownload, ollamaInstalled } from './ollama';

const log = logFor('local-models');

export interface LocalModelsDeps {
  catalogue: LocalModelEntry[];
  ollamaUrl: string;
  registry: Pick<ModelRegistry, 'all' | 'custom' | 'saveCustom' | 'setEnabled'>;
  ollama?: OllamaClient;
  kn?: Pick<KnowledgeClient, 'get' | 'stream'>;
  probe?: HardwareProbe;
  modelsDir?: string;
  platform?: NodeJS.Platform;
  /** Ollama's program is on this computer (it may not be running). */
  installed?: () => Promise<boolean>;
  now?: () => Date;
}

interface Job {
  view: LocalDownload;
  entry: LocalModelEntry;
  ctrl: AbortController;
  done: Promise<void>;
  /** Bytes per layer, so overall progress adds up across layers. */
  layers: Map<string, { total: number; completed: number }>;
}

const err = (
  code: string,
  title: string,
  hint: string,
  status: number,
  extra: Partial<{ context: Record<string, unknown> }> = {},
) =>
  new AncileError({
    code,
    title,
    hint,
    status,
    errorClass: status >= 500 ? 'transient' : 'permanent',
    ...extra,
  });

export class LocalModels {
  private readonly ollama: OllamaClient;
  private readonly jobs = new Map<string, Job>();
  /** The latest job for each model in the list. */
  private readonly latest = new Map<string, Job>();

  constructor(private readonly deps: LocalModelsDeps) {
    this.ollama = deps.ollama ?? new OllamaClient({ baseUrl: deps.ollamaUrl });
  }

  private get platform() {
    return this.deps.platform ?? process.platform;
  }

  private now() {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private entry(id: string): LocalModelEntry {
    const e = this.deps.catalogue.find((m) => m.id === id);
    if (!e)
      throw err(
        'local_model.unknown',
        'That model is not in the list of local models',
        'Pick one from Admin → Models → Download a local model.',
        404,
      );
    return e;
  }

  async ollamaState(): Promise<OllamaState> {
    const local = isLocalUrl(this.ollama.base);
    const version = await this.ollama.version();
    const dl = ollamaDownload(this.platform);
    const status: OllamaState['status'] = version
      ? 'running'
      : !local
        ? 'remote_unreachable'
        : (await (this.deps.installed ?? (() => ollamaInstalled()))())
          ? 'installed'
          : 'missing';
    return {
      status,
      url: this.ollama.base,
      version,
      download_url: dl.url,
      install_command: dl.command,
      local,
    };
  }

  /** Model ids the picker knows each list entry by, when it is there. */
  private modelIdOf(e: LocalModelEntry): string | null {
    const m = this.deps.registry
      .all()
      .find((x) =>
        e.via === 'fastembed'
          ? x.provider === 'local' && x.provider_model === e.source
          : (x.provider === 'ollama' || x.id.startsWith('ollama/')) && x.provider_model === e.source,
      );
    return m?.enabled ? m.id : null;
  }

  private async embedderInstalled(e: LocalModelEntry): Promise<boolean> {
    if (!this.deps.kn) return false;
    try {
      const r = await this.deps.kn.get<{ installed: boolean }>(
        `/embeddings/local?model=${encodeURIComponent(e.source)}`,
      );
      return r.installed;
    } catch {
      return false;
    }
  }

  async view(): Promise<LocalModelsView> {
    const ollama = await this.ollamaState();
    const hardware = await detectHardware({
      ollamaLocal: ollama.local,
      modelsDir: this.deps.modelsDir ?? ollamaModelsDir(),
      probe: this.deps.probe ?? realProbe,
    });
    const tags = ollama.status === 'running' ? await this.ollama.tags().catch(() => []) : [];
    const have = new Set(tags.flatMap((t) => [t.name, t.name.replace(/:latest$/, '')]));
    const items = [];
    for (const e of this.deps.catalogue) {
      const installed = e.via === 'ollama' ? have.has(e.source) : await this.embedderInstalled(e);
      items.push({
        ...e,
        installed,
        fit: fitOf(e, hardware, { installed, remote: !ollama.local, platform: this.platform }),
        model_id: installed ? this.modelIdOf(e) : null,
        download: this.latest.get(e.id)?.view ?? null,
      });
    }
    items.sort((a, b) => Number(b.recommended) - Number(a.recommended));
    return { hardware, ollama, items };
  }

  job(id: string): LocalDownload {
    const j = this.jobs.get(id);
    if (!j)
      throw err(
        'local_model.download_not_found',
        'That download is not running',
        'It may have finished before NVX Ancile last restarted. Start it again to carry on.',
        404,
      );
    return structuredClone(j.view);
  }

  cancel(id: string): LocalDownload {
    const j = this.jobs.get(id);
    if (!j) return this.job(id);
    if (!['done', 'failed', 'cancelled'].includes(j.view.status)) j.ctrl.abort(new Error('cancelled'));
    return structuredClone(j.view);
  }

  /** Resolves when every download started so far has ended (tests, shutdown). */
  async settled(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((j) => j.done));
  }

  stop(): void {
    for (const j of this.jobs.values()) j.ctrl.abort(new Error('stopping'));
  }

  async start(id: string, opts: { anyway?: boolean } = {}): Promise<LocalDownload> {
    const entry = this.entry(id);
    const running = this.latest.get(id);
    if (running && ['starting', 'downloading', 'verifying'].includes(running.view.status))
      return structuredClone(running.view);

    let fitBlock: { blocker: 'disk' | 'memory' | null; reasons: string[] } | null = null;
    if (entry.via === 'ollama') {
      const state = await this.ollamaState();
      if (state.status !== 'running')
        throw err(
          'local_model.ollama_missing',
          state.status === 'installed'
            ? 'Ollama is installed but not running'
            : state.status === 'remote_unreachable'
              ? `Ollama at ${state.url} is not answering`
              : 'Ollama is not installed',
          state.status === 'installed'
            ? 'Open Ollama (or run "ollama serve"), then try again.'
            : state.status === 'remote_unreachable'
              ? 'Check that computer is on and Ollama is running there, then try again.'
              : `Install it from ${state.download_url}, open it, then try again. NVX Ancile never installs it for you.`,
          409,
          { context: { ollama: state.status, download_url: state.download_url } },
        );
      const view = await this.view();
      const item = view.items.find((i) => i.id === id);
      if (item?.fit) fitBlock = { blocker: item.fit.blocker, reasons: item.fit.reasons };
      if (item?.fit.verdict === 'no' && (item.fit.blocker === 'disk' || !opts.anyway))
        throw err(
          item.fit.blocker === 'disk' ? 'local_model.no_disk' : 'local_model.too_big',
          item.fit.blocker === 'disk'
            ? `Not enough disk for ${entry.name}`
            : `${entry.name} needs more memory than this computer has`,
          item.fit.reasons.join(' '),
          item.fit.blocker === 'disk' ? 507 : 422,
          { context: { blocker: item.fit.blocker } },
        );
    } else if (!this.deps.kn)
      throw err(
        'local_model.embedder_unavailable',
        'The knowledge service is not connected',
        'Start NVX Ancile with its knowledge service, then try again.',
        503,
      );

    const previous = this.latest.get(id);
    const ctrl = new AbortController();
    const view: LocalDownload = {
      id: `lmd_${ulid()}`,
      model: id,
      status: 'starting',
      completed: null,
      total: null,
      step: null,
      resumed: previous?.view.status === 'failed' || previous?.view.status === 'cancelled',
      started_at: this.now(),
      finished_at: null,
      model_id: null,
      error: null,
    };
    const job: Job = { view, entry, ctrl, done: Promise.resolve(), layers: new Map() };
    job.done = this.run(job).catch((e) =>
      log.warn({ err: e, model: id }, 'local model download ended badly'),
    );
    this.jobs.set(view.id, job);
    this.latest.set(id, job);
    log.info({ model: id, via: entry.via, fit: fitBlock?.blocker ?? null }, 'local model download started');
    return structuredClone(view);
  }

  private finish(job: Job, status: LocalDownload['status'], error: LocalDownload['error'] = null) {
    job.view.status = status;
    job.view.error = error;
    job.view.finished_at = this.now();
  }

  private async run(job: Job): Promise<void> {
    const { entry, ctrl } = job;
    try {
      if (entry.via === 'fastembed') await this.runEmbedder(job);
      else await this.runOllama(job);
      job.view.status = 'verifying';
      job.view.step = 'checking it is complete';
      if (entry.via === 'ollama' && !(await this.ollama.has(entry.source)))
        throw err(
          'local_model.not_verified',
          `${entry.name} downloaded but Ollama does not list it`,
          'Start the download again; Ollama keeps what it already has.',
          502,
        );
      job.view.model_id = await this.register(entry);
      this.finish(job, 'done');
      log.info({ model: entry.id, model_id: job.view.model_id }, 'local model ready');
    } catch (e) {
      if (ctrl.signal.aborted && !(ctrl.signal.reason instanceof OllamaError)) {
        this.finish(job, 'cancelled');
        return;
      }
      const a =
        e instanceof AncileError
          ? e
          : e instanceof OllamaError
            ? err(
                e.kind === 'refused' ? 'local_model.pull_refused' : 'local_model.pull_failed',
                e.kind === 'refused'
                  ? `Ollama would not download ${entry.name}`
                  : e.kind === 'stalled'
                    ? `The download of ${entry.name} stalled`
                    : `The download of ${entry.name} stopped`,
                e.kind === 'refused'
                  ? `Ollama said: ${e.message.slice(0, 200)}. Check the name, or update Ollama, then try again.`
                  : 'Check your connection, then press Resume: Ollama carries on from what it already has.',
                502,
              )
            : err(
                'local_model.pull_failed',
                `The download of ${entry.name} stopped`,
                'Press Resume to try again.',
                502,
              );
      this.finish(job, 'failed', { code: a.code, title: a.title, hint: a.hint ?? '' });
    }
  }

  private async runOllama(job: Job): Promise<void> {
    job.view.status = 'downloading';
    for await (const ev of this.ollama.pull(job.entry.source, job.ctrl.signal)) {
      job.view.step = ev.status;
      if (ev.digest && typeof ev.total === 'number') {
        job.layers.set(ev.digest, { total: ev.total, completed: ev.completed ?? 0 });
        let total = 0;
        let completed = 0;
        for (const l of job.layers.values()) {
          total += l.total;
          completed += Math.min(l.completed, l.total);
        }
        job.view.total = total;
        job.view.completed = completed;
      }
    }
  }

  private async runEmbedder(job: Job): Promise<void> {
    const kn = this.deps.kn as NonNullable<LocalModelsDeps['kn']>;
    job.view.status = 'downloading';
    job.view.step = 'fastembed is fetching the model';
    const res = await kn.stream('POST', '/embeddings/prepare', {
      body: JSON.stringify({ model: job.entry.source }),
      headers: new Headers({ 'content-type': 'application/json' }),
      signal: job.ctrl.signal,
    });
    const r = (await res.json()) as { model_key?: string };
    if (!r.model_key)
      throw err(
        'local_model.not_verified',
        `${job.entry.name} did not load`,
        'Try again; if it keeps failing, open Admin → Health and check "Knowledge".',
        502,
      );
  }

  /** Switch the model on in every picker, adding it as an Ollama model if it is new here. */
  private async register(e: LocalModelEntry): Promise<string | null> {
    const reg = this.deps.registry;
    const known = reg
      .all()
      .find((x) =>
        e.via === 'fastembed'
          ? x.provider === 'local' && x.provider_model === e.source
          : (x.provider === 'ollama' || x.id.startsWith('ollama/')) && x.provider_model === e.source,
      );
    if (known) {
      if (!known.enabled) await reg.setEnabled({ [known.id]: true });
      return known.id;
    }
    if (e.via === 'fastembed') return null;
    const id = `ollama/${e.source.replace(/[^A-Za-z0-9._:-]/g, '-')}`;
    const caps = e.capabilities.filter((c) => Capability.safeParse(c).success);
    const config = ModelConfig.parse({
      id,
      provider: 'ollama',
      provider_model: e.source,
      display_name: `${e.name} (Ollama)`,
      via: 'direct',
      family: e.family,
      context_window: e.context_window,
      max_output: Math.min(8_192, e.context_window),
      capabilities: caps,
      price: { input_per_mtok: 0, output_per_mtok: 0 },
      enabled: true,
    });
    await reg.saveCustom([...reg.custom().filter((m) => m.id !== id), config]);
    return id;
  }
}

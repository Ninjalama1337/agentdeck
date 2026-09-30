/**
 * Team orchestration: each step becomes a real Session (browsable history),
 * executed sequentially (with optional context passing) or in parallel.
 */
import type { TeamRun, TeamRunRequest, TeamStep } from '@agentdeck/shared';
import type { Logger } from '../logging.js';
import type { Store } from '../state/store.js';
import type { AgentManager } from '../agents/manager.js';
import { newStepId, newTeamRunId } from '../util/ids.js';
import type { RunAttachment } from '../agents/types.js';

const MAX_CONTEXT_CHARS = 4000;
const SUMMARY_CHARS = 500;

export class TeamOrchestrator {
  constructor(
    private readonly store: Store,
    private readonly manager: AgentManager,
    private readonly logger: Logger,
  ) {}

  /** Persists the run and starts execution in the background. */
  async create(request: TeamRunRequest): Promise<TeamRun> {
    const now = Date.now();
    const run: TeamRun = {
      id: newTeamRunId(),
      projectId: request.projectId,
      title: request.title?.trim() || `Team run (${request.steps.length} steps)`,
      mode: request.mode,
      status: 'pending',
      steps: request.steps.map((step) => ({
        id: newStepId(),
        agentId: step.agentId,
        prompt: step.prompt,
        status: 'pending' as const,
      })),
      createdAt: now,
      updatedAt: now,
    };
    if (request.passContext !== undefined && request.mode === 'sequence') {
      (run as TeamRun & { passContext?: boolean }).passContext = request.passContext;
    }
    await this.store.saveTeam(run);
    void this.execute(run.id).catch((err) => {
      this.logger.error({ err, run: run.id }, 'team run crashed');
    });
    return run;
  }

  private async execute(runId: string): Promise<void> {
    const run = this.store.getTeam(runId);
    if (!run) return;
    run.status = 'running';
    await this.store.saveTeam(run);

    const project = this.store.getProject(run.projectId);
    if (!project) {
      run.status = 'error';
      for (const step of run.steps) {
        step.status = 'error';
        step.error = 'Project not found';
      }
      await this.store.saveTeam(run);
      return;
    }

    try {
      if (run.mode === 'parallel') {
        await Promise.allSettled(run.steps.map((step) => this.runStep(run, project.id, step, '')));
      } else {
        const passContext = (run as TeamRun & { passContext?: boolean }).passContext !== false;
        const contextParts: string[] = [];
        for (const step of run.steps) {
          const context = passContext ? contextParts.join('\n\n') : '';
          await this.runStep(run, project.id, step, context);
          if (step.resultSummary) {
            contextParts.push(`## ${step.agentId}: ${step.resultSummary}`);
          }
        }
      }
    } finally {
      const failed = run.steps.some((s) => s.status === 'error');
      const stopped = this.store.getTeam(runId)?.status === 'stopped';
      if (!stopped) {
        run.status = failed ? 'error' : 'done';
      }
      await this.store.saveTeam(run);
      this.logger.info({ run: run.id, status: run.status }, 'team run finished');
    }
  }

  private async runStep(
    run: TeamRun,
    projectId: string,
    step: TeamStep,
    context: string,
  ): Promise<void> {
    const project = this.store.getProject(projectId);
    if (!project) return;
    const source = 'team' as const;
    const session = await this.store.newSession(
      {
        projectId,
        agentId: step.agentId,
        title: step.prompt.slice(0, 60),
      },
      source,
    );
    step.sessionId = session.id;
    step.status = 'running';
    await this.store.saveTeam(run);

    const prompt = context
      ? `Context from previous steps:\n${truncateForContext(context)}\n\nTask:\n${step.prompt}`
      : step.prompt;

    const userMessage = {
      id: `m_${step.id}`,
      sessionId: session.id,
      role: 'user' as const,
      agentId: step.agentId,
      text: prompt,
      attachments: [],
      ts: Date.now(),
      source,
    };
    await this.store.appendMessage(userMessage);

    const attachments: RunAttachment[] = [];
    const outcome = await this.manager.startTurn({
      session,
      project,
      text: prompt,
      attachments,
      source,
    });

    if (outcome.ok) {
      step.status = 'done';
      step.resultSummary = outcome.text.trim().slice(0, SUMMARY_CHARS);
    } else {
      step.status = 'error';
      step.error = outcome.error ?? 'Step failed';
    }
    await this.store.saveTeam(run);
  }

  /** Interrupts all active step sessions and marks the run stopped. */
  async stop(runId: string): Promise<boolean> {
    const run = this.store.getTeam(runId);
    if (!run) return false;
    for (const step of run.steps) {
      if (step.sessionId && this.manager.isActive(step.sessionId)) {
        this.manager.interrupt(step.sessionId, 'Team run stopped');
      }
      if (step.status === 'running' || step.status === 'pending') {
        step.status = 'skipped';
      }
    }
    run.status = 'stopped';
    await this.store.saveTeam(run);
    return true;
  }
}

function truncateForContext(context: string): string {
  return context.length > MAX_CONTEXT_CHARS ? context.slice(0, MAX_CONTEXT_CHARS) + '…' : context;
}

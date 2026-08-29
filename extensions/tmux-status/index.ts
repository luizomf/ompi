import { basename } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  ASYNC_ACTIVITY_EVENT,
  parseAsyncActivity,
} from './async-activity.ts';

const TMUX_STATUS_OPTION = '@pi_status';

export default function tmuxStatusExtension(pi: ExtensionAPI): void {
  pi.registerFlag('tmux-alert', {
    description: 'Enable the sound when Pi becomes idle in tmux',
    type: 'boolean',
    default: false,
  });

  const tmuxPaneFromEnv = process.env.TMUX_PANE;
  if (!process.env.TMUX || !tmuxPaneFromEnv) return;
  const tmuxPane: string = tmuxPaneFromEnv;

  let alertEnabled = pi.getFlag('tmux-alert') === true;
  let agentRunning = false;
  let currentContext: ExtensionContext | undefined;
  let lastPublishedActive: boolean | undefined;
  let publication = Promise.resolve();
  const asyncActivity = new Map<string, number>();

  pi.registerCommand('tmux-alert', {
    description: 'Toggle the sound when Pi becomes idle in tmux',
    handler: async (_args, ctx) => {
      alertEnabled = !alertEnabled;
      ctx.ui.notify(
        `Tmux idle sound ${alertEnabled ? 'enabled' : 'disabled'}`,
        'info',
      );
    },
  });

  async function runTmux(args: string[]): Promise<void> {
    try {
      await pi.exec('tmux', args);
    } catch {
      // Status publication is best-effort and must not affect the Pi lifecycle.
    }
  }

  async function runAlert(): Promise<void> {
    try {
      await pi.exec('osalert', []);
    } catch {
      // Audio notification is best-effort and must not affect Pi.
    }
  }

  async function publish(ctx: ExtensionContext): Promise<void> {
    const active = agentRunning || [...asyncActivity.values()].some((count) => count > 0);
    const icon = active ? '󰓅' : '';
    const sessionName = pi.getSessionName()?.replace(/\s+/gu, ' ').trim();
    const name = sessionName || basename(ctx.cwd);
    await runTmux([
      'set-option',
      '-w',
      '-t',
      tmuxPane,
      TMUX_STATUS_OPTION,
      `${icon} ${name}`,
    ]);

    const becameIdle = lastPublishedActive === true && !active;
    lastPublishedActive = active;
    if (becameIdle && alertEnabled) void runAlert();
  }

  function queuePublish(ctx: ExtensionContext): Promise<void> {
    publication = publication.then(() => publish(ctx));
    return publication;
  }

  const unsubscribeActivity = pi.events?.on(ASYNC_ACTIVITY_EVENT, (value) => {
    const activity = parseAsyncActivity(value);
    if (!activity || (asyncActivity.get(activity.source) ?? 0) === activity.active) return;
    if (activity.active === 0) asyncActivity.delete(activity.source);
    else asyncActivity.set(activity.source, activity.active);
    if (currentContext) void queuePublish(currentContext);
  });

  pi.on('session_start', async (_event, ctx) => {
    agentRunning = false;
    currentContext = ctx;
    lastPublishedActive = undefined;
    asyncActivity.clear();
    await queuePublish(ctx);
  });

  pi.on('session_info_changed', async (_event, ctx) => {
    await queuePublish(ctx);
  });

  pi.on('agent_start', async (_event, ctx) => {
    agentRunning = true;
    await queuePublish(ctx);
  });

  pi.on('agent_settled', async (_event, ctx) => {
    agentRunning = false;
    await queuePublish(ctx);
  });

  pi.on('session_shutdown', async () => {
    currentContext = undefined;
    asyncActivity.clear();
    unsubscribeActivity?.();
    await publication;
    await runTmux([
      'set-option',
      '-w',
      '-u',
      '-t',
      tmuxPane,
      TMUX_STATUS_OPTION,
    ]);
  });
}

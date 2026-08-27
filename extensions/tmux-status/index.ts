import { basename } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

const TMUX_STATUS_OPTION = '@pi_status';

export default function tmuxStatusExtension(pi: ExtensionAPI): void {
  const tmuxPaneFromEnv = process.env.TMUX_PANE;
  if (!process.env.TMUX || !tmuxPaneFromEnv) return;
  const tmuxPane: string = tmuxPaneFromEnv;

  let running = false;

  async function runTmux(args: string[]): Promise<void> {
    try {
      await pi.exec('tmux', args);
    } catch {
      // Status publication is best-effort and must not affect the Pi lifecycle.
    }
  }

  async function publish(ctx: ExtensionContext): Promise<void> {
    const icon = running ? '󰓅' : '';
    const color = running ? 'green' : 'red';
    const sessionName = pi.getSessionName()?.replace(/\s+/gu, ' ').trim();
    const name = sessionName || basename(ctx.cwd);
    await runTmux([
      'set-option',
      '-w',
      '-t',
      tmuxPane,
      TMUX_STATUS_OPTION,
      `#[fg=${color}]${icon}#[fg=default] ${name}`,
    ]);
  }

  pi.on('session_start', async (_event, ctx) => {
    running = false;
    await publish(ctx);
  });

  pi.on('session_info_changed', async (_event, ctx) => {
    await publish(ctx);
  });

  pi.on('agent_start', async (_event, ctx) => {
    running = true;
    await publish(ctx);
  });

  pi.on('agent_settled', async (_event, ctx) => {
    running = false;
    await publish(ctx);
  });

  pi.on('session_shutdown', async () => {
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

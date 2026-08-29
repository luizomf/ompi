import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import tmuxStatusExtension from './index.ts';

type Handler = (
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => unknown;

type CommandHandler = (
  args: string,
  ctx: ExtensionContext,
) => Promise<void>;

describe('tmux status extension', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('publishes the Pi session name and running lifecycle to its tmux window', async () => {
    vi.stubEnv('TMUX', '/tmp/tmux-501/default,1,0');
    vi.stubEnv('TMUX_PANE', '%7');

    const handlers = new Map<string, Handler>();
    const invocations: Array<{ command: string; args: string[] }> = [];
    const pi = {
      getSessionName: () => 'leak scan',
      registerFlag: () => {},
      getFlag: () => false,
      registerCommand: () => {},
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      exec: async (command: string, args: string[]) => {
        invocations.push({ command, args });
        return { stdout: '', stderr: '', code: 0, killed: false };
      },
    } as unknown as ExtensionAPI;
    const ctx = { cwd: '/work/dotfiles' } as ExtensionContext;

    tmuxStatusExtension(pi);
    await handlers.get('session_start')?.({}, ctx);
    await handlers.get('agent_start')?.({}, ctx);
    await handlers.get('agent_settled')?.({}, ctx);
    await handlers.get('session_shutdown')?.({}, ctx);

    expect(invocations).toEqual([
      {
        command: 'tmux',
        args: ['set-option', '-w', '-t', '%7', '@pi_status', ' leak scan'],
      },
      {
        command: 'tmux',
        args: ['set-option', '-w', '-t', '%7', '@pi_status', '󰓅 leak scan'],
      },
      {
        command: 'tmux',
        args: ['set-option', '-w', '-t', '%7', '@pi_status', ' leak scan'],
      },
      {
        command: 'tmux',
        args: ['set-option', '-w', '-u', '-t', '%7', '@pi_status'],
      },
    ]);
  });

  it('can enable idle audio with the tmux-alert flag', async () => {
    vi.stubEnv('TMUX', '/tmp/tmux-501/default,1,0');
    vi.stubEnv('TMUX_PANE', '%12');

    const handlers = new Map<string, Handler>();
    const commands: string[] = [];
    const pi = {
      getSessionName: () => 'alert session',
      registerFlag: () => {},
      getFlag: (name: string) => name === 'tmux-alert',
      registerCommand: () => {},
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      exec: async (command: string) => {
        commands.push(command);
        return { stdout: '', stderr: '', code: 0, killed: false };
      },
    } as unknown as ExtensionAPI;
    const ctx = { cwd: '/work/dotfiles' } as ExtensionContext;

    tmuxStatusExtension(pi);
    await handlers.get('session_start')?.({}, ctx);
    await handlers.get('agent_start')?.({}, ctx);
    await handlers.get('agent_settled')?.({}, ctx);

    expect(commands).toContain('osalert');
  });

  it('toggles idle audio with the tmux-alert command', async () => {
    vi.stubEnv('TMUX', '/tmp/tmux-501/default,1,0');
    vi.stubEnv('TMUX_PANE', '%13');

    const handlers = new Map<string, Handler>();
    const commandHandlers = new Map<string, CommandHandler>();
    const notifications: string[] = [];
    let alerts = 0;
    const pi = {
      getSessionName: () => 'toggle alert',
      registerFlag: () => {},
      getFlag: () => false,
      registerCommand: (
        name: string,
        command: { handler: CommandHandler },
      ) => commandHandlers.set(name, command.handler),
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      exec: async (command: string) => {
        if (command === 'osalert') alerts += 1;
        return { stdout: '', stderr: '', code: 0, killed: false };
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: '/work/dotfiles',
      ui: {
        notify: (message: string) => notifications.push(message),
      },
    } as unknown as ExtensionContext;

    tmuxStatusExtension(pi);
    await handlers.get('session_start')?.({}, ctx);

    const toggleAlert = commandHandlers.get('tmux-alert');
    expect(toggleAlert).toBeDefined();

    await toggleAlert?.('', ctx);
    await handlers.get('agent_start')?.({}, ctx);
    await handlers.get('agent_settled')?.({}, ctx);
    expect(alerts).toBe(1);

    await toggleAlert?.('', ctx);
    await handlers.get('agent_start')?.({}, ctx);
    await handlers.get('agent_settled')?.({}, ctx);
    expect(alerts).toBe(1);
    expect(notifications).toEqual([
      'Tmux idle sound enabled',
      'Tmux idle sound disabled',
    ]);
  });

  it('stays active while settled agent work can still return to the session', async () => {
    vi.stubEnv('TMUX', '/tmp/tmux-501/default,1,0');
    vi.stubEnv('TMUX_PANE', '%11');

    const handlers = new Map<string, Handler>();
    const activityHandlers = new Map<string, (data: unknown) => void>();
    const statuses: string[] = [];
    let alerts = 0;
    const pi = {
      getSessionName: () => 'delegated research',
      registerFlag: () => {},
      getFlag: () => true,
      registerCommand: () => {},
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      events: {
        on: (event: string, handler: (data: unknown) => void) => {
          activityHandlers.set(event, handler);
          return () => activityHandlers.delete(event);
        },
      },
      exec: async (command: string, args: string[]) => {
        if (command === 'tmux') statuses.push(args.at(-1) ?? '');
        if (command === 'osalert') alerts += 1;
        return { stdout: '', stderr: '', code: 0, killed: false };
      },
    } as unknown as ExtensionAPI;
    const ctx = { cwd: '/work/dotfiles' } as ExtensionContext;

    tmuxStatusExtension(pi);
    await handlers.get('session_start')?.({}, ctx);
    await handlers.get('agent_start')?.({}, ctx);
    activityHandlers.get('ompi:async-activity')?.({ source: 'subagents', active: 4 });
    await handlers.get('agent_settled')?.({}, ctx);

    expect(statuses.at(-1)).toBe('󰓅 delegated research');
    expect(alerts).toBe(0);

    activityHandlers.get('ompi:async-activity')?.({ source: 'subagents', active: 0 });
    await vi.waitFor(() => expect(statuses.at(-1)).toBe(' delegated research'));
    expect(alerts).toBe(1);
  });

  it('uses the project directory until the Pi session receives a name', async () => {
    vi.stubEnv('TMUX', '/tmp/tmux-501/default,1,0');
    vi.stubEnv('TMUX_PANE', '%8');

    let sessionName: string | undefined;
    const handlers = new Map<string, Handler>();
    const statuses: string[] = [];
    const pi = {
      getSessionName: () => sessionName,
      registerFlag: () => {},
      getFlag: () => false,
      registerCommand: () => {},
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      exec: async (_command: string, args: string[]) => {
        statuses.push(args.at(-1) ?? '');
        return { stdout: '', stderr: '', code: 0, killed: false };
      },
    } as unknown as ExtensionAPI;
    const ctx = { cwd: '/work/dotfiles' } as ExtensionContext;

    tmuxStatusExtension(pi);
    await handlers.get('session_start')?.({}, ctx);
    sessionName = 'architecture';
    await handlers.get('session_info_changed')?.({ name: sessionName }, ctx);

    expect(statuses).toEqual([' dotfiles', ' architecture']);
  });

  it('keeps tmux integration failures out of the Pi lifecycle', async () => {
    vi.stubEnv('TMUX', '/tmp/tmux-501/default,1,0');
    vi.stubEnv('TMUX_PANE', '%9');

    const handlers = new Map<string, Handler>();
    const pi = {
      getSessionName: () => 'status',
      registerFlag: () => {},
      getFlag: () => false,
      registerCommand: () => {},
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      exec: async () => {
        throw new Error('tmux unavailable');
      },
    } as unknown as ExtensionAPI;
    const ctx = { cwd: '/work/dotfiles' } as ExtensionContext;

    tmuxStatusExtension(pi);

    await expect(
      handlers.get('session_start')?.({}, ctx),
    ).resolves.toBeUndefined();
    await expect(
      handlers.get('session_shutdown')?.({}, ctx),
    ).resolves.toBeUndefined();
  });

  it('keeps the published status on one compact line', async () => {
    vi.stubEnv('TMUX', '/tmp/tmux-501/default,1,0');
    vi.stubEnv('TMUX_PANE', '%10');

    const handlers = new Map<string, Handler>();
    let status = '';
    const pi = {
      getSessionName: () => '  review\t leaked\n credentials  ',
      registerFlag: () => {},
      getFlag: () => false,
      registerCommand: () => {},
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      exec: async (_command: string, args: string[]) => {
        status = args.at(-1) ?? '';
        return { stdout: '', stderr: '', code: 0, killed: false };
      },
    } as unknown as ExtensionAPI;

    tmuxStatusExtension(pi);
    await handlers.get('session_start')?.({}, {
      cwd: '/work/dotfiles',
    } as ExtensionContext);

    expect(status).toBe(' review leaked credentials');
  });

  it('does nothing when Pi is not running inside tmux', () => {
    vi.stubEnv('TMUX', '');
    vi.stubEnv('TMUX_PANE', '');

    const events: string[] = [];
    const pi = {
      registerFlag: () => {},
      on: (event: string) => events.push(event),
      exec: async () => {
        throw new Error('must not execute');
      },
    } as unknown as ExtensionAPI;

    tmuxStatusExtension(pi);

    expect(events).toEqual([]);
  });
});

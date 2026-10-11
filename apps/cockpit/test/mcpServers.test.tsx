/**
 * Admin → Plugins → MCP servers: the add/edit dialog sends exactly what
 * the contract asks for (and keeps saved secrets without sending them),
 * the tier picker never offers Auto for a tool that changes things,
 * servers from config/mcp.yaml cannot be edited or removed here, and
 * the live event moves the status without a refresh.
 */
import type { McpServerView, McpToolView } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { ApiCallError, api, localError } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { McpServerDialog } from '../src/ops/McpServerDialog';
import { McpServersSection, McpToolRow } from '../src/ops/McpServers';
import { MCP_SERVERS_KEY, onMcpServerChanged, TOOLS_KEY } from '../src/ops/mcp';

const mocked = api as unknown as Record<'get' | 'post' | 'put' | 'patch' | 'del', ReturnType<typeof vi.fn>>;

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

function tool(p: Partial<McpToolView> = {}): McpToolView {
  return {
    name: 'search',
    id: 'notes__search',
    description: 'Search the notes.',
    tier: 'gated',
    default_tier: 'gated',
    overridden: false,
    disabled: false,
    destructive: false,
    read_only: true,
    ...p,
  };
}

function server(p: Partial<McpServerView> = {}): McpServerView {
  return {
    id: 'srv:notes',
    name: 'notes',
    transport: 'stdio',
    source: 'app',
    enabled: true,
    command: 'npx',
    args: ['-y', '@acme/notes-mcp'],
    env: { LOG_LEVEL: 'info' },
    url: null,
    headers: {},
    secrets: [],
    status: 'connected',
    last_error: null,
    connected_at: new Date().toISOString(),
    tools: [tool()],
    ...p,
  };
}

const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  queryClient.clear();
  for (const f of Object.values(mocked)) f.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('adding a server', () => {
  it('says what is missing and sends nothing until it is right (local command)', async () => {
    mocked.post.mockResolvedValue(server());
    wrap(<McpServerDialog open server={null} offerGitHub onOpenChange={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    expect(await screen.findByText('Give the server a name.')).toBeInTheDocument();
    expect(screen.getByText('Enter the command that starts the server.')).toBeInTheDocument();
    expect(mocked.post).not.toHaveBeenCalled();

    type('Name', 'Notes!');
    expect(screen.getByText(/lower-case letters, digits/)).toBeInTheDocument();

    type('Name', 'notes');
    type('Command', ' npx ');
    type('Arguments', '-y\n @acme/notes-mcp \n\n/home/me/notes');
    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));
    type('Name of variable 1', 'LOG_LEVEL');
    type('Value of LOG_LEVEL', 'info');
    fireEvent.click(screen.getByRole('button', { name: 'Add secret' }));
    type('Name of secret 1', 'NOTES_KEY');
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    expect(await screen.findByText(/Enter a value for each new secret/)).toBeInTheDocument();
    expect(mocked.post).not.toHaveBeenCalled();

    type('Value of NOTES_KEY', 'sk-123');
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(1));
    expect(mocked.post).toHaveBeenCalledWith('/mcp/servers', {
      name: 'notes',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@acme/notes-mcp', '/home/me/notes'],
      env: { LOG_LEVEL: 'info' },
      secrets: [{ key: 'NOTES_KEY', value: 'sk-123' }],
    });
  });

  it('sends a remote server with plain and secret headers', async () => {
    mocked.post.mockResolvedValue(server({ transport: 'http' }));
    wrap(<McpServerDialog open server={null} offerGitHub={false} onOpenChange={() => {}} />);

    fireEvent.click(screen.getByRole('radio', { name: 'Remote' }));
    type('Name', 'search');
    type('Address', 'not an address');
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    expect(await screen.findByText(/Enter a full address/)).toBeInTheDocument();

    type('Address', 'https://search.example.com/mcp');
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    type('Name of header 1', 'X-Workspace');
    type('Value of X-Workspace', 'research');
    fireEvent.click(screen.getByRole('button', { name: 'Add secret' }));
    type('Name of secret 1', 'Authorization');
    type('Value of Authorization', 'Bearer abc');
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));

    await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(1));
    expect(mocked.post).toHaveBeenCalledWith('/mcp/servers', {
      name: 'search',
      enabled: true,
      transport: 'http',
      url: 'https://search.example.com/mcp',
      headers: { 'X-Workspace': 'research' },
      secrets: [{ key: 'Authorization', value: 'Bearer abc' }],
    });
  });

  it("shows Core's answer in the form, next to the name", async () => {
    mocked.post.mockRejectedValue(
      new ApiCallError(
        409,
        localError('mcp.name_taken', 'There is already a server called notes', 'Pick another name.', 't1'),
      ),
    );
    wrap(<McpServerDialog open server={null} offerGitHub={false} onOpenChange={() => {}} />);
    type('Name', 'notes');
    type('Command', 'npx');
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    expect(
      await screen.findByText('There is already a server called notes. Pick another name.'),
    ).toBeInTheDocument();
  });

  it('offers GitHub as a quick start', () => {
    wrap(<McpServerDialog open server={null} offerGitHub onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'GitHub' }));
    expect(screen.getByRole('button', { name: 'Add GitHub' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Add server' })).toBeInTheDocument();
  });
});

describe('editing a server', () => {
  it('keeps saved secrets without sending them, and deletes the ones removed', async () => {
    const s = server({
      secrets: [
        { key: 'NOTES_KEY', set: true },
        { key: 'OLD_TOKEN', set: true },
        { key: 'REGION_KEY', set: true },
      ],
    });
    mocked.patch.mockResolvedValue(s);
    wrap(<McpServerDialog open server={s} offerGitHub onOpenChange={() => {}} />);

    expect(screen.queryByRole('button', { name: 'GitHub' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Saved')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Remove OLD_TOKEN' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace REGION_KEY' }));
    type('Value of REGION_KEY', 'eu-new');
    fireEvent.click(screen.getByRole('button', { name: 'Add secret' }));
    type('Name of secret 3', 'EXTRA');
    type('Value of EXTRA', 'x1');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mocked.patch).toHaveBeenCalledTimes(1));
    expect(mocked.patch).toHaveBeenCalledWith('/mcp/servers/srv%3Anotes', {
      name: 'notes',
      command: 'npx',
      args: ['-y', '@acme/notes-mcp'],
      env: { LOG_LEVEL: 'info' },
      secrets: [{ key: 'NOTES_KEY' }, { key: 'REGION_KEY', value: 'eu-new' }, { key: 'EXTRA', value: 'x1' }],
    });
  });

  it('a Replace left empty keeps the saved value', async () => {
    const s = server({ secrets: [{ key: 'NOTES_KEY', set: true }] });
    mocked.patch.mockResolvedValue(s);
    wrap(<McpServerDialog open server={s} offerGitHub={false} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Replace NOTES_KEY' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mocked.patch).toHaveBeenCalledTimes(1));
    expect(mocked.patch.mock.calls[0]?.[1]).toMatchObject({ secrets: [{ key: 'NOTES_KEY' }] });
    expect(mocked.patch.mock.calls[0]?.[1].secrets[0]).not.toHaveProperty('value');
  });
});

describe('tool settings', () => {
  it('never offers Auto for a tool that changes things', () => {
    wrap(
      <ul>
        <McpToolRow
          serverId="srv:notes"
          tool={tool({ name: 'delete_note', destructive: true, read_only: false })}
        />
      </ul>,
    );
    const select = screen.getByRole('combobox', { name: 'How delete_note asks' });
    const auto = within(select).getByRole('option', { name: /^Auto/ });
    expect(auto).toBeDisabled();
    expect(auto).toHaveTextContent('not for tools that change things');
    expect(screen.getByText('Changes things')).toBeInTheDocument();
  });

  it('offers Auto otherwise, and sends the choice (or null for the default)', async () => {
    mocked.patch.mockResolvedValue(server());
    wrap(
      <ul>
        <McpToolRow serverId="srv:notes" tool={tool({ overridden: true, tier: 'critical' })} />
      </ul>,
    );
    const select = screen.getByRole('combobox', { name: 'How search asks' });
    expect(within(select).getByRole('option', { name: 'Auto' })).toBeEnabled();
    expect(screen.getByText('Changed')).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'auto' } });
    await waitFor(() =>
      expect(mocked.patch).toHaveBeenCalledWith('/mcp/servers/srv%3Anotes/tools/search', { tier: 'auto' }),
    );
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() =>
      expect(mocked.patch).toHaveBeenCalledWith('/mcp/servers/srv%3Anotes/tools/search', { tier: null }),
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Let the assistant use search' }));
    await waitFor(() =>
      expect(mocked.patch).toHaveBeenCalledWith('/mcp/servers/srv%3Anotes/tools/search', { disabled: true }),
    );
  });
});

describe('the server list', () => {
  it('lets you edit and remove servers added here, but not ones from the config file', async () => {
    mocked.get.mockResolvedValue([
      server(),
      server({
        id: 'file:search',
        name: 'search',
        source: 'file',
        status: 'error',
        last_error: 'The command npx was not found.',
      }),
    ]);
    wrap(<McpServersSection />);

    const fromFile = await screen.findByRole('listitem', { name: /^search,/ });
    expect(within(fromFile).getByText('From config file')).toBeInTheDocument();
    expect(within(fromFile).getByText('The command npx was not found.')).toBeInTheDocument();
    expect(within(fromFile).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(fromFile).queryByRole('button', { name: 'More for search' })).not.toBeInTheDocument();
    expect(within(fromFile).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(fromFile).getByRole('button', { name: 'Test connection' })).toBeInTheDocument();

    const mine = screen.getByRole('listitem', { name: /^notes,/ });
    expect(within(mine).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(mine).getByRole('button', { name: 'More for notes' })).toBeInTheDocument();
    expect(within(mine).getByRole('switch', { name: 'Use notes' })).toBeChecked();

    // Tools of a file server can still be changed.
    fireEvent.click(within(fromFile).getByRole('button', { name: 'Show 1 tool' }));
    expect(within(fromFile).getByRole('combobox', { name: 'How search asks' })).toBeEnabled();
  });

  it('says how to start when there are none', async () => {
    mocked.get.mockResolvedValue({ items: [], next_cursor: null });
    wrap(<McpServersSection />);
    expect(await screen.findByText('No MCP servers yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    expect(screen.getByRole('dialog', { name: 'Add server' })).toBeInTheDocument();
  });
});

describe('live status', () => {
  it('moves the dot at once and refetches the servers and tools', () => {
    queryClient.setQueryData(MCP_SERVERS_KEY, [server({ status: 'connecting', tools: [] })]);
    const spy = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    const base = { seq: 1, at: new Date().toISOString() };

    onMcpServerChanged(
      {
        ...base,
        type: 'mcp.server_changed',
        server_id: 'srv:notes',
        name: 'notes',
        status: 'error',
        tools: 0,
        detail: 'Refused.',
      },
      queryClient,
    );
    expect(queryClient.getQueryData<McpServerView[]>(MCP_SERVERS_KEY)?.[0]).toMatchObject({
      status: 'error',
      last_error: 'Refused.',
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: MCP_SERVERS_KEY });
    expect(spy).toHaveBeenCalledWith({ queryKey: TOOLS_KEY });

    onMcpServerChanged(
      {
        ...base,
        type: 'mcp.server_changed',
        server_id: 'srv:notes',
        name: 'notes',
        status: 'removed',
        tools: 0,
      },
      queryClient,
    );
    expect(queryClient.getQueryData<McpServerView[]>(MCP_SERVERS_KEY)).toEqual([]);
  });

  it('shows the new status on screen without a refresh', async () => {
    mocked.get.mockResolvedValue([server({ status: 'connecting', tools: [] })]);
    wrap(<McpServersSection />);
    expect(await screen.findByRole('listitem', { name: 'notes, Connecting' })).toBeInTheDocument();
    // The refetch the event asks for answers with the same old list; the event wins until then.
    mocked.get.mockReturnValue(new Promise(() => {}));
    onMcpServerChanged(
      {
        seq: 2,
        at: new Date().toISOString(),
        type: 'mcp.server_changed',
        server_id: 'srv:notes',
        name: 'notes',
        status: 'connected',
        tools: 3,
      },
      queryClient,
    );
    expect(await screen.findByRole('listitem', { name: 'notes, Connected' })).toBeInTheDocument();
  });
});

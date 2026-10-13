import { describe, expect, it } from 'vitest';
import { RunEvent, stepCommand, stepDescription, stepTitle, toolKind, webHits } from '../src/index';

describe('tool steps in words (the same for every engine)', () => {
  it('a call that describes itself leads with its description', () => {
    const bash = {
      command: 'rg -n MPass src',
      description: 'Reading M-Pass data models and repository interface',
    };
    expect(stepDescription('Bash', bash)).toBe('Reading M-Pass data models and repository interface');
    expect(stepTitle('Bash', bash)).toBe('Reading M-Pass data models and repository interface');
    expect(stepCommand('Bash', bash)).toBe('rg -n MPass src');
    expect(stepTitle('Task', { description: 'Map the M-Pass code', subagent_type: 'Explore' })).toBe(
      'Map the M-Pass code',
    );
    expect(stepCommand('Agent', { description: 'x', subagent_type: 'Explore' })).toBe('Explore');
    expect(
      stepTitle('TodoWrite', {
        todos: [
          { content: 'Plan', status: 'completed', activeForm: 'Planning' },
          { content: 'Build it', status: 'in_progress', activeForm: 'Building it' },
        ],
      }),
    ).toBe('Building it');
  });

  it('a call without one gets a title made from its input', () => {
    expect(stepDescription('Read', { file_path: '/a/b.ts' })).toBeNull();
    expect(stepTitle('Read', { file_path: '/home/me/proj/src/models/pass.ts' })).toBe(
      'Reading …/src/models/pass.ts',
    );
    expect(stepTitle('Grep', { pattern: 'MPass' })).toBe("Searching for 'MPass'");
    expect(stepTitle('Glob', { pattern: '**/*.ts' })).toBe("Searching for '**/*.ts'");
    expect(stepTitle('WebFetch', { url: 'https://www.example.com/docs' })).toBe('Fetching example.com');
    expect(stepTitle('WebSearch', { query: 'AI tutoring' })).toBe("Searching the web for 'AI tutoring'");
    expect(stepTitle('web_search', { query: 'AI tutoring' })).toBe("Searching the web for 'AI tutoring'");
    expect(stepTitle('Bash', { command: 'pnpm test\necho done' })).toBe('Running pnpm test');
    expect(stepTitle('fs_read', { path: '/workspace/notes.md' })).toBe('Reading /workspace/notes.md');
    expect(stepTitle('python_run', { code: 'print(1)' })).toBe('Running Python');
    expect(stepTitle('mcp__github__create_issue', {})).toBe('Using create_issue from github');
    expect(stepTitle('Frobnicate', null)).toBe('Using Frobnicate');
    expect(toolKind('PowerShell')).toBe('shell');
    expect(toolKind('mcp__x__y')).toBe('mcp');
  });

  it('web search hits come out of every shape a search returns', () => {
    const text =
      'Web search results for query: "x"\n\nLinks: [{"title":"A \\"quoted\\" one","url":"https://a.example"},{"title":"B","url":"https://b.example"}]';
    expect(webHits(text)).toEqual([
      { title: 'A "quoted" one', url: 'https://a.example' },
      { title: 'B', url: 'https://b.example' },
    ]);
    // The API's web_search_tool_result content.
    expect(
      webHits([
        { type: 'web_search_result', title: 'C', url: 'https://c.example', encrypted_content: 'zzz' },
      ]),
    ).toEqual([{ title: 'C', url: 'https://c.example' }]);
    // A list of text blocks, and bare links.
    expect(webHits([{ type: 'text', text }])).toHaveLength(2);
    expect(webHits('see https://d.example/page and javascript:alert(1)')).toEqual([
      { title: null, url: 'https://d.example/page' },
    ]);
  });

  it('tool.call carries the title; activity says hooks or compaction', () => {
    const base = { seq: 1, at: '2026-10-13T12:00:00Z' };
    const call = RunEvent.parse({
      ...base,
      type: 'tool.call',
      call_id: 'c',
      tool: 'Bash',
      args_preview: {},
      tier: 'auto',
      title: 'Reading things',
    });
    expect(call.type === 'tool.call' && call.title).toBe('Reading things');
    expect(RunEvent.parse({ ...base, type: 'activity', phase: 'hooks', detail: 'Running hooks' }).type).toBe(
      'activity',
    );
    expect(RunEvent.parse({ ...base, type: 'activity', phase: null }).type).toBe('activity');
  });
});

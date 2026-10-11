#!/usr/bin/env node
// A stand-in for the Claude Code CLI in tests. Behaviour comes from env:
// FAKE_CLAUDE_VERSION (default 2.1.286), FAKE_CLAUDE_SIGNED_IN (1/0).
const args = process.argv.slice(2).join(' ');
const version = process.env.FAKE_CLAUDE_VERSION ?? '2.1.286';
const signedIn = process.env.FAKE_CLAUDE_SIGNED_IN !== '0';

if (args === '--version') {
  process.stdout.write(`${version} (Claude Code)\n`);
} else if (args === 'auth status --json') {
  process.stdout.write(
    JSON.stringify({
      loggedIn: signedIn,
      authMethod: signedIn ? 'claude.ai' : 'none',
      apiProvider: 'firstParty',
      email: 'person@example.com',
      orgId: 'org-secret-id',
      orgName: 'Secret Org',
      subscriptionType: signedIn ? 'max' : null,
      projectsDirectory: '/home/person/.claude/projects',
      configDirectory: '/home/person/.claude',
    }),
  );
  if (!signedIn) process.exitCode = 1;
} else if (args === 'auth logout') {
  process.stdout.write('Logged out\n');
} else {
  process.stderr.write(`unknown: ${args}\n`);
  process.exitCode = 2;
}

#!/usr/bin/env node
/**
 * Board workspace tools (board mode): outcomes must be verified, SSH
 * transport failures must THROW, and remote command construction must be
 * shell-safe. Uses an injected fake runner — no real SSH.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/device-workspace.spec.mjs
 */
import assert from 'node:assert/strict';
import {
  createBoardWorkspaceTools,
  buildBoardWriteCommand,
  BOARD_REPLACED_TOOL_NAMES,
  BOARD_MV_OK,
  BOARD_MV_SRC_MISSING,
} from '../dist/tools/device-workspace.js';
import { ProcessError } from '../dist/utils/run-process.js';

const CONFIG = { host: '192.168.1.10', user: 'root', port: 22 };

function toolsWithRunner(impl) {
  const calls = [];
  const runner = async (cmd, opts) => {
    calls.push({ cmd, args: opts.args });
    return impl(cmd, opts);
  };
  const tools = createBoardWorkspaceTools(CONFIG, { runProcessImpl: runner });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { byName, calls };
}

function remoteCommandOf(call) {
  // last arg of the ssh command line is the escaped remote command
  return call.args[call.args.length - 1];
}

// All replaced names are actually produced
{
  const { byName } = toolsWithRunner(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
  for (const name of BOARD_REPLACED_TOOL_NAMES) {
    assert.ok(byName[name], `board tool set must include ${name}`);
    assert.match(byName[name].description, /BOARD/i, `${name} must declare it runs on the board`);
  }
}

// exec: success returns output; remote non-zero exit returns honest "Command failed"
{
  const { byName } = toolsWithRunner(async () => ({ stdout: 'hello\n', stderr: '', exitCode: 0 }));
  assert.equal(await byName.exec.execute({ command: 'echo hello' }, {}), 'hello');
}
{
  const { byName } = toolsWithRunner(async () => {
    throw new ProcessError(2, 'partial', 'boom');
  });
  const out = await byName.exec.execute({ command: 'false' }, {});
  assert.match(out, /Command failed \(exit 2\)/);
  assert.match(out, /partial/);
  assert.match(out, /boom/);
}

// exec: ssh transport failure (exit 255) THROWS — never looks like command output
{
  const { byName } = toolsWithRunner(async () => {
    throw new ProcessError(255, '', 'ssh: connect to host 192.168.1.10 port 22: No route to host');
  });
  await assert.rejects(
    () => byName.exec.execute({ command: 'echo hi' }, {}),
    /No route to host/,
  );
}

// exec: dangerous commands blocked before any SSH call
{
  const { byName, calls } = toolsWithRunner(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
  const out = await byName.exec.execute({ command: 'rm -rf /' }, {});
  assert.match(out, /Command blocked/);
  assert.equal(calls.length, 0, 'blocked command must not reach SSH');
}

// read_file: line numbers + cat failure throws
{
  const { byName } = toolsWithRunner(async () => ({ stdout: 'a\nb', stderr: '', exitCode: 0 }));
  const out = await byName.read_file.execute({ path: '/etc/hostname' }, {});
  assert.match(out, /1\ta\n2\tb/);
}
{
  const { byName } = toolsWithRunner(async () => {
    throw new ProcessError(1, '', 'cat: /nope: No such file or directory');
  });
  await assert.rejects(() => byName.read_file.execute({ path: '/nope' }, {}), /No such file/);
}

// write_file: byte-count verified — success and mismatch paths
{
  const content = 'hello board';
  const expected = Buffer.byteLength(content, 'utf-8');
  const { byName, calls } = toolsWithRunner(async () => ({ stdout: `${expected}\n`, stderr: '', exitCode: 0 }));
  const out = await byName.write_file.execute({ path: '/tmp/x.txt', content }, {});
  assert.match(out, new RegExp(`wrote ${expected} bytes .*verified`));
  const remote = remoteCommandOf(calls[0]);
  assert.match(remote, /base64 -d/);
  assert.match(remote, /wc -c/);
  assert.match(remote, /\.dmoss-tmp/, 'write must be atomic (tmp + mv)');
}
{
  const { byName } = toolsWithRunner(async () => ({ stdout: '0\n', stderr: '', exitCode: 0 }));
  await assert.rejects(
    () => byName.write_file.execute({ path: '/tmp/x.txt', content: 'hello' }, {}),
    /Write verification failed/,
  );
}

// buildBoardWriteCommand round-trips content through base64
{
  const cmd = buildBoardWriteCommand('/tmp/f', "it's a test");
  const b64 = Buffer.from("it's a test", 'utf-8').toString('base64');
  assert.ok(cmd.includes(b64), 'content must be base64-embedded');
}

// edit_file: unique-match semantics enforced before any write
{
  let writes = 0;
  const { byName } = toolsWithRunner(async (cmd, opts) => {
    const remote = opts.args[opts.args.length - 1];
    if (remote.includes('cat')) return { stdout: 'aa bb aa', stderr: '', exitCode: 0 };
    writes += 1;
    return { stdout: '8\n', stderr: '', exitCode: 0 };
  });
  const out = await byName.edit_file.execute({ path: '/tmp/f', old_string: 'aa', new_string: 'cc' }, {});
  assert.match(out, /not unique .*2 matches/);
  assert.equal(writes, 0, 'ambiguous edit must not write');
}
{
  const { byName } = toolsWithRunner(async (cmd, opts) => {
    const remote = opts.args[opts.args.length - 1];
    if (remote.includes('cat')) return { stdout: 'aa bb aa', stderr: '', exitCode: 0 };
    return { stdout: String(Buffer.byteLength('cc bb cc', 'utf-8')), stderr: '', exitCode: 0 };
  });
  const out = await byName.edit_file.execute(
    { path: '/tmp/f', old_string: 'aa', new_string: 'cc', replace_all: true },
    {},
  );
  assert.match(out, /replaced 2 occurrences, write verified/);
}

// search_code: grep exit 1 = no matches (not an error); exit 2 = real failure
{
  const { byName } = toolsWithRunner(async () => {
    throw new ProcessError(1, '', '');
  });
  assert.equal(await byName.search_code.execute({ pattern: 'nothing' }, {}), 'No matches found');
}
{
  const { byName } = toolsWithRunner(async () => {
    throw new ProcessError(2, '', 'grep: bad regex');
  });
  await assert.rejects(() => byName.search_code.execute({ pattern: '[' }, {}), /exit 2/);
}

// move_file: marker-verified outcomes
{
  const { byName } = toolsWithRunner(async () => ({ stdout: `${BOARD_MV_OK}\n`, stderr: '', exitCode: 0 }));
  const out = await byName.move_file.execute({ source: '/a', destination: '/b' }, {});
  assert.match(out, /Moved \/a -> \/b .*verified/);
}
{
  const { byName } = toolsWithRunner(async () => ({ stdout: `${BOARD_MV_SRC_MISSING}\n`, stderr: '', exitCode: 0 }));
  const out = await byName.move_file.execute({ source: '/a', destination: '/b' }, {});
  assert.match(out, /source does not exist/);
}
{
  const { byName } = toolsWithRunner(async () => ({ stdout: 'garbage', stderr: '', exitCode: 0 }));
  await assert.rejects(
    () => byName.move_file.execute({ source: '/a', destination: '/b' }, {}),
    /could not verify/,
  );
}

// Shell safety: paths with quotes are escaped in the remote command
{
  const { byName, calls } = toolsWithRunner(async () => ({ stdout: 'x', stderr: '', exitCode: 0 }));
  await byName.read_file.execute({ path: "/tmp/it's.txt" }, {});
  const remote = remoteCommandOf(calls[0]);
  assert.ok(remote.includes("'\\''") || remote.includes("\\'"), 'single quote must be escaped');
}

console.log('[PASS] board workspace tools: verified outcomes, transport failures throw, shell-safe commands');

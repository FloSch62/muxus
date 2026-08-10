import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { shellIntegration, writeIntegrationFiles } from '../../../server/src/local/shell-integration.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'muxus-shellint-'));
  writeIntegrationFiles(root);
});

describe('writeIntegrationFiles', () => {
  it('emits OSC 133 command reports from the zsh shim', () => {
    const zshrc = readFileSync(path.join(root, 'zsh/.zshrc'), 'utf8');
    expect(zshrc).toContain(String.raw`\e]133;D;%s\a`);
    expect(zshrc).toContain(String.raw`\e]133;C\a`);
    expect(zshrc).toContain(String.raw`\e]133;P;Cwd=%s\a`);
    expect(zshrc).toContain('__muxus_report_cwd');
    expect(zshrc).toContain('add-zsh-hook precmd');
    expect(zshrc).toContain('add-zsh-hook preexec');
  });

  it('sources the user zsh startup files before hooking', () => {
    const zshenv = readFileSync(path.join(root, 'zsh/.zshenv'), 'utf8');
    const zshrc = readFileSync(path.join(root, 'zsh/.zshrc'), 'utf8');
    expect(zshenv).toContain('${ZDOTDIR:-$HOME}/.zshenv');
    expect(zshrc).toContain('${ZDOTDIR:-$HOME}/.zshrc');
  });

  it('reports via PS0 and PROMPT_COMMAND in the bash shim', () => {
    const bash = readFileSync(path.join(root, 'bash-init.bash'), 'utf8');
    expect(bash).toContain('"$HOME/.bashrc"');
    expect(bash).toContain('PS0="\\[\\e]133;C\\a\\]${PS0-}"');
    expect(bash).toContain('PROMPT_COMMAND="__muxus_prompt_mark${PROMPT_COMMAND:+;$PROMPT_COMMAND}"');
    expect(bash).toContain(String.raw`\e]133;P;Cwd=%s\a`);
  });
});

describe('shellIntegration', () => {
  it('redirects zsh through the shim ZDOTDIR', () => {
    const result = shellIntegration('/usr/bin/zsh', {}, root);
    expect(result.args).toEqual([]);
    expect(result.env).toEqual({ ZDOTDIR: path.join(root, 'zsh') });
  });

  it('carries the user ZDOTDIR through for the shim to restore', () => {
    const result = shellIntegration('/bin/zsh', { ZDOTDIR: '/home/u/.config/zsh' }, root);
    expect(result.env).toEqual({
      ZDOTDIR: path.join(root, 'zsh'),
      MUXUS_USER_ZDOTDIR: '/home/u/.config/zsh',
    });
  });

  it('starts bash with the init-file shim', () => {
    const result = shellIntegration('/bin/bash', {}, root);
    expect(result.args).toEqual(['--init-file', path.join(root, 'bash-init.bash')]);
    expect(result.env).toEqual({});
  });

  it('prefixes the native cmd prompt with a live Windows cwd report', () => {
    const result = shellIntegration(
      String.raw`C:\Windows\System32\cmd.exe`,
      { PROMPT: '$S$P$G' },
      null,
      'win32',
    );

    expect(result.args).toEqual([]);
    expect(result.env).toEqual({ PROMPT: String.raw`$E]133;P;Cwd=$P$E\$S$P$G` });
  });

  it('uses the standard visible cmd prompt when none was configured', () => {
    expect(shellIntegration('cmd.exe', {}, null, 'win32').env).toEqual({
      PROMPT: String.raw`$E]133;P;Cwd=$P$E\$P$G`,
    });
  });

  it('leaves other Windows shells untouched', () => {
    expect(shellIntegration('powershell.exe', {}, null, 'win32')).toEqual({ args: [], env: {} });
  });

  it('leaves other shells untouched', () => {
    expect(shellIntegration('/usr/bin/fish', {}, root)).toEqual({ args: [], env: {} });
  });

  it('degrades to no integration when the shim dir is unavailable', () => {
    expect(shellIntegration('/bin/zsh', {}, null)).toEqual({ args: [], env: {} });
  });
});

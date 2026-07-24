import { describe, expect, it } from 'vitest';
import {
  GENERAL_TEXT_LANGUAGE_ID,
  languageForPath,
} from '../../../client/src/editor/language-detection.js';

describe('remote editor language detection', () => {
  it('recognizes common and compound source extensions', () => {
    expect(languageForPath('/srv/app/main.tsx')).toBe('typescript');
    expect(languageForPath('/srv/app/site.html.liquid')).toBe('liquid');
    expect(languageForPath('/infra/main.tf')).toBe('hcl');
    expect(languageForPath('/src/App.csproj')).toBe('xml');
    expect(languageForPath('/api/schema.graphql')).toBe('graphql');
    expect(languageForPath('/srv/app/pyproject.toml')).toBe('ini');
  });

  it('recognizes conventional extensionless configuration and script names', () => {
    expect(languageForPath('/srv/app/Dockerfile')).toBe('dockerfile');
    expect(languageForPath('/srv/app/Containerfile')).toBe('dockerfile');
    expect(languageForPath('/home/alice/.zshrc')).toBe('shell');
    expect(languageForPath('/srv/app/.env.production')).toBe('shell');
    expect(languageForPath('/etc/ssh/sshd_config')).toBe('ini');
    expect(languageForPath('/home/alice/.kube/config')).toBe('yaml');
    expect(languageForPath('/etc/kubernetes/admin.conf')).toBe('yaml');
    expect(languageForPath('/home/alice/.aws/credentials')).toBe('ini');
  });

  it('uses a shebang or XML prologue when the filename is ambiguous', () => {
    expect(languageForPath('/usr/local/bin/deploy', '#!/usr/bin/env python3\nprint("ok")')).toBe('python');
    expect(languageForPath('/usr/local/bin/start', '#!/bin/zsh\nexec app')).toBe('shell');
    expect(languageForPath('/tmp/vector', '<?xml version="1.0"?>\n<svg />')).toBe('xml');
  });

  it('falls back to general highlighting for text and unsupported formats', () => {
    expect(languageForPath('/notes/readme.txt')).toBe(GENERAL_TEXT_LANGUAGE_ID);
    expect(languageForPath('/var/log/application.log')).toBe(GENERAL_TEXT_LANGUAGE_ID);
    expect(languageForPath('/etc/hosts', '127.0.0.1 localhost')).toBe(GENERAL_TEXT_LANGUAGE_ID);
  });
});

import { describe, expect, it } from 'vitest';
import {
  fileIconKind,
  folderIconKind,
} from '../../../client/src/file-icon-resolver.js';

describe('SFTP file icon resolver', () => {
  it('recognizes developer files by extension', () => {
    expect(fileIconKind('App.tsx')).toBe('react');
    expect(fileIconKind('main.ts')).toBe('typescript');
    expect(fileIconKind('schema.graphql')).toBe('graphql');
    expect(fileIconKind('main.tf')).toBe('terraform');
    expect(fileIconKind('photo.webp')).toBe('image');
    expect(fileIconKind('backup.tar.gz')).toBe('archive');
  });

  it('gives special project files distinct icons', () => {
    expect(fileIconKind('package.json')).toBe('npm');
    expect(fileIconKind('pnpm-lock.yaml')).toBe('pnpm');
    expect(fileIconKind('Dockerfile')).toBe('docker');
    expect(fileIconKind('docker-compose.yml')).toBe('docker');
    expect(fileIconKind('README.md')).toBe('markdown');
    expect(fileIconKind('LICENSE.txt')).toBe('license');
    expect(fileIconKind('.env.production')).toBe('env');
    expect(fileIconKind('tsconfig.node.json')).toBe('typescript');
  });

  it('falls back safely for extensionless and unknown files', () => {
    expect(fileIconKind('deploy')).toBe('file');
    expect(fileIconKind('artifact.unknown')).toBe('file');
    expect(fileIconKind('.envoy')).toBe('file');
  });
});

describe('SFTP folder icon resolver', () => {
  it('recognizes common project folders case-insensitively', () => {
    expect(folderIconKind('src')).toBe('source');
    expect(folderIconKind('__tests__')).toBe('tests');
    expect(folderIconKind('node_modules')).toBe('dependencies');
    expect(folderIconKind('.git')).toBe('git');
    expect(folderIconKind('.SSH')).toBe('secure');
    expect(folderIconKind('public')).toBe('public');
  });

  it('uses the standard folder for unfamiliar names', () => {
    expect(folderIconKind('quarterly-reports')).toBe('folder');
  });
});

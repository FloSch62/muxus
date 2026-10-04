import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_LOG_FILE_PATTERN,
  sessionLogFileName,
  sessionLogFilePatternError,
} from '@muxus/shared';

const startedAt = new Date(2026, 9, 4, 9, 5, 7);

describe('session log file names', () => {
  it('fills the default pattern with the host and local start time', () => {
    expect(
      sessionLogFileName(DEFAULT_SESSION_LOG_FILE_PATTERN, {
        host: 'admin@router1',
        title: 'Core router',
        kind: 'ssh',
        startedAt,
      }),
    ).toEqual(['admin@router1_2026-10-04_09-05-07.log']);
  });

  it('turns slashes in the pattern into folders but never in values', () => {
    expect(
      sessionLogFileName('{kind}/{title}/{date}.log', {
        host: '10.0.0.1:23',
        title: '../etc/passwd',
        kind: 'telnet',
        startedAt,
      }),
    ).toEqual(['telnet', '.._etc_passwd', '2026-10-04.log']);
    expect(
      sessionLogFileName('{host}.log', {
        host: 'COM3:?',
        title: '',
        kind: 'serial',
        startedAt,
      }),
    ).toEqual(['COM3__.log']);
  });

  it('never yields an empty or dot-only name', () => {
    expect(
      sessionLogFileName('{title}/{host}', {
        host: '..',
        title: '   ',
        kind: 'ssh',
        startedAt,
      }),
    ).toEqual(['_', '_']);
  });

  it('explains unusable patterns', () => {
    expect(sessionLogFilePatternError(DEFAULT_SESSION_LOG_FILE_PATTERN)).toBeNull();
    expect(sessionLogFilePatternError('{host}/{date}/{time}.log')).toBeNull();
    expect(sessionLogFilePatternError('  ')).toMatch(/Enter/);
    expect(sessionLogFilePatternError('{hostname}.log')).toMatch(/\{hostname\}/);
    expect(sessionLogFilePatternError('{host.log')).toMatch(/placeholder/);
    expect(sessionLogFilePatternError('/var/log/{host}.log')).toMatch(/absolute/);
    expect(sessionLogFilePatternError('C:{host}.log')).toMatch(/absolute/);
    expect(sessionLogFilePatternError('../{host}.log')).toMatch(/needs a name/);
    expect(sessionLogFilePatternError('{host}//x.log')).toMatch(/needs a name/);
    expect(sessionLogFilePatternError('{host}:{time}.log')).toMatch(/not allowed/);
    expect(sessionLogFilePatternError('{host}\\{time}.log')).toMatch(/not allowed/);
  });
});

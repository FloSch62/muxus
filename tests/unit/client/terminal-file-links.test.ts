import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachTerminalFileLinks,
  resolveTerminalFilePath,
  terminalFileLinkCandidates,
} from '../../../client/src/terminal/file-links.js';
import {
  terminalFileLinkActivationForPlatform,
  terminalFileLinkActivationOptions,
} from '../../../client/src/terminal/file-link-activation.js';
import { openTerminalWebLink } from '../../../client/src/terminal/web-links.js';

afterEach(() => vi.unstubAllGlobals());

interface ProvidedLink {
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  decorations?: { pointerCursor?: boolean; underline?: boolean };
  activate: (event: MouseEvent, text: string) => void;
}

interface StubLinkProvider {
  provideLinks: (
    line: number,
    callback: (links: ProvidedLink[] | undefined) => void,
  ) => void;
}

function terminalWithLine(text: string, spareCells = 1): {
  terminal: Parameters<typeof attachTerminalFileLinks>[0];
  provider: () => StubLinkProvider;
  clearSelection: ReturnType<typeof vi.fn>;
} {
  const cell = {
    chars: '',
    getChars() {
      return this.chars;
    },
    getWidth() {
      return 1;
    },
  };
  const line = {
    isWrapped: false,
    length: text.length + spareCells,
    translateToString: () => text,
    getCell: (index: number) => {
      cell.chars = text[index] ?? '';
      return cell;
    },
  };
  let registered: StubLinkProvider | undefined;
  const clearSelection = vi.fn();
  const terminal = {
    buffer: {
      active: {
        getLine: (index: number) => index === 0 ? line : undefined,
        getNullCell: () => cell,
      },
    },
    registerLinkProvider: (provider: StubLinkProvider) => {
      registered = provider;
      return { dispose: () => undefined };
    },
    clearSelection,
  } as unknown as Parameters<typeof attachTerminalFileLinks>[0];
  return {
    terminal,
    clearSelection,
    provider: () => {
      if (!registered) throw new Error('link provider was not registered');
      return registered;
    },
  };
}

function mouseEvent(
  modifiers: Partial<Pick<MouseEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {},
  button = 0,
): {
  event: MouseEvent;
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
} {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  return {
    event: {
      button,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault,
      stopPropagation,
      ...modifiers,
    } as unknown as MouseEvent,
    preventDefault,
    stopPropagation,
  };
}

describe('terminal file links', () => {
  it('only offers Cmd activation on macOS', () => {
    expect(terminalFileLinkActivationOptions(false).map((option) => option.value)).toEqual([
      'alt',
      'ctrl',
      'direct',
    ]);
    expect(terminalFileLinkActivationOptions(true).map((option) => option.value)).toEqual([
      'alt',
      'ctrl',
      'meta',
      'direct',
    ]);
  });

  it('falls back to Alt when a Cmd preference is restored on a non-Mac platform', () => {
    expect(terminalFileLinkActivationForPlatform('meta', false)).toBe('alt');
    expect(terminalFileLinkActivationForPlatform('meta', true)).toBe('meta');
  });

  it('finds absolute, relative, dotfile, and conventional file paths', () => {
    expect(
      terminalFileLinkCandidates(
        'edit /etc/hosts ./src/App.tsx ../shared/api.ts .env Dockerfile README',
      ).map((candidate) => candidate.path),
    ).toEqual([
      '/etc/hosts',
      './src/App.tsx',
      '../shared/api.ts',
      '.env',
      'Dockerfile',
      'README',
    ]);
  });

  it('supports quoted and shell-escaped paths with spaces', () => {
    expect(
      terminalFileLinkCandidates(String.raw`"/srv/my app/main.ts" './docs/user guide.md' src/a\ file.ts`).map(
        (candidate) => candidate.path,
      ),
    ).toEqual(['/srv/my app/main.ts', './docs/user guide.md', 'src/a file.ts']);
  });

  it('recognizes native Windows drive-letter and UNC paths without stripping separators', () => {
    expect(
      terminalFileLinkCandidates(
        String.raw`C:\Users\me\foo.txt C:/Users/me/bar.txt \\server\share\baz.txt`,
      ).map((candidate) => candidate.path),
    ).toEqual([
      String.raw`C:\Users\me\foo.txt`,
      'C:/Users/me/bar.txt',
      String.raw`\\server\share\baz.txt`,
    ]);
  });

  it('strips compiler locations and surrounding punctuation from the linked range', () => {
    const line = 'error: (src/main.ts:42:7), config.yaml(8,2) README.md:';
    const candidates = terminalFileLinkCandidates(line);
    expect(candidates.map((candidate) => candidate.path)).toEqual([
      'src/main.ts',
      'config.yaml',
      'README.md',
    ]);
    expect(candidates.map((candidate) => line.slice(candidate.start, candidate.end))).toEqual([
      'src/main.ts',
      'config.yaml',
      'README.md',
    ]);
  });

  it('does not link URLs, flags, versions, or ordinary prose', () => {
    expect(
      terminalFileLinkCandidates('open https://example.test/file.txt --config v1.2.3 ordinary words')
        .map((candidate) => candidate.path),
    ).toEqual([]);
  });

  it('does not confuse tagged container image references with file paths', () => {
    expect(
      terminalFileLinkCandidates(
        'image: ghcr.io/nokia/srlinux:latest ghcr.io/srl-labs/network-multitool:latest ghcr.io/nokia/srlinux',
      ),
    ).toEqual([]);
    expect(terminalFileLinkCandidates('image: srl-labs/network-multitool:latest')).toEqual([]);
    expect(terminalFileLinkCandidates('image: srl-labs/network-multitool:42')).toEqual([]);
  });

  it('recognizes only the regular filename in long ls output, including extensionless files', () => {
    expect(
      terminalFileLinkCandidates(
        '-rw-rw-rw-.  1 root root 3.8K Jul 23 16:33 containerlab.svg',
      ).map((candidate) => candidate.path),
    ).toEqual(['containerlab.svg']);
    expect(
      terminalFileLinkCandidates(
        '-rw-r--r--.  1 root root 406K Feb 27  2025 hist',
      ).map((candidate) => candidate.path),
    ).toEqual(['hist']);
    expect(
      terminalFileLinkCandidates(
        'drwxr-xr-x.  5 root root  100 May  4  2024 demo',
      ),
    ).toEqual([]);
    expect(
      terminalFileLinkCandidates(
        '-rw-r--r--. 1 root root system_u:object_r:admin_home_t:s0 928 Dec 1 2025 lic.txt',
      ).map((candidate) => candidate.path),
    ).toEqual(['lic.txt']);
    expect(
      terminalFileLinkCandidates(
        '-rw-r--r-- 1 root root 928 2025-12-01 09:42 +0100 lic.txt',
      ).map((candidate) => candidate.path),
    ).toEqual(['lic.txt']);
  });

  it('underlines a detected path on hover and maps its terminal range', () => {
    const { terminal, provider } = terminalWithLine('output: src/main.ts');
    attachTerminalFileLinks(terminal, vi.fn());
    let links: ProvidedLink[] | undefined;
    provider().provideLinks(1, (provided) => {
      links = provided;
    });
    expect(links).toHaveLength(1);
    expect(links![0]!.range).toEqual({
      start: { x: 9, y: 1 },
      end: { x: 19, y: 1 },
    });

    expect(links![0]!.decorations).toEqual({ pointerCursor: true, underline: true });
  });

  it.each([
    ['direct', {}, { altKey: true }],
    ['alt', { altKey: true }, {}],
    ['ctrl', { ctrlKey: true }, {}],
    ['meta', { metaKey: true }, {}],
  ] as const)(
    'opens a link only for the configured %s activation gesture',
    (activation, matchingModifiers, nonMatchingModifiers) => {
      const { terminal, provider, clearSelection } = terminalWithLine('output: src/main.ts');
      const onOpen = vi.fn();
      attachTerminalFileLinks(terminal, onOpen, activation);
      let links: ProvidedLink[] | undefined;
      provider().provideLinks(1, (provided) => {
        links = provided;
      });

      const wrongButton = mouseEvent(matchingModifiers, 2);
      links![0]!.activate(wrongButton.event, 'src/main.ts');
      expect(onOpen).not.toHaveBeenCalled();

      const ignored = mouseEvent(nonMatchingModifiers);
      links![0]!.activate(ignored.event, 'src/main.ts');
      expect(onOpen).not.toHaveBeenCalled();
      expect(ignored.preventDefault).not.toHaveBeenCalled();
      expect(ignored.stopPropagation).not.toHaveBeenCalled();

      const selectionGesture = mouseEvent({ ...matchingModifiers, shiftKey: true });
      links![0]!.activate(selectionGesture.event, 'src/main.ts');
      expect(onOpen).not.toHaveBeenCalled();

      const matching = mouseEvent(matchingModifiers);
      links![0]!.activate(matching.event, 'src/main.ts');
      expect(onOpen).toHaveBeenCalledOnce();
      expect(onOpen).toHaveBeenCalledWith('src/main.ts');
      expect(matching.preventDefault).toHaveBeenCalledOnce();
      expect(matching.stopPropagation).toHaveBeenCalledOnce();
      expect(clearSelection).toHaveBeenCalledOnce();
    },
  );

  it('reads the activation setting when clicked so open terminals update immediately', () => {
    const { terminal, provider } = terminalWithLine('output: src/main.ts');
    const onOpen = vi.fn();
    let activation: 'alt' | 'ctrl' = 'alt';
    attachTerminalFileLinks(terminal, onOpen, () => activation);
    let links: ProvidedLink[] | undefined;
    provider().provideLinks(1, (provided) => {
      links = provided;
    });

    links![0]!.activate(mouseEvent({ ctrlKey: true }).event, 'src/main.ts');
    expect(onOpen).not.toHaveBeenCalled();

    activation = 'ctrl';
    links![0]!.activate(mouseEvent({ ctrlKey: true }).event, 'src/main.ts');
    expect(onOpen).toHaveBeenCalledWith('src/main.ts');
  });

  it('keeps a link ending in the terminal last column on the current row', () => {
    const text = 'output: src/main.ts';
    const { terminal, provider } = terminalWithLine(text, 0);
    attachTerminalFileLinks(terminal, vi.fn());
    let links: ProvidedLink[] | undefined;

    provider().provideLinks(1, (provided) => {
      links = provided;
    });

    expect(links![0]!.range).toEqual({
      start: { x: 9, y: 1 },
      end: { x: text.length, y: 1 },
    });
  });
});

describe('terminal web links', () => {
  it('opens a valid web URL directly so Electron can hand it to the system browser', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    openTerminalWebLink(
      { preventDefault, stopPropagation } as unknown as MouseEvent,
      'https://google.com',
    );

    expect(open).toHaveBeenCalledWith('https://google.com/', '_blank', 'noopener');
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it('ignores malformed and non-web URLs', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as MouseEvent;

    openTerminalWebLink(event, 'file:///etc/passwd');
    openTerminalWebLink(event, 'not a URL');

    expect(open).not.toHaveBeenCalled();
  });
});

describe('terminal file path resolution', () => {
  it('normalizes absolute and current-directory-relative paths', () => {
    expect(resolveTerminalFilePath('/srv/app/../config.toml', '/ignored')).toBe('/srv/config.toml');
    expect(resolveTerminalFilePath('./src/../README.md', '/srv/app')).toBe('/srv/app/README.md');
    expect(resolveTerminalFilePath('../../etc/hosts', '/srv/app')).toBe('/etc/hosts');
  });

  it('resolves the current user home only when SFTP supplied it', () => {
    expect(resolveTerminalFilePath('~/.ssh/config', '/srv/app')).toBeUndefined();
    expect(resolveTerminalFilePath('~/.ssh/config', '/srv/app', '/home/alice')).toBe(
      '/home/alice/.ssh/config',
    );
    expect(resolveTerminalFilePath('~bob/.ssh/config', '/srv/app', '/home/alice')).toBeUndefined();
  });

  it('requires an absolute shell working directory for relative paths', () => {
    expect(resolveTerminalFilePath('src/main.ts')).toBeUndefined();
    expect(resolveTerminalFilePath('src/main.ts', '.')).toBeUndefined();
  });

  it('normalizes Windows drive-letter and UNC paths for local terminals', () => {
    expect(
      resolveTerminalFilePath(String.raw`C:\Users\me\..\config.toml`, undefined, undefined, 'local'),
    ).toBe(String.raw`C:\Users\config.toml`);
    expect(
      resolveTerminalFilePath('src/main.ts', String.raw`C:\Users\me`, undefined, 'local'),
    ).toBe(String.raw`C:\Users\me\src\main.ts`);
    expect(
      resolveTerminalFilePath(String.raw`\\server\share\dir\..\file.txt`, undefined, undefined, 'local'),
    ).toBe(String.raw`\\server\share\file.txt`);
    expect(
      resolveTerminalFilePath('C:/Users/me/file.txt', '/srv/app'),
    ).toBeUndefined();
  });
});

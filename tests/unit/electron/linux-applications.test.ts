import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  desktopApplicationFromText,
  desktopLocaleKeys,
  expandExec,
  LinuxApplicationCatalog,
  mimeTypeAncestors,
  mimeTypeForFileName,
  parseIconThemeIndex,
  parseMimeAppsList,
  parseMimeGlobs,
  parseMimePairs,
  rankApplications,
  splitExec,
  type DesktopApplication,
} from '../../../electron/src/linux-applications.js';

const entry = (lines: string[]) => ['[Desktop Entry]', ...lines].join('\n');

function application(id: string, name: string, mimeTypes: string[] = [], hidden = false): DesktopApplication {
  return { id, file: `/usr/share/applications/${id}`, name, exec: name.toLowerCase(), mimeTypes, ...(hidden ? { hidden } : {}) };
}

describe('desktop entries', () => {
  it('derives the locale keys a Desktop Entry may be translated under', () => {
    expect(desktopLocaleKeys('de_DE.UTF-8@euro')).toEqual(['de_DE@euro', 'de_DE', 'de@euro', 'de']);
    expect(desktopLocaleKeys('fr_FR.UTF-8')).toEqual(['fr_FR', 'fr']);
    expect(desktopLocaleKeys('C.UTF-8')).toEqual([]);
    expect(desktopLocaleKeys('POSIX')).toEqual([]);
    expect(desktopLocaleKeys(undefined)).toEqual([]);
  });

  it('reads a program with its translated name, icon and file types', () => {
    const text = [
      '# comment',
      '[Desktop Entry]',
      'Type=Application',
      'Name=Image Viewer',
      'Name[de]=Bildbetrachter',
      'Exec=eog %U',
      'Icon=org.gnome.eog',
      'MimeType=image/png;image/jpeg;',
      '[Desktop Action new-window]',
      'Name=New Window',
      'Exec=eog --new-window',
    ].join('\n');

    expect(
      desktopApplicationFromText(text, 'org.gnome.eog.desktop', '/usr/share/applications/org.gnome.eog.desktop', {
        localeKeys: ['de_DE', 'de'],
      }),
    ).toEqual({
      id: 'org.gnome.eog.desktop',
      file: '/usr/share/applications/org.gnome.eog.desktop',
      name: 'Bildbetrachter',
      exec: 'eog %U',
      icon: 'org.gnome.eog',
      mimeTypes: ['image/png', 'image/jpeg'],
    });
  });

  it('skips entries that cannot open a file here', () => {
    const base = ['Type=Application', 'Name=Tool', 'Exec=tool %f'];
    const parse = (lines: string[], desktops: string[] = ['ubuntu', 'GNOME']) =>
      desktopApplicationFromText(entry(lines), 'tool.desktop', '/tool.desktop', { currentDesktops: desktops });

    expect(parse(base)).toBeDefined();
    expect(parse(['Type=Link', 'Name=Docs', 'URL=https://example.com'])).toBeUndefined();
    expect(parse([...base, 'Hidden=true'])).toBeUndefined();
    expect(parse([...base, 'Terminal=true'])).toBeUndefined();
    expect(parse([...base, 'OnlyShowIn=KDE;'])).toBeUndefined();
    expect(parse([...base, 'OnlyShowIn=KDE;GNOME;'])).toBeDefined();
    expect(parse([...base, 'NotShowIn=GNOME;'])).toBeUndefined();
    expect(parse(['Type=Application', 'Name=Tool'])).toBeUndefined();
  });

  it('keeps NoDisplay entries, marked hidden, for explicit associations', () => {
    const parsed = desktopApplicationFromText(
      entry(['Type=Application', 'Name=Chrome', 'Exec=chrome %U', 'NoDisplay=true']),
      'google-chrome.desktop',
      '/google-chrome.desktop',
    );
    expect(parsed?.hidden).toBe(true);
  });
});

describe('Exec lines', () => {
  it('splits quoted arguments and their escapes', () => {
    expect(splitExec('sh -c "echo \\"a b\\" \\$HOME" plain\\ arg')).toEqual([
      'sh',
      '-c',
      'echo "a b" $HOME',
      'plain arg',
    ]);
    expect(splitExec('"/opt/My App/app"  %f')).toEqual(['/opt/My App/app', '%f']);
    expect(splitExec('broken "quote')).toBeUndefined();
    expect(splitExec('   ')).toBeUndefined();
  });

  it('expands file, URL and metadata field codes', () => {
    const app = { exec: '', name: 'Viewer', icon: 'viewer', file: '/apps/viewer.desktop' };
    const target = '/tmp/x y/plan.drawio';
    const expand = (exec: string) => expandExec({ ...app, exec }, target);

    expect(expand('/opt/drawio/drawio %U')).toEqual(['/opt/drawio/drawio', 'file:///tmp/x%20y/plan.drawio']);
    expect(expand('viewer %F')).toEqual(['viewer', target]);
    expect(expand('viewer %i --title=%c %f')).toEqual(['viewer', '--icon', 'viewer', '--title=Viewer', target]);
    expect(expand('viewer --desktop-file=%k --file=%f')).toEqual([
      'viewer',
      '--desktop-file=/apps/viewer.desktop',
      `--file=${target}`,
    ]);
    expect(expand('viewer --progress=100%% %d %m %f')).toEqual(['viewer', '--progress=100%', target]);
    expect(
      expand('/usr/bin/flatpak run --command=drawio --file-forwarding com.jgraph.drawio @@ %f @@'),
    ).toEqual([
      '/usr/bin/flatpak',
      'run',
      '--command=drawio',
      '--file-forwarding',
      'com.jgraph.drawio',
      '@@',
      target,
      '@@',
    ]);
  });

  it('appends the file for programs that take no file field code', () => {
    expect(
      expandExec({ exec: 'env FOO=1 /snap/bin/editor', name: 'Editor', file: '/e.desktop' }, '/tmp/a.txt'),
    ).toEqual(['env', 'FOO=1', '/snap/bin/editor', '/tmp/a.txt']);
  });
});

describe('file types', () => {
  const globs = parseMimeGlobs(
    [
      '# generated',
      '80:text/html:*.html',
      '50:application/vnd.jgraph.mxfile:*.drawio',
      '50:text/x-c++src:*.C:cs',
      '50:text/x-csrc:*.c',
      '50:application/x-compressed-tar:*.tar.gz',
      '50:application/gzip:*.gz',
      '50:text/x-readme:README*',
      '50:text/x-makefile:makefile',
      '50:image/x-portable-anymap:*.p[bgp]m',
      '10:text/plain:*.txt',
      '50:application/x-font:__NOGLOBS__',
    ].join('\n'),
  );

  it('matches by weight, specificity and case rules', () => {
    expect(mimeTypeForFileName('Index.HTML', globs)).toBe('text/html');
    expect(mimeTypeForFileName('plan.drawio', globs)).toBe('application/vnd.jgraph.mxfile');
    expect(mimeTypeForFileName('main.c', globs)).toBe('text/x-csrc');
    expect(mimeTypeForFileName('main.C', globs)).toBe('text/x-c++src');
    expect(mimeTypeForFileName('backup.tar.gz', globs)).toBe('application/x-compressed-tar');
    expect(mimeTypeForFileName('log.gz', globs)).toBe('application/gzip');
    expect(mimeTypeForFileName('README.md', globs)).toBe('text/x-readme');
    expect(mimeTypeForFileName('Makefile', globs)).toBe('text/x-makefile');
    expect(mimeTypeForFileName('photo.pgm', globs)).toBe('image/x-portable-anymap');
    expect(mimeTypeForFileName('photo.pxm', globs)).toBeUndefined();
    expect(mimeTypeForFileName('unknown', globs)).toBeUndefined();
  });

  it('walks subclasses up to the types a text editor declares', () => {
    const subclasses = parseMimePairs(
      ['application/yaml text/plain', 'image/svg+xml application/xml', 'application/xml text/plain'].join('\n'),
    );
    expect(mimeTypeAncestors('image/svg+xml', subclasses)).toEqual(['application/xml', 'text/plain']);
    expect(mimeTypeAncestors('text/x-python', subclasses)).toEqual(['text/plain']);
    expect(mimeTypeAncestors('text/plain', subclasses)).toEqual([]);
  });
});

describe('ranking programs for a file', () => {
  const programs = [
    application('eog.desktop', 'Image Viewer', ['image/png']),
    application('gimp.desktop', 'GIMP', ['image/png', 'image/jpeg']),
    application('editor.desktop', 'Text Editor', ['text/plain']),
    application('chrome-hidden.desktop', 'Google Chrome', [], true),
    application('okular-png.desktop', 'Okular', ['image/png'], true),
    application('calculator.desktop', 'Calculator'),
    application('pinta.desktop', 'Pinta', ['image/png']),
  ];
  const subclasses = parseMimePairs('image/svg+xml text/plain');
  const aliases = parseMimePairs('image/x-png image/png');

  it('puts the default first, then programs for the type, then the rest', () => {
    const lists = [
      parseMimeAppsList(
        [
          '[Default Applications]',
          'image/png=missing.desktop;gimp.desktop;',
          '[Removed Associations]',
          'image/png=pinta.desktop;',
        ].join('\n'),
      ),
    ];
    const ranked = rankApplications(programs, 'image/x-png', subclasses, aliases, lists);
    expect(ranked.map(({ application, recommended, isDefault }) => [application.name, recommended, isDefault])).toEqual([
      ['GIMP', true, true],
      ['Image Viewer', true, false],
      ['Calculator', false, false],
      ['Pinta', false, false],
      ['Text Editor', false, false],
    ]);
  });

  it('recommends programs for broader types after those for the exact type', () => {
    const ranked = rankApplications(programs, 'image/svg+xml', subclasses, aliases, [
      parseMimeAppsList('[Added Associations]\nimage/svg+xml=gimp.desktop;'),
    ]);
    expect(ranked.filter((choice) => choice.recommended).map((choice) => choice.application.name)).toEqual([
      'GIMP',
      'Text Editor',
    ]);
  });

  it('offers a NoDisplay program only where an association names it', () => {
    const lists = [parseMimeAppsList('[Default Applications]\ntext/html=chrome-hidden.desktop')];
    const forHtml = rankApplications(programs, 'text/html', subclasses, aliases, lists);
    expect(forHtml[0]).toMatchObject({ application: { name: 'Google Chrome' }, isDefault: true });
    expect(forHtml.some((choice) => choice.application.name === 'Okular')).toBe(false);

    const forPng = rankApplications(programs, 'image/png', subclasses, aliases, lists);
    expect(forPng.some((choice) => choice.application.hidden)).toBe(false);
  });

  it('lists everything alphabetically when the type is unknown', () => {
    const ranked = rankApplications(programs, undefined, subclasses, aliases, []);
    expect(ranked.every((choice) => !choice.recommended && !choice.isDefault)).toBe(true);
    expect(ranked.map((choice) => choice.application.name)).toEqual([
      'Calculator',
      'GIMP',
      'Image Viewer',
      'Pinta',
      'Text Editor',
    ]);
  });
});

describe('icon themes', () => {
  it('keeps program icon folders, closest to 48px first', () => {
    const index = parseIconThemeIndex(
      [
        '[Icon Theme]',
        'Name=Yaru',
        'Inherits=Humanity, hicolor',
        'Directories=16x16/apps,48x48/apps,256x256/apps,scalable/apps,48x48/actions,misc',
        'ScaledDirectories=24x24@2x/apps',
        '[16x16/apps]',
        'Size=16',
        'Context=Applications',
        '[48x48/apps]',
        'Size=48',
        'Context=Applications',
        '[256x256/apps]',
        'Size=256',
        'Context=Applications',
        '[scalable/apps]',
        'Size=128',
        'Type=Scalable',
        'Context=Applications',
        '[48x48/actions]',
        'Size=48',
        'Context=Actions',
        '[misc]',
        'Size=32',
        '[24x24@2x/apps]',
        'Size=24',
        'Scale=2',
        'Context=Applications',
      ].join('\n'),
    );
    expect(index.inherits).toEqual(['Humanity', 'hicolor']);
    expect(index.directories.map((directory) => directory.path)).toEqual([
      '48x48/apps',
      '24x24@2x/apps',
      'scalable/apps',
      '256x256/apps',
      '16x16/apps',
    ]);
  });
});

describe('the installed program catalog', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function fixture() {
    root = await mkdtemp(path.join(tmpdir(), 'muxus-apps-'));
    const home = path.join(root, 'home');
    const dataHome = path.join(home, '.local', 'share');
    const system = path.join(root, 'usr', 'share');
    const bin = path.join(root, 'bin');
    const write = async (file: string, text: string) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    };
    for (const program of ['viewer', 'drawio', 'editor']) {
      await write(path.join(bin, program), '#!/bin/sh\n');
      await chmod(path.join(bin, program), 0o755);
    }
    await write(
      path.join(system, 'applications', 'viewer.desktop'),
      entry(['Type=Application', 'Name=Viewer', 'Exec=viewer %U', 'Icon=viewer', 'MimeType=image/png;']),
    );
    await write(
      path.join(system, 'applications', 'kde', 'drawio.desktop'),
      entry(['Type=Application', 'Name=drawio', 'Exec=drawio %U', 'MimeType=application/vnd.jgraph.mxfile;']),
    );
    await write(
      path.join(system, 'applications', 'gone.desktop'),
      entry(['Type=Application', 'Name=Gone', 'Exec=gone %f', 'MimeType=image/png;']),
    );
    await write(
      path.join(system, 'applications', 'tryexec.desktop'),
      entry(['Type=Application', 'Name=Partial', 'Exec=viewer %f', 'TryExec=missing-helper']),
    );
    await write(
      path.join(system, 'applications', 'editor.desktop'),
      entry(['Type=Application', 'Name=Editor', 'Exec=editor %f', 'MimeType=text/plain;']),
    );
    // The user deleted the system's editor entry by shadowing it.
    await write(
      path.join(dataHome, 'applications', 'editor.desktop'),
      entry(['Type=Application', 'Name=Editor', 'Exec=editor %f', 'Hidden=true']),
    );
    await write(
      path.join(system, 'mime', 'globs2'),
      '50:image/png:*.png\n50:application/vnd.jgraph.mxfile:*.drawio\n',
    );
    await write(
      path.join(system, 'icons', 'hicolor', 'index.theme'),
      ['[Icon Theme]', 'Directories=48x48/apps', '[48x48/apps]', 'Size=48', 'Context=Applications'].join('\n'),
    );
    await write(path.join(system, 'icons', 'hicolor', '48x48', 'apps', 'viewer.png'), 'png');
    return new LinuxApplicationCatalog(
      { PATH: bin, XDG_DATA_DIRS: system, XDG_CONFIG_HOME: path.join(home, '.config') },
      home,
      { iconTheme: async () => undefined },
    );
  }

  it('lists installed programs only, ranked for the file', async () => {
    const catalog = await fixture();
    const { mimeType, choices } = await catalog.applicationsFor('diagram.drawio');
    expect(mimeType).toBe('application/vnd.jgraph.mxfile');
    expect(choices.map((choice) => [choice.application.id, choice.recommended])).toEqual([
      ['kde-drawio.desktop', true],
      ['viewer.desktop', false],
    ]);
    expect(await catalog.find('gone.desktop')).toBeUndefined();
    expect(await catalog.find('editor.desktop')).toBeUndefined();
  });

  it("finds a program's icon in the theme", async () => {
    const catalog = await fixture();
    const viewer = await catalog.find('viewer.desktop');
    expect(await catalog.iconFile(viewer!)).toBe(
      path.join(root!, 'usr', 'share', 'icons', 'hicolor', '48x48', 'apps', 'viewer.png'),
    );
    expect(await catalog.iconFile((await catalog.find('kde-drawio.desktop'))!)).toBeUndefined();
  });
});

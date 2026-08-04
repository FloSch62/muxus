// Screenshot capture for the Muxus docs.
//
//   node hack/capture.mjs               # light theme, every shot
//   THEME=dark node hack/capture.mjs    # dark variants, written as <name>-dark.png
//   node hack/capture.mjs sftp          # only shots whose name contains "sftp"
//
// It boots the sandbox from hack/demo-env.mjs first, so every host, folder,
// tunnel and file on screen is invented. Set CHROME to override the browser.
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startDemoEnv } from './demo-env.mjs';

const ONLY = process.argv[2];
const THEME = process.env.THEME === 'dark' ? 'dark' : 'light';
const SUFFIX = THEME === 'dark' ? '-dark' : '';
const OUT = 'docs/assets/screenshots';
const VIEW = { width: 1420, height: 880 };
const SCALE = 2;
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';

const env = await startDemoEnv();
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
await fs.mkdir(OUT, { recursive: true });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Preferences worth having in every shot, seeded before the app boots. */
const BASE_PREFS = {
  themeMode: THEME,
  monoFontSize: 14,
  fontFamily: 'JetBrains Mono',
  lineHeight: 1.1,
  lightTerminalScheme: 'github-light',
  darkTerminalScheme: 'vscode-dark',
  sidebarWidth: 250,
  commandButtons: [],
  keywordHighlights: [],
  sidebarFolderStyles: {
    'folder:production': { color: '#ef4444', icon: 'cloud' },
    'folder:production/web': { color: '#3b82f6', icon: 'server' },
    'folder:production/data': { color: '#f97316', icon: 'storage' },
    'folder:lab': { color: '#22c55e', icon: 'lab' },
    'folder:lab/fabric': { color: '#a855f7', icon: 'lan' },
  },
};

/** A fresh window. Workspaces are cleared first so tabs never leak between shots. */
async function open(prefs = {}, seed) {
  // Twice: the window that just closed flushes its layout with a keepalive
  // request that can land after the first sweep.
  await purgeWorkspaces();
  await wait(500);
  await purgeWorkspaces();
  // Anything a shot needs in the database has to land after the sweep and
  // before the window reads its catalog.
  if (seed) await seed();

  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: SCALE,
    colorScheme: THEME,
  });
  const page = await context.newPage();
  // Every window restores the last layout it saw, and a window that closes with
  // live tabs flushes one on its way out. Answer both restore lookups with
  // "nothing", so each shot starts from the same empty canvas.
  await page.route('**/api/workspaces/latest', (route) => route.fulfill({ json: { workspace: null } }));
  await page.route('**/api/workspaces/startup', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { workspace: null } })
      : route.continue(),
  );
  const state = JSON.stringify({ state: { ...BASE_PREFS, ...prefs }, version: 9 });
  await page.addInitScript((value) => localStorage.setItem('muxus-prefs', value), state);
  await page.goto(`${env.url}/?token=${env.token}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[aria-label="Add host"]');
  await wait(900);
  page.close_ = () => context.close();
  return page;
}

async function purgeWorkspaces() {
  const { workspaces } = await api('/api/workspaces');
  for (const workspace of workspaces) await api(`/api/workspaces/${workspace.id}`, 'DELETE');
}

function api(route, method = 'GET', body) {
  return fetch(`${env.url}${route}`, {
    method,
    headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((res) => (res.status === 204 ? null : res.json()));
}

/**
 * Screenshot. The pointer is parked in dead space first, because the button you
 * just clicked would otherwise be wearing its tooltip; pass `keepPointer` for
 * the shots that are *about* a hover.
 */
async function shot(page, name, { keepPointer = false, ...options } = {}) {
  if (!keepPointer) {
    await page.mouse.move(VIEW.width / 2, VIEW.height - 60);
    await wait(700);
  }
  const path = `${OUT}/${name}${SUFFIX}.png`;
  await page.screenshot({ path, ...options });
  // A window that is still painting yields a blank page, and a screenshot of
  // nothing succeeds just as quietly as a good one. Blank PNGs compress to a
  // few KiB, so retake once and fail loudly rather than ship an empty figure.
  if (await isBlank(path)) {
    await page.waitForSelector('[aria-label="Add host"]', { state: 'attached' });
    await wait(2000);
    await page.screenshot({ path, ...options });
    if (await isBlank(path)) throw new Error(`${name}: captured a blank window`);
  }
}

const MIN_SHOT_BYTES = 40 * 1024;

async function isBlank(path) {
  const { size } = await fs.stat(path);
  return size < MIN_SHOT_BYTES;
}

/** Click a host in the sidebar and wait until its shell has drawn a prompt. */
async function connect(page, alias) {
  await page.locator(`[role="treeitem"][aria-label="${alias}"]`).first().click();
  await page.waitForSelector('.xterm-rows', { timeout: 25_000 }).catch(async (err) => {
    await page.screenshot({ path: `${OUT}/../debug-${alias}${SUFFIX}.png` });
    throw new Error(`${err.message.split('\n')[0]} — body: ${(await page.locator('body').innerText()).slice(0, 200).replace(/\n/g, ' | ')}`);
  });
  await page.waitForFunction(
    () => /[$#] $|\$ $/.test(document.querySelector('.xterm-rows')?.innerText ?? ''),
    undefined,
    { timeout: 20_000 },
  ).catch(() => undefined);
  await wait(700);
}

/** Settings sections remember their scroll position; start every shot at the top. */
async function scrollDialogTop(page) {
  // Every scrollable box, not just the dialog's: several portals render their
  // own [role="dialog"], and the first one is not necessarily the open one.
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('*')) {
      if (element.scrollHeight > element.clientHeight + 8) element.scrollTop = 0;
    }
  });
  await wait(300);
}

/** Type into the focused terminal at a human-ish speed and let it answer. */
async function run(page, command, settle = 900) {
  await page.locator('.xterm-screen').last().click();
  await page.keyboard.type(command, { delay: 12 });
  await page.keyboard.press('Enter');
  await wait(settle);
}

const shots = [];
const add = (name, fn) => shots.push({ name, fn });

// ---------------------------------------------------------------------------

add('overview', async () => {
  const page = await open();
  await connect(page, 'web-01');
  await run(page, 'status');
  await run(page, 'll conf/');
  await shot(page, 'overview');
  await page.close_();
});

add('sidebar', async () => {
  const page = await open({ sidebarWidth: 300 });
  await connect(page, 'web-01');
  await run(page, 'status', 700);
  // The hover card is the point of this shot, so the pointer stays put.
  await page.locator('[role="treeitem"][aria-label*="db-primary"]').first().hover();
  await wait(1200);
  await shot(page, 'sidebar', {
    keepPointer: true,
    clip: { x: 0, y: 0, width: 620, height: VIEW.height },
  });
  await page.close_();
});

add('quick-connect', async () => {
  const page = await open({ sidebarWidth: 300 });
  await page.getByPlaceholder('Search or user@host ⏎').fill('ops@staging-07:2222');
  await wait(700);
  await shot(page, 'quick-connect', { clip: { x: 0, y: 0, width: 470, height: 460 } });
  await page.close_();
});

add('host-editor', async () => {
  const page = await open();
  await page.locator('[role="treeitem"][aria-label*="db-primary"]').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit host' }).first().click();
  await wait(900);
  await shot(page, 'host-editor');
  await page.close_();
});

add('host-editor-route', async () => {
  const page = await open();
  await page.locator('[role="treeitem"][aria-label*="db-primary"]').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit host' }).first().click();
  await wait(600);
  await page.getByRole('tab', { name: 'Connection route' }).click();
  await wait(600);
  await shot(page, 'host-editor-route');
  await page.close_();
});

add('host-editor-forwards', async () => {
  const page = await open();
  await page.locator('[role="treeitem"][aria-label*="db-primary"]').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit host' }).first().click();
  await wait(600);
  await page.getByRole('tab', { name: 'Port forwarding' }).click();
  await wait(600);
  await shot(page, 'host-editor-forwards');
  await page.close_();
});

add('host-editor-preview', async () => {
  const page = await open();
  await page.locator('[role="treeitem"][aria-label*="db-primary"]').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit host' }).first().click();
  await wait(600);
  await page.getByRole('tab', { name: 'Advanced' }).click();
  await wait(1200);
  await shot(page, 'host-editor-preview');
  await page.close_();
});

add('serial-editor', async () => {
  const page = await open();
  await page.locator('[role="treeitem"][aria-label="lab-console"]').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit host' }).first().click();
  await wait(700);
  // The line settings are what a serial host is actually about.
  await page.getByRole('tab', { name: 'Line settings' }).click();
  await wait(700);
  await shot(page, 'serial-editor');
  await page.close_();
});

add('telnet-editor', async () => {
  const page = await open();
  await page.locator('[role="treeitem"][aria-label*="core-switch"]').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit host' }).first().click();
  await wait(900);
  await shot(page, 'telnet-editor');
  await page.close_();
});

add('panes', async () => {
  const page = await open();
  await connect(page, 'web-01');
  await run(page, 'status', 600);
  await page.keyboard.press('Control+Shift+ArrowRight');
  await wait(2500);
  await run(page, 'tailaccess', 800);
  await page.keyboard.press('Control+Shift+ArrowDown');
  await wait(2500);
  await run(page, 'll', 800);
  await shot(page, 'panes');
  await page.close_();
});

add('kitty-graphics', async () => {
  const page = await open();
  await connect(page, 'web-01');
  await run(page, 'plot', 2500);
  await shot(page, 'kitty-graphics');
  await page.close_();
});

add('quick-launcher', async () => {
  const page = await open();
  await connect(page, 'web-01');
  await page.keyboard.press('Control+k');
  await wait(600);
  await page.keyboard.type('web', { delay: 60 });
  await wait(900);
  await shot(page, 'quick-launcher');
  await page.close_();
});

add('sftp', async () => {
  const page = await open();
  await connect(page, 'web-01');
  await page.locator('[aria-label="Toggle file browser"]').click();
  await wait(2000);
  await shot(page, 'sftp');
  await page.close_();
});

add('remote-editor', async () => {
  const page = await open();
  await connect(page, 'web-01');
  await page.locator('[aria-label="Toggle file browser"]').click();
  await wait(2000);
  await page.getByText('docker-compose.yml').first().dblclick();
  await wait(3500);
  await shot(page, 'remote-editor');
  await page.close_();
});

add('tunnels', async () => {
  const page = await open();
  await connect(page, 'web-01');
  await page.locator('[aria-label="Toggle forwarding panel"]').click();
  await wait(1500);
  await shot(page, 'tunnels');
  await page.close_();
});

add('workspaces', async () => {
  // A believable catalog: the auto-saved "Workspace 1" the other shots leave
  // behind says nothing about what workspaces are for.
  const page = await open({}, async () => {
    for (const [name, hosts] of [
      ['Morning check', ['web-01', 'web-02', 'cache-01']],
      ['Fabric lab', ['lab-leaf-01', 'lab-spine-01']],
      ['Incident 4821', ['db-01', 'bastion']],
    ]) {
      await api('/api/workspaces', 'PUT', { name, layout: paneLayout(name, hosts), multiExecGroups: [] });
    }
  });
  // No session is opened here on purpose: an idle window never auto-saves, so
  // the list stays the three workspaces this shot is about.
  await page.getByRole('button', { name: /Workspace|Unsaved/ }).first().click();
  await wait(1200);
  await shot(page, 'workspaces');
  await page.close_();
});

/** One pane holding a tab per host — enough for a saved-workspace record. */
function paneLayout(name, hosts) {
  const slug = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-');
  const tabs = hosts.map((target, index) => ({
    id: `${slug}-tab-${index}`,
    kind: 'terminal',
    title: target,
    profile: { kind: 'ssh', target },
    offerReconnect: true,
  }));
  return {
    version: 1,
    root: { id: `${slug}-pane`, type: 'pane', tabs, activeTabId: tabs[0].id },
    activePaneId: `${slug}-pane`,
  };
}

add('settings', async () => {
  const page = await open();
  await page.locator('[aria-label="Settings"]').click();
  await wait(1200);
  await scrollDialogTop(page);
  await shot(page, 'settings');
  await page.close_();
});

add('settings-terminal', async () => {
  const page = await open();
  await page.locator('[aria-label="Settings"]').click();
  await wait(900);
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await wait(900);
  await scrollDialogTop(page);
  await shot(page, 'settings-terminal');
  await page.close_();
});

add('settings-highlighting', async () => {
  const page = await open({
    keywordHighlights: [
      { id: 'r1', keyword: 'ERROR', foreground: '#ffffff', background: '#dc2626', caseSensitive: true, wholeWord: true },
      { id: 'r2', keyword: 'WARN', foreground: '#1c1c21', background: '#f6c344', caseSensitive: true, wholeWord: true },
      { id: 'r3', keyword: 'timeout', foreground: '#ffffff', background: '#2563eb', caseSensitive: false, wholeWord: false },
    ],
  });
  await page.locator('[aria-label="Settings"]').click();
  await wait(900);
  await page.getByRole('button', { name: 'Highlighting', exact: true }).click();
  await wait(900);
  await scrollDialogTop(page);
  await shot(page, 'settings-highlighting');
  await page.close_();
});

add('settings-logging', async () => {
  const page = await open();
  await page.locator('[aria-label="Settings"]').click();
  await wait(900);
  await page.getByRole('button', { name: 'Session logging', exact: true }).click();
  await wait(1200);
  await scrollDialogTop(page);
  await shot(page, 'settings-logging');
  await page.close_();
});

add('tab-menu', async () => {
  const page = await open();
  await connect(page, 'web-01');
  await run(page, 'status', 700);
  await page.locator('[aria-label="Terminal tabs"] [role="tab"]').first().click({ button: 'right' });
  await wait(800);
  await shot(page, 'tab-menu', { keepPointer: true });
  await page.close_();
});

add('multi-exec', async () => {
  const page = await open();
  await connect(page, 'web-01');
  await page.keyboard.press('Control+Shift+ArrowRight');
  await wait(3000);
  await page.locator('[aria-label="Configure multi-execution"]').click();
  await wait(900);
  // Select both sessions so the popover shows the active state and the
  // save-as-group field rather than an empty checklist.
  await page.getByRole('button', { name: 'All live' }).click();
  await wait(900);
  await shot(page, 'multi-exec', { keepPointer: true });
  await page.close_();
});

add('shortcuts', async () => {
  const page = await open();
  await page.locator('[aria-label="Keyboard shortcuts"]').click();
  await wait(1200);
  await shot(page, 'shortcuts');
  await page.close_();
});

add('command-buttons', async () => {
  const page = await open({
    commandButtons: [
      { id: 'a', label: 'status', command: 'status', sendEnter: true },
      { id: 'b', label: 'tail access log', command: 'tailaccess', sendEnter: true },
      { id: 'c', label: 'disk', command: 'df -h', sendEnter: true },
      { id: 'd', label: 'restart edge', command: 'sudo systemctl restart edge', sendEnter: false },
    ],
  });
  await connect(page, 'web-01');
  await run(page, 'status', 700);
  await shot(page, 'command-buttons');
  await page.close_();
});

add('terminal-search', async () => {
  const page = await open();
  await connect(page, 'web-01');
  await run(page, 'tailaccess', 800);
  await page.keyboard.press('Control+Shift+F');
  await wait(500);
  await page.keyboard.type('healthz', { delay: 40 });
  await wait(900);
  await shot(page, 'terminal-search');
  await page.close_();
});

add('host-key', async () => {
  // Forget the sandbox key so trust-on-first-use has something to ask about.
  await fs.writeFile(`${env.home}/.ssh/known_hosts`, '');
  const page = await open();
  await page.locator('[role="treeitem"][aria-label="build-01"]').first().click();
  await wait(2500);
  await shot(page, 'host-key');
  await page.close_();
});

add('auth-prompt', async () => {
  const page = await open();
  await page.locator('[role="treeitem"][aria-label="bastion"]').first().click();
  await wait(2500);
  // An earlier shot may have forgotten the sandbox key; get past that dialog so
  // this one shows the 2FA prompt it is about.
  const trust = page.getByRole('button', { name: 'Trust host' });
  if (await trust.isVisible().catch(() => false)) {
    await trust.click();
    await wait(2500);
  }
  await shot(page, 'auth-prompt');
  await page.close_();
});

add('launch-group', async () => {
  const page = await open();
  await page.locator('[role="treeitem"][aria-label="Production"]').first().click({ button: 'right' });
  await wait(500);
  await page.getByRole('menuitem', { name: /Launch/ }).first().click();
  await wait(900);
  await shot(page, 'launch-group');
  await page.close_();
});

add('history', async () => {
  const page = await open();
  // Give the list a session with something worth reading in it.
  await connect(page, 'web-01');
  await run(page, 'status', 700);
  await run(page, 'tailaccess', 900);
  await page.locator('[aria-label="Session history"]').click();
  await wait(2000);
  await page.getByText(/^web-01$/).nth(1).click().catch(() => undefined);
  await wait(1500);
  await shot(page, 'history');
  await page.close_();
});

// ---------------------------------------------------------------------------

let failures = 0;
for (const entry of shots) {
  if (ONLY && !entry.name.includes(ONLY)) continue;
  process.stdout.write(`${THEME}: ${entry.name} … `);
  try {
    await entry.fn();
    console.log('ok');
  } catch (err) {
    failures++;
    console.log(`FAILED — ${err.message.split('\n')[0]}`);
  }
}

await browser.close();
await env.stop();
process.exit(failures ? 1 : 0);

import { beforeEach, describe, expect, it } from 'vitest';
import { usePrefsStore } from '../../../client/src/state/prefs.js';
import { useUiStore } from '../../../client/src/state/ui.js';

const ui = () => useUiStore.getState();

beforeEach(() => {
  usePrefsStore.setState({ sidebarCollapsed: false });
  useUiStore.setState({
    sidebarView: 'hosts',
    sidebarPanelOpen: true,
    forwardingOpen: false,
    environmentsPanel: false,
  });
});

describe('the sidebar panel and its views', () => {
  it('opens a view and closes the panel when the view in front is clicked again', () => {
    ui().toggleSidebarView('files');
    expect(ui()).toMatchObject({ sidebarView: 'files', sidebarPanelOpen: true });
    ui().toggleSidebarView('files');
    expect(ui()).toMatchObject({ sidebarView: 'files', sidebarPanelOpen: false });
    // The rail remembers the view: the same click brings it back.
    ui().toggleSidebarView('files');
    expect(ui()).toMatchObject({ sidebarView: 'files', sidebarPanelOpen: true });
  });

  it('switches straight to another view without closing in between', () => {
    ui().toggleSidebarView('forwarding');
    ui().toggleSidebarView('environments');
    expect(ui()).toMatchObject({
      sidebarView: 'environments',
      sidebarPanelOpen: true,
      forwardingOpen: false,
      environmentsPanel: {},
    });
  });

  it('keeps forwardingOpen in step with what is on screen', () => {
    ui().setForwardingOpen(true);
    expect(ui()).toMatchObject({ sidebarView: 'forwarding', forwardingOpen: true });
    ui().setSidebarPanelOpen(false);
    expect(ui().forwardingOpen).toBe(false);
    ui().setSidebarPanelOpen(true);
    expect(ui()).toMatchObject({ sidebarView: 'forwarding', forwardingOpen: true });
  });

  it('brings the hosts back when a view is put away from its own control', () => {
    ui().setForwardingOpen(true);
    ui().setForwardingOpen(false);
    expect(ui()).toMatchObject({ sidebarView: 'hosts', sidebarPanelOpen: true, forwardingOpen: false });

    ui().setEnvironmentsPanel({ hostKey: 'ssh:web-01' });
    expect(ui()).toMatchObject({ sidebarView: 'environments', environmentsPanel: { hostKey: 'ssh:web-01' } });
    ui().setEnvironmentsPanel(false);
    expect(ui()).toMatchObject({ sidebarView: 'hosts', environmentsPanel: false });
  });

  it('leaves another view alone when a view that is not in front is put away', () => {
    ui().setSidebarView('files');
    ui().setForwardingOpen(false);
    ui().setEnvironmentsPanel(false);
    expect(ui()).toMatchObject({ sidebarView: 'files', sidebarPanelOpen: true });
  });

  it('keeps the host the containers view is narrowed to while the panel closes and reopens', () => {
    ui().setEnvironmentsPanel({ hostKey: 'ssh:web-01' });
    ui().setEnvironmentsPanel({});
    expect(ui().environmentsPanel).toEqual({});
    ui().setEnvironmentsPanel({ hostKey: 'ssh:db-01' });
    ui().toggleSidebarView('environments');
    expect(ui()).toMatchObject({ sidebarPanelOpen: false, environmentsPanel: false });
  });

  it('brings a hidden sidebar back when a view is asked for', () => {
    usePrefsStore.setState({ sidebarCollapsed: true });
    ui().setForwardingOpen(true);
    expect(usePrefsStore.getState().sidebarCollapsed).toBe(false);

    usePrefsStore.setState({ sidebarCollapsed: true });
    ui().setSidebarPanelOpen(false);
    expect(usePrefsStore.getState().sidebarCollapsed).toBe(true);
  });
});

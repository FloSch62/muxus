import { describe, expect, it, vi } from 'vitest';

// Stand-ins for the WebAssembly input types, recording what reaches the session.
vi.mock('../../../client/src/remote-desktop/ironrdp.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  DeviceEvent: {
    keyPressed: (code: number) => `down ${code.toString(16)}`,
    keyReleased: (code: number) => `up ${code.toString(16)}`,
    wheelRotations: (vertical: boolean, amount: number) => `wheel ${vertical ? 'v' : 'h'} ${amount}`,
  },
  InputTransaction: class {
    readonly events: string[] = [];
    addEvent(event: string) {
      this.events.push(event);
    }
  },
}));

const { RdpConnection } = await import('../../../client/src/remote-desktop/rdp-client.js');

function connection() {
  const sent: string[] = [];
  const session = {
    applyInputs: (transaction: { events: string[] }) => sent.push(...transaction.events),
    synchronizeLockKeys: (scroll: boolean, num: boolean, caps: boolean) => sent.push(`sync ${+scroll}${+num}${+caps}`),
  };
  const Connection = RdpConnection as unknown as new (...args: unknown[]) => typeof RdpConnection.prototype;
  return { rdp: new Connection(session, {}, false), sent };
}

interface KeyState {
  shift?: boolean;
  alt?: boolean;
  altGraph?: boolean;
  caps?: boolean;
  repeat?: boolean;
}

function key(type: 'keydown' | 'keyup', code: string, state: KeyState = {}) {
  return {
    type,
    code,
    repeat: state.repeat ?? false,
    shiftKey: state.shift ?? false,
    ctrlKey: false,
    altKey: state.alt ?? false,
    metaKey: false,
    getModifierState: (modifier: string) =>
      (modifier === 'CapsLock' && (state.caps ?? false)) || (modifier === 'AltGraph' && (state.altGraph ?? false)),
  } as unknown as KeyboardEvent;
}

describe('RDP keyboard input', () => {
  it('keeps Shift held while typing', () => {
    const { rdp, sent } = connection();
    rdp.key(key('keydown', 'ShiftLeft', { shift: true }));
    rdp.key(key('keydown', 'KeyA', { shift: true }));
    rdp.key(key('keyup', 'KeyA', { shift: true }));
    rdp.key(key('keydown', 'KeyB', { shift: true }));
    // A synchronize event releases every key on Windows; only the first key may send one.
    expect(sent).toEqual(['sync 000', 'down 2a', 'down 1e', 'up 1e', 'down 30']);
  });

  it('presses held modifiers again after syncing a lock toggled elsewhere', () => {
    const { rdp, sent } = connection();
    rdp.key(key('keydown', 'ShiftLeft', { shift: true }));
    sent.length = 0;
    rdp.key(key('keydown', 'KeyA', { shift: true, caps: true }));
    expect(sent).toEqual(['sync 001', 'down 2a', 'down 1e']);
  });

  it('lets a lock key toggle the server without syncing first', () => {
    const { rdp, sent } = connection();
    rdp.key(key('keydown', 'KeyA'));
    sent.length = 0;
    rdp.key(key('keydown', 'CapsLock', { caps: true }));
    expect(sent).toEqual(['down 3a']);
  });

  it('ignores auto-repeat on lock keys and modifiers, but not on other keys', () => {
    const { rdp, sent } = connection();
    rdp.key(key('keydown', 'KeyA'));
    sent.length = 0;
    // IronRDP would send each repeat as release + press: another Caps Lock toggle.
    expect(rdp.key(key('keydown', 'CapsLock', { caps: true, repeat: true }))).toBe(true);
    rdp.key(key('keydown', 'ShiftLeft', { shift: true }));
    rdp.key(key('keydown', 'ShiftLeft', { shift: true, repeat: true }));
    rdp.key(key('keydown', 'KeyB', { shift: true, repeat: true }));
    expect(sent).toEqual(['down 2a', 'down 30']);
  });

  it('keeps AltGr held when the browser reports AltGraph instead of altKey', () => {
    const { rdp, sent } = connection();
    rdp.key(key('keydown', 'KeyA'));
    sent.length = 0;
    // Chrome on Linux: AltRight with getModifierState('AltGraph') and altKey false.
    rdp.key(key('keydown', 'AltRight', { altGraph: true }));
    rdp.key(key('keydown', 'KeyQ', { altGraph: true }));
    rdp.key(key('keyup', 'AltRight'));
    rdp.key(key('keydown', 'KeyQ'));
    expect(sent).toEqual(['down e038', 'down 10', 'up e038', 'down 10']);
  });

  it('presses AltGr itself when it was held before the desktop had focus', () => {
    const { rdp, sent } = connection();
    rdp.key(key('keydown', 'KeyQ', { altGraph: true }));
    rdp.key(key('keydown', 'KeyW', { alt: true }));
    expect(sent).toEqual(['sync 000', 'down e038', 'down 10', 'down 11']);
  });
});

describe('RDP wheel input', () => {
  vi.stubGlobal('WheelEvent', { DOM_DELTA_PIXEL: 0, DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 });
  const wheel = (deltaX: number, deltaY: number) => ({ deltaX, deltaY, deltaMode: 0 }) as WheelEvent;

  it('scrolls up for a negative deltaY and right for a positive deltaX', () => {
    const { rdp, sent } = connection();
    rdp.wheel(wheel(0, 100));
    rdp.wheel(wheel(40, 0));
    expect(sent).toEqual(['wheel v -100', 'wheel h 40']);
  });

  it('sends both axes of a diagonal trackpad scroll', () => {
    const { rdp, sent } = connection();
    rdp.wheel(wheel(-12.4, -30.6));
    expect(sent).toEqual(['wheel v 31', 'wheel h -12']);
  });
});

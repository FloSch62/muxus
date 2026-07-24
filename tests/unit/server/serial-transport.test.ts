import { describe, expect, it } from 'vitest';
import type { SerialProfile } from '@muxus/shared';
import { serialOpenOptions } from '../../../server/src/serial/serial-transport.js';

describe('serialOpenOptions', () => {
  it('maps framing and hardware flow control to node-serialport', () => {
    const profile: SerialProfile = {
      kind: 'serial',
      path: 'COM3',
      baudRate: 921600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'hardware',
    };
    expect(serialOpenOptions(profile)).toEqual({
      path: 'COM3',
      baudRate: 921600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      rtscts: true,
      xon: false,
      xoff: false,
      xany: false,
      lock: true,
      autoOpen: false,
    });
  });

  it('maps software flow control without enabling RTS/CTS', () => {
    const profile: SerialProfile = {
      kind: 'serial',
      path: '/dev/ttyUSB0',
      baudRate: 9600,
      dataBits: 7,
      stopBits: 2,
      parity: 'even',
      flowControl: 'software',
    };
    expect(serialOpenOptions(profile)).toMatchObject({
      rtscts: false,
      xon: true,
      xoff: true,
      xany: false,
    });
  });
});

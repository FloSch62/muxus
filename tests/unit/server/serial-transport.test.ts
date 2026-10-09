import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SerialProfile } from '@muxus/shared';
import { SerialTransport, serialOpenOptions } from '../../../server/src/serial/serial-transport.js';

// The transport loads serialport on first use; hand it the mock binding's port.
vi.mock('../../../server/node_modules/serialport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/node_modules/serialport')>();
  return { ...actual, SerialPort: actual.SerialPortMock };
});
const { SerialPortMock } = await import('../../../server/node_modules/serialport');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  SerialPortMock.binding.reset();
});

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

describe('SerialTransport BREAK', () => {
  const profile = (breakDurationMs?: number): SerialProfile => ({
    kind: 'serial',
    path: '/dev/ttyMOCK0',
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    ...(breakDurationMs === undefined ? {} : { breakDurationMs }),
  });

  /** The break states the transport asked the port for, in order. */
  function recordBreakChanges() {
    const set = vi.spyOn(SerialPortMock.prototype, 'set');
    return () => set.mock.calls.map(([options]) => options.brk);
  }

  it('holds the line in break for the host duration, then releases it', async () => {
    SerialPortMock.binding.createPort('/dev/ttyMOCK0');
    const breakStates = recordBreakChanges();
    const transport = await SerialTransport.connect(profile(400));
    try {
      vi.useFakeTimers();
      const sent = transport.sendBreak();
      await vi.advanceTimersByTimeAsync(0);
      expect(breakStates()).toEqual([true]);

      await vi.advanceTimersByTimeAsync(399);
      expect(breakStates()).toEqual([true]);
      await vi.advanceTimersByTimeAsync(1);
      await sent;
      expect(breakStates()).toEqual([true, false]);
    } finally {
      transport.close();
    }
  });

  it('defaults to 250 ms and ignores a second press while the line is held', async () => {
    SerialPortMock.binding.createPort('/dev/ttyMOCK0');
    const breakStates = recordBreakChanges();
    const transport = await SerialTransport.connect(profile());
    try {
      vi.useFakeTimers();
      const first = transport.sendBreak();
      await vi.advanceTimersByTimeAsync(100);
      await transport.sendBreak();
      await vi.advanceTimersByTimeAsync(149);
      expect(breakStates()).toEqual([true]);
      await vi.advanceTimersByTimeAsync(1);
      await first;
      expect(breakStates()).toEqual([true, false]);
    } finally {
      transport.close();
    }
  });

  it('releases a held break before closing the port', async () => {
    SerialPortMock.binding.createPort('/dev/ttyMOCK0');
    const breakStates = recordBreakChanges();
    const close = vi.spyOn(SerialPortMock.prototype, 'close');
    const transport = await SerialTransport.connect(profile(5_000));
    vi.useFakeTimers();
    const sent = transport.sendBreak();
    await vi.advanceTimersByTimeAsync(10);

    transport.close();
    await sent;
    expect(breakStates()).toEqual([true, false]);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it('reports a port that cannot take the break, releasing it anyway', async () => {
    SerialPortMock.binding.createPort('/dev/ttyMOCK0');
    // A pty, for one: the break ioctl succeeds, setting the modem lines fails.
    const set = vi.spyOn(SerialPortMock.prototype, 'set').mockImplementation(function (
      this: InstanceType<typeof SerialPortMock>,
      _options,
      callback,
    ) {
      queueMicrotask(() => callback?.call(this, new Error('Inappropriate ioctl for device, cannot set')));
    });
    const transport = await SerialTransport.connect(profile());
    try {
      await expect(transport.sendBreak()).rejects.toThrow('Inappropriate ioctl');
      expect(set.mock.calls.map(([options]) => options.brk)).toEqual([true, false]);
      transport.close();
      await expect(transport.sendBreak()).rejects.toThrow('not open');
    } finally {
      transport.close();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { serialPortsResponse } from '../../../server/src/routes/serial.js';

describe('serial routes', () => {
  it('returns naturally sorted OS port metadata', () => {
    expect(
      serialPortsResponse([
        { path: 'COM10', manufacturer: 'Acme', serialNumber: 'ten' },
        { path: 'COM2', vendorId: '1234', productId: '5678' },
      ]),
    ).toEqual({
      ports: [
        {
          path: 'COM2',
          manufacturer: undefined,
          serialNumber: undefined,
          pnpId: undefined,
          locationId: undefined,
          productId: '5678',
          vendorId: '1234',
        },
        {
          path: 'COM10',
          manufacturer: 'Acme',
          serialNumber: 'ten',
          pnpId: undefined,
          locationId: undefined,
          productId: undefined,
          vendorId: undefined,
        },
      ],
    });
  });
});

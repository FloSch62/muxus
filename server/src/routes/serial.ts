import type { FastifyInstance } from 'fastify';
import { SerialPort } from 'serialport';
import type { SerialPortsResponse } from '@muxus/shared';

interface ListedSerialPort {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
  productId?: string;
  vendorId?: string;
}

export function serialPortsResponse(ports: readonly ListedSerialPort[]): SerialPortsResponse {
  return {
    ports: ports
      .map((port) => ({
        path: port.path,
        manufacturer: port.manufacturer,
        serialNumber: port.serialNumber,
        pnpId: port.pnpId,
        locationId: port.locationId,
        productId: port.productId,
        vendorId: port.vendorId,
      }))
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })),
  };
}

/** Enumerate OS serial devices for the saved-host editor. */
export function registerSerialRoutes(app: FastifyInstance): void {
  app.get('/api/serial/ports', async (): Promise<SerialPortsResponse> => {
    return serialPortsResponse(await SerialPort.list());
  });
}

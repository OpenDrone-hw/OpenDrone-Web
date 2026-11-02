/**
 * Minimal WebUSB / Web Serial typings for the flasher. Only the members the
 * flasher calls are declared, so no @types package is pulled in. Both APIs
 * exist only in Chromium browsers; every caller feature-detects
 * `navigator.usb` / `navigator.serial` first.
 */

interface FlasherUSBDeviceFilter {
  vendorId?: number;
  productId?: number;
}

interface FlasherUSBEndpoint {
  endpointNumber: number;
  direction: 'in' | 'out';
  type: 'bulk' | 'interrupt' | 'isochronous';
}

interface FlasherUSBAlternate {
  interfaceClass: number;
  interfaceSubclass: number;
  interfaceProtocol: number;
  endpoints: FlasherUSBEndpoint[];
}

interface FlasherUSBInterface {
  interfaceNumber: number;
  alternate: FlasherUSBAlternate;
  claimed: boolean;
}

interface FlasherUSBConfiguration {
  interfaces: FlasherUSBInterface[];
}

interface FlasherUSBTransferInResult {
  data?: DataView;
  status: 'ok' | 'stall' | 'babble';
}

interface FlasherUSBTransferOutResult {
  bytesWritten: number;
  status: 'ok' | 'stall';
}

interface FlasherUSBControlSetup {
  requestType: 'standard' | 'class' | 'vendor';
  recipient: 'device' | 'interface' | 'endpoint' | 'other';
  request: number;
  value: number;
  index: number;
}

interface FlasherUSBDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly serialNumber?: string;
  readonly opened: boolean;
  readonly configuration: FlasherUSBConfiguration | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  transferIn(ep: number, length: number): Promise<FlasherUSBTransferInResult>;
  transferOut(ep: number, data: BufferSource): Promise<FlasherUSBTransferOutResult>;
  clearHalt(direction: 'in' | 'out', ep: number): Promise<void>;
  controlTransferIn(setup: FlasherUSBControlSetup, length: number): Promise<FlasherUSBTransferInResult>;
  controlTransferOut(setup: FlasherUSBControlSetup, data?: BufferSource): Promise<FlasherUSBTransferOutResult>;
}

interface FlasherUSB extends EventTarget {
  requestDevice(options: {filters: FlasherUSBDeviceFilter[]}): Promise<FlasherUSBDevice>;
  getDevices(): Promise<FlasherUSBDevice[]>;
}

interface FlasherSerialPort {
  open(options: {baudRate: number}): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  getInfo(): {usbVendorId?: number; usbProductId?: number};
}

interface FlasherSerial extends EventTarget {
  requestPort(options?: {filters?: {usbVendorId?: number; usbProductId?: number}[]}): Promise<FlasherSerialPort>;
}

interface Navigator {
  readonly usb?: FlasherUSB;
  readonly serial?: FlasherSerial;
}

/**
 * Who holds the flight controller, as plain functions (tested), so the
 * serial buttons in steps 1 and 3 are never silently disabled.
 *
 * The step-4 WebUSB (PICOBOOT) connection holds the board while it is open,
 * connecting or writing. While it holds the board, the serial buttons are
 * disabled and say why. A board that leaves bootloader mode (reboot into
 * Betaflight, unplug) fires navigator.usb "disconnect" for that device: the
 * connection is then dropped (unless a write is running: its own error path
 * handles that), so a stale connection never keeps the buttons disabled.
 */

export function fcDeviceBusy(s: {connected: boolean; connecting: boolean; flashing: boolean}): boolean {
  return s.connected || s.connecting || s.flashing;
}

/** True when a USB "disconnect" event is for the device the open connection holds, and no write is running. */
export function usbDisconnectDropsConnection(held: unknown, eventDevice: unknown, flashing: boolean): boolean {
  return !flashing && held != null && eventDevice != null && held === eventDevice;
}

export const USB_HOLD_REASON = 'The USB install panel in step 4 is connected to the board.';

/** The state of a Web Serial button (Identify, Restart into bootloader) given who holds the board. */
export function serialButtonState(s: {usbHolds: boolean}): {disabled: boolean; reason: string | null} {
  return s.usbHolds ? {disabled: true, reason: USB_HOLD_REASON} : {disabled: false, reason: null};
}

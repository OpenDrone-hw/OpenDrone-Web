import {DONE_TEXT, NEED_USB_TEXT, startUpdate, type FlowDeps, type FlowResult} from '../fc-update.ts';

/**
 * What a click on "Update firmware" does. Pure, so a test can prove a locked or
 * not-backed-up click never reaches startUpdate (and so never opens the serial
 * picker), while an allowed click starts it with no await in between: the
 * picker must stay the click's first await (user activation).
 */
export function updateClick(
  state: {locked: boolean; backedUp: boolean; lockText: string | null; backupReason: string},
  say: (text: string) => void,
  deps: FlowDeps,
): Promise<FlowResult> | null {
  if (state.locked) {
    if (state.lockText) say(state.lockText);
    return null;
  }
  if (!state.backedUp) {
    say(state.backupReason);
    return null;
  }
  return startUpdate(deps);
}

/**
 * The text say() announces when a flow ends, or null. Failures and refusals
 * render in a role="alert" box, which announces them; saying them too read them
 * twice.
 */
export function finishAnnouncement(r: FlowResult): string | null {
  if (r.kind === 'done') return DONE_TEXT;
  if (r.kind === 'need-usb') return NEED_USB_TEXT;
  return null;
}

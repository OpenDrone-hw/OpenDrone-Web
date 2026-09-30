import {useAside} from '~/components/Aside';
import {requestChatFpvOpen} from './chatfpv-widget-ui';

/**
 * Phone entry points to the ChatFPV panel (no floating launcher at 959px and narrower,
 * audit round 3 A4). Both render nothing visible unless a `ChatFpvWidget` is
 * mounted on the page (`html.chatfpv-widget-on`, set by the widget), so pages
 * without the widget show no dead link. Styles: `.chatfpv-entry` in app.css.
 */

/** "Ask ChatFPV" row in the mobile menu drawer: closes the drawer, then opens the panel. */
export function ChatFpvMenuEntry() {
  const {close} = useAside();
  return (
    <button
      type="button"
      className="chatfpv-entry chatfpv-entry-menu"
      onClick={(e) => {
        const trigger = e.currentTarget;
        close();
        // Let the drawer release focus and scroll lock first.
        window.setTimeout(() => requestChatFpvOpen(trigger), 60);
      }}
    >
      Ask ChatFPV
      <span className="chatfpv-entry-tag">Beta</span>
    </button>
  );
}

/** Small "Questions? Ask ChatFPV" link under the buy box; 959px and narrower only. */
export function ChatFpvInlineLink() {
  return (
    <p className="chatfpv-entry chatfpv-entry-inline">
      Questions?{' '}
      <button type="button" onClick={(e) => requestChatFpvOpen(e.currentTarget)}>
        Ask ChatFPV
      </button>
    </p>
  );
}

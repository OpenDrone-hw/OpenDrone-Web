import {useState} from 'react';
import {AlertCircle, Info, X} from 'lucide-react';
import {copyText} from '~/lib/copy';

/**
 * The site standard's notice: one bordered line with an icon, at the top of
 * the content it is about. `info` neutral, `warn` gold (something to check),
 * `error` red (something that stops the order). Dismissible when given
 * `dismissible`: it then hides until the page loads again.
 */
export function Notice({
  tone = 'info',
  dismissible = false,
  children,
}: {
  tone?: 'info' | 'warn' | 'error';
  dismissible?: boolean;
  children: React.ReactNode;
}) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const Icon = tone === 'info' ? Info : AlertCircle;
  return (
    <div className={`notice is-${tone}`} role={tone === 'error' ? 'alert' : 'status'} data-notice={tone}>
      <Icon className="notice-icon" size={16} aria-hidden="true" />
      <div className="notice-text">{children}</div>
      {dismissible ? (
        <button type="button" className="notice-close" onClick={() => setHidden(true)} aria-label={copyText('site.notice_dismiss') ?? 'Dismiss'}>
          <X size={16} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

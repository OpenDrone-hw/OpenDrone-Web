import {isDual} from '~/lib/testing/labels';
import {axisTitle} from '~/lib/testing/layout';
import type {Theme} from '~/lib/testing/palette';
import type {Fig} from '~/lib/testing/types';

/**
 * The y axis title, written once above the plot instead of rotated beside it.
 * On a two-axis figure each title sits over its own axis, in the body grey.
 */
export function UnitLine({fig}: {fig: Fig; theme?: Theme}) {
  const dual = isDual(fig);
  return (
    <p className="tw-unitline" data-dual={dual ? '1' : undefined}>
      <span>{axisTitle(fig, 'y')}</span>
      {fig.axes.y2 ? <span>{axisTitle(fig, 'y2')}</span> : null}
    </p>
  );
}

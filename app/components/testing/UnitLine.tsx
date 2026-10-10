import {isDual} from '~/lib/testing/labels';
import {axisTitle} from '~/lib/testing/layout';
import {assignStyles, type Theme} from '~/lib/testing/palette';
import type {Fig} from '~/lib/testing/types';

/**
 * The y axis title, written once above the plot instead of rotated beside it.
 * On a two-axis figure each title takes the colour of its line and sits over
 * its own axis.
 */
export function UnitLine({fig, theme}: {fig: Fig; theme: Theme}) {
  const dual = isDual(fig);
  const styles = assignStyles(fig.series, theme);
  const colour = (axis: 'y' | 'y2') => {
    const s = fig.series.find((q) => (q.axis === 'y2') === (axis === 'y2'));
    return dual && s ? styles[s.id]!.colorCss : undefined;
  };
  return (
    <p className="tw-unitline" data-dual={dual ? '1' : undefined}>
      <span style={{color: colour('y')}}>{axisTitle(fig, 'y')}</span>
      {fig.axes.y2 ? <span style={{color: colour('y2')}}>{axisTitle(fig, 'y2')}</span> : null}
    </p>
  );
}

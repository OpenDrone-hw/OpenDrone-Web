import {domainColorCss} from '~/lib/testing/palette';
import type {Fig, TestingIndex} from '~/lib/testing/types';
import {FigureCard} from './FigureCard';

/** One product: a heading with a 3 px bar in its domain colour, then its figures. */
export function ProductSection({
  product,
  index,
  previews,
}: {
  product: TestingIndex['products'][number];
  index: TestingIndex;
  previews: Record<string, Fig>;
}) {
  const ids = product.figures.filter((id) => index.figures[id] && previews[id]);
  const [lead, ...rest] = ids;
  const domain = lead ? index.figures[lead]!.domain : 'aux';
  const card = (id: string, size: 'wide' | 'half') => (
    <FigureCard
      key={id}
      id={id}
      summary={index.figures[id]!}
      run={index.runs[index.figures[id]!.runId]}
      preview={previews[id]!}
      size={size}
    />
  );
  return (
    <section className="tw-product" id={product.handle} style={{['--domain' as string]: domainColorCss(domain)}}>
      <h2>
        {product.name}
      </h2>
      {lead ? card(lead, 'wide') : null}
      {rest.length ? <div className="tw-grid">{rest.map((id) => card(id, 'half'))}</div> : null}
    </section>
  );
}

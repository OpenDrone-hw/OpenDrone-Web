import {copyFill, copyText} from '~/lib/copy';
import {PLUG_PIN_KINDS, type Plug, type PlugPin, type PlugPinKind} from '~/lib/product-content';

/*
 * The Specs chapter's plug drawings: each JST-SH plug as a housing outline
 * in the site's gold drawing ink with one numbered contact per pin, and
 * power rails as chips. Pin colours follow the legend. Every word comes from the product JSON or product-chrome copy.
 */

type EditFn = (path: string) => Record<string, string>;

const LEGEND: Record<PlugPinKind, [string, string]> = {
  power: ['product-chrome.plugs_legend_power', 'Power'],
  ground: ['product-chrome.plugs_legend_ground', 'Ground'],
  signal: ['product-chrome.plugs_legend_signal', 'Signal'],
  motor: ['product-chrome.plugs_legend_motor', 'Motor'],
  nc: ['product-chrome.plugs_legend_nc', 'Not connected'],
};

const legendWord = (kind: PlugPinKind) => copyText(LEGEND[kind][0]) ?? LEGEND[kind][1];

/** Pin pitch, housing margin and retention-tab width, in drawing units. */
const PITCH = 36;
const MARGIN = 10;
const TAB = 7;

function pinName(pin: PlugPin): string {
  return pin.title ? `${pin.label}: ${pin.title}` : pin.label;
}

/** Diagonal hatching inside a not-connected contact. */
function Hatch({x, y, w, h}: {x: number; y: number; w: number; h: number}) {
  const step = 5;
  const lines = [];
  // 45-degree lines x + t = c, clipped to the rectangle by hand.
  for (let c = step; c < w + h; c += step) {
    const x1 = x + Math.max(0, c - h);
    const y1 = y + Math.min(h, c);
    const x2 = x + Math.min(w, c);
    const y2 = y + Math.max(0, c - w);
    lines.push(<line key={c} className="plug-hatch" x1={x1} y1={y1} x2={x2} y2={y2} />);
  }
  return <g aria-hidden="true">{lines}</g>;
}

function JstDrawing({plug, base, edit}: {plug: Plug; base: string; edit: EditFn}) {
  const pins = plug.pins ?? [];
  const inner = pins.length * PITCH + 2 * MARGIN;
  const width = inner + 2 * TAB;
  const height = 80;
  const cx = (i: number) => TAB + MARGIN + PITCH * (i + 0.5);
  const label = `${plug.name}: ${pins.map((p, i) => `${i + 1} ${p.label}`).join(', ')}`;
  return (
    <svg
      className="plug-svg"
      viewBox={`0 0 ${width} ${height}`}
      style={{width: `min(100%, ${Math.round(width * 1.2)}px)`}}
      role="img"
      aria-label={label}
    >
      {/* Retention tabs, then the housing. */}
      <rect className="plug-line plug-line--thin" x={0.5} y={24} width={TAB} height={24} />
      <rect className="plug-line plug-line--thin" x={width - TAB - 0.5} y={24} width={TAB} height={24} />
      <rect className="plug-line" x={TAB} y={16} width={inner} height={42} rx={2} />
      {pins.map((_, i) =>
        i === 0 ? null : (
          <line
            key={`sep${i}`}
            className="plug-line plug-line--sep"
            x1={cx(i) - PITCH / 2}
            x2={cx(i) - PITCH / 2}
            y1={16}
            y2={58}
          />
        ),
      )}
      {/* Pin 1 marker. */}
      <path className="plug-marker" d={`M${cx(0) - 5} 4 h10 l-5 7 z`}>
        <title>{copyText('product-chrome.plugs_pin1') ?? 'Pin 1'}</title>
      </path>
      {pins.map((pin, i) => (
        <g key={i} className={`plug-pin plug-pin--${pin.kind}`}>
          <title>{`${i + 1}. ${pinName(pin)}`}</title>
          <text className="plug-num" x={cx(i)} y={29}>
            {i + 1}
          </text>
          <rect
            className="plug-contact"
            x={cx(i) - PITCH / 2 + 6}
            y={35}
            width={PITCH - 12}
            height={15}
            rx={1}
          />
          {pin.kind === 'nc' ? <Hatch x={cx(i) - PITCH / 2 + 6} y={35} w={PITCH - 12} h={15} /> : null}
          <text className="plug-label" x={cx(i)} y={74} {...edit(`${base}.pins.${i}.label`)}>
            {pin.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

function PlugCard({plug, base, edit}: {plug: Plug; base: string; edit: EditFn}) {
  const n = plug.pins?.length ?? 0;
  const meta =
    plug.kind === 'jst-sh'
      ? copyFill('product-chrome.plugs_jst_sh', 'JST-SH · {n}-pin', {n})
      : (copyText('product-chrome.plugs_rails') ?? 'Regulated outputs');
  return (
    <li className={`plug-card plug-card--${plug.kind}`}>
      <div className="plug-head">
        <span className="plug-name" {...edit(`${base}.name`)}>
          {plug.name}
        </span>
        <span className="plug-meta">{meta}</span>
      </div>
      {plug.kind === 'jst-sh' ? <JstDrawing plug={plug} base={base} edit={edit} /> : null}
      {plug.kind === 'rail' ? (
        <ul className="plug-rails">
          {(plug.rails ?? []).map((rail, i) => (
            <li key={i} className="plug-rail">
              <span className="plug-rail-v" {...edit(`${base}.rails.${i}.voltage`)}>
                {rail.voltage}
              </span>
              <span className="plug-rail-mode" {...edit(`${base}.rails.${i}.mode`)}>
                {rail.mode}
              </span>
              <span className="plug-rail-a" {...edit(`${base}.rails.${i}.current`)}>
                {rail.current}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function PlugDiagrams({
  plugs,
  editBase,
  edit,
  title,
}: {
  plugs: Plug[];
  /** JSON path of `plugs` in the product file, for studio edit tags. */
  editBase: string;
  edit: EditFn;
  title: string;
}) {
  const used = new Set(plugs.flatMap((p) => (p.pins ?? []).map((pin) => pin.kind)));
  if (plugs.some((p) => p.kind === 'rail')) used.add('power');
  const legend = PLUG_PIN_KINDS.filter((k) => used.has(k));
  return (
    <div className="plugs">
      <div className="plugs-top">
        <h3 className="plugs-title">{title}</h3>
        <ul className="plugs-legend">
          {legend.map((k) => (
            <li key={k} className={`plug-pin--${k}`}>
              <span className="plugs-swatch" aria-hidden="true" />
              {legendWord(k)}
            </li>
          ))}
        </ul>
      </div>
      <ul className="plugs-grid">
        {plugs.map((plug, i) => (
          <PlugCard key={`${plug.name}-${i}`} plug={plug} base={`${editBase}.${i}`} edit={edit} />
        ))}
      </ul>
    </div>
  );
}

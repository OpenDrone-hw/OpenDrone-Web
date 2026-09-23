/**
 * The homepage walkthrough's steps, read from a design's studio.json beats
 * (`public/models/od3/studio.json`, edited in /studio). A beat is one step; a
 * beat with mid-hold `stops` is one step per stop. The 3D scene, the desktop
 * caption panel and the phone walkthrough all read the steps through this, so
 * the copy has one source.
 */
export type TourStep = {
  /** Beat id, or the stop's own id. Also the /#<id> deep link. */
  id: string;
  /** The part's role, the caption heading ("Flight controller"). */
  title: string;
  /** What the part does in the quad, one or two short sentences. */
  caption?: string;
  /** Product handle when the part is sold here. */
  handle?: string;
};

type RawStop = {id?: string; title?: string; caption?: string; handle?: string};
type RawBeat = RawStop & {id: string; stops?: RawStop[]};

export function tourSteps(beats: ReadonlyArray<RawBeat>): TourStep[] {
  const steps: TourStep[] = [];
  for (const b of beats) {
    const entries: RawStop[] = b.stops?.length
      ? b.stops.map((st, j) => ({...st, id: st.id ?? `${b.id}-${j + 1}`}))
      : [b];
    for (const e of entries)
      steps.push({
        id: e.id ?? b.id,
        title: e.title ?? '',
        caption: e.caption || undefined,
        handle: e.handle || undefined,
      });
  }
  return steps;
}

/** "02 / 07": the step counter, zero-padded to two digits. */
export function stepCounter(index: number, total: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(index + 1)} / ${pad(total)}`;
}

/** The phone still a step shows: its own, except the closing build step,
 *  which shows the whole drone (`whole.webp`) rather than a still of its
 *  own. */
export function tourStillId(id: string): string {
  return id === 'build' ? 'whole' : id;
}

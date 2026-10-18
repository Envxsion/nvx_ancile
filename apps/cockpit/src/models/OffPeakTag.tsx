/**
 * ------------------------------------------------------------------
 *  Title    |  Off-peak tag
 *  Ref      |  roadmap PV1 · models/offPeak.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A small tag on a model that costs less at quiet hours:
 *           |  "Half price off-peak", with the hours in your time zone
 *           |  one hover away.
 *  How      |  The words come from offPeakLabel and offPeakWords. The
 *           |  hours are also in the tag's hidden text, so a screen
 *           |  reader hears them without hovering.
 * ------------------------------------------------------------------
 */

import { type OffPeakRates, offPeakLabel, offPeakTitle } from './offPeak';

export function OffPeakTag({
  price,
  offPeak,
}: {
  price: { in: number; out: number };
  offPeak: OffPeakRates;
}) {
  const title = offPeakTitle(price, offPeak);
  return (
    <span className="tag tag--offpeak" title={title}>
      {offPeakLabel(price, offPeak)}
      <span className="sr-only">. {title}</span>
    </span>
  );
}

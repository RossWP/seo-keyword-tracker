// English function words. Keyword phrases may contain them ("how to rank") but never start
// or end with one. Other languages are on the cut list (README).
export const STOPWORDS = new Set(
  `a about above after again against all also am an and any are as at be because been before
being below between both but by can could did do does doing down during each else ever every
few for from further get gets got had has have having he her here hers herself him himself his
how i if in into is it its itself just like may me might more most must my myself no nor not now
of off on once only or other our ours ourselves out over own per same she should so some such
than that the their theirs them themselves then there these they this those through to too
under until up upon us very via was we were what when where which while who whom whose why will
with within without would yet you your yours yourself yourselves vs etc one two new use using
used make makes way ways learn read`
    .split(/\s+/)
    .filter(Boolean),
);

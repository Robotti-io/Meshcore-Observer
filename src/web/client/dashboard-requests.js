import { buildQueryString } from './dashboard-logic.js';

/** A stalled local endpoint must eventually release the refresh/coalescing owner. */
export async function fetchDashboardJson(path, signal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { signal: controller.signal });
    if (!response.ok) throw new Error(path + ' failed (' + response.status + ')');
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Owns the current repeater-list request, including its captured page/filter. */
export function createNodeListController({ load, onStart, onSuccess, onError }) {
  let generation = 0;
  let controller = null;
  return {
    async refresh(params) {
      const request = ++generation;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      const query = { ...params };
      onStart(query);
      try {
        const data = await load('/api/nodes?' + buildQueryString(query), signal);
        if (signal.aborted || request !== generation) return;
        onSuccess(data, query);
      } catch (error) {
        if (!signal.aborted && request === generation) onError(error, query);
      }
    },
    cancel() {
      generation += 1;
      controller?.abort();
    }
  };
}

/** Start all reports with rejection handlers attached immediately. Each section
 * can publish independently; one missing endpoint cannot hide another's data.
 */
export async function loadDashboardReports({ aggregatePath, definitions, load, isCurrent,
  onAggregate, onAggregateError, onReport, onReportError }) {
  const aggregate = Promise.resolve().then(() => load(aggregatePath)).then(
    data => {
      if (!isCurrent()) return;
      try { onAggregate(data); }
      catch (error) { onAggregateError(error); }
    },
    error => { if (isCurrent()) onAggregateError(error); }
  );
  const focused = definitions.map(definition => Promise.resolve().then(() => load(definition.path)).then(
    data => { if (isCurrent()) onReport(definition, data); },
    error => { if (isCurrent()) onReportError(definition, error); }
  ));
  await Promise.all([aggregate, ...focused]);
}

/** Retain same-range last-good data; never present another range as current. */
export function reportingDataForRange(state, rangeKey) {
  return state?.dataRangeKey === rangeKey ? state.data : undefined;
}

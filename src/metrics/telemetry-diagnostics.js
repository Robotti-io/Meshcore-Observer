import { assertTelemetryInput } from '../telemetry/telemetry-validation.js';
import { telemetryRequestDiagnosticSchema, telemetryRequestDiagnosticPageSchema } from '../telemetry/telemetry-schemas.js';

/** Durable bounded request-level routing/preflight diagnostics. */
export function createTelemetryDiagnostics(db, requireRun) {
  const insert = db.prepare(`INSERT INTO telemetry_request_diagnostics(request_id,run_id,observer_public_key,
    target_public_key,operation,started_at,completed_at,clock_anomaly,status,reason,diagnostic_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING`);
  const byId = db.prepare('SELECT diagnostic_json AS diagnosticJson FROM telemetry_request_diagnostics WHERE request_id=?');

  function record(input) {
    assertTelemetryInput(telemetryRequestDiagnosticSchema, input);
    requireRun(input.runId);
    const result = insert.run(input.requestId,input.runId,input.observerPublicKey,input.targetPublicKey,input.operation,
      input.startedAt,input.completedAt,Number(input.clockAnomaly),input.status,input.reason,JSON.stringify(input));
    const saved = byId.get(input.requestId);
    let prior;
    try {
      prior = JSON.parse(saved.diagnosticJson);
      assertTelemetryInput(telemetryRequestDiagnosticSchema, prior);
    } catch { throw new Error('Invalid stored telemetry request diagnostic'); }
    if (JSON.stringify(prior) !== JSON.stringify(input)) throw new Error('Telemetry diagnostic request identity conflict');
    return { requestId: input.requestId, duplicate: result.changes === 0 };
  }

  function page(query) {
    assertTelemetryInput(telemetryRequestDiagnosticPageSchema, query);
    if (query.start > query.end) throw new Error('Invalid telemetry diagnostic range');
    const limit = query.limit ?? 100, offset = query.offset ?? 0;
    const clauses = ['completed_at>=?', 'completed_at<?'], values = [query.start,query.end];
    for (const [field,column] of [['observerPublicKey','observer_public_key'],['targetPublicKey','target_public_key'],
      ['runId','run_id'],['operation','operation'],['status','status']]) {
      if (query[field] !== undefined) { clauses.push(`${column}=?`); values.push(query[field]); }
    }
    const where = clauses.join(' AND ');
    const total = db.prepare(`SELECT count(*) AS total FROM telemetry_request_diagnostics WHERE ${where}`).get(...values).total;
    const rows = db.prepare(`SELECT d.diagnostic_json AS diagnosticJson,n.name AS targetName
      FROM telemetry_request_diagnostics d LEFT JOIN nodes n ON n.public_key_hex=d.target_public_key
      WHERE ${where} ORDER BY d.completed_at DESC,d.request_id DESC LIMIT ? OFFSET ?`).all(...values,limit,offset);
    const diagnostics = rows.map(({ diagnosticJson, targetName }) => {
      try {
        const value = JSON.parse(diagnosticJson);
        assertTelemetryInput(telemetryRequestDiagnosticSchema,value);
        return { ...value, targetName: value.targetName ?? targetName ?? null };
      } catch { throw new Error('Invalid stored telemetry request diagnostic'); }
    });
    const coverage = db.prepare(`SELECT count(*) AS retainedRecords,min(completed_at) AS earliestRetainedAt,
      max(completed_at) AS latestRetainedAt FROM telemetry_request_diagnostics WHERE ${where}`).get(...values);
    return { total, diagnostics, start: query.start, end: query.end, limit, offset,
      countScope: 'retained-range', coverage: { ...coverage, retainedHistoryOnly: true, historyCompleteness: 'unknown' } };
  }

  return { record, page, prune(cutoff) {
    db.prepare('DELETE FROM telemetry_request_diagnostics WHERE completed_at<?').run(cutoff);
  } };
}

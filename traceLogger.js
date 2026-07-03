function formatBeijingTime(ts = Date.now()) {
  const d = new Date(ts);
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const beijingTime = new Date(utc + (3600000 * 8));
  return beijingTime.toISOString().replace('T', ' ').replace('Z', '');
}

function createTrace() {
  const trace = [];
  trace.flushed = false;
  return trace;
}

function traceLog(trace, level, message) {
  if (!trace || trace.flushed) return;
  trace.push({ level, message, ts: Date.now() });
}

function flushTrace(trace, emit) {
  if (!trace || trace.flushed || typeof emit !== 'function') return;
  trace.flushed = true;
  for (const item of trace) {
    emit(item.level, item.message, item.ts);
  }
}

module.exports = {
  createTrace,
  flushTrace,
  formatBeijingTime,
  traceLog
};

const privateWallet = require('./privateWallet');

const logs = [];
const maxLogs = 2000;

function formatBeijingTime(ts = Date.now()) {
  const d = new Date(ts);
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const beijingTime = new Date(utc + (3600000 * 8));
  return beijingTime.toISOString().replace('T', ' ').replace('Z', '');
}

function log(level, message, timestamp = Date.now()) {
  if (privateWallet && typeof privateWallet.shouldSuppress === 'function') {
    if (privateWallet.shouldSuppress(message)) {
      return;
    }
  }
  const timeStr = formatBeijingTime(timestamp);
  const formattedLog = {
    time: timeStr,
    level: level.toUpperCase(), // 'INFO', 'WARN', 'ERROR', 'SUCCESS'
    message: message
  };

  logs.push(formattedLog);
  if (logs.length > maxLogs) logs.shift();

  // Console logging
  const colors = {
    INFO: '\x1b[36m',    // Cyan
    WARN: '\x1b[33m',    // Yellow
    ERROR: '\x1b[31m',   // Red
    SUCCESS: '\x1b[32m'  // Green
  };
  const resetColor = '\x1b[0m';
  const color = colors[formattedLog.level] || '';
  console.log(`[${timeStr}] [${color}${formattedLog.level}${resetColor}] ${message}`);

  if (global.logCallback) {
    global.logCallback(formattedLog);
  }
}

function getLogs() {
  return logs;
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

function flushTrace(trace, emit = log) {
  if (!trace || trace.flushed || typeof emit !== 'function') return;
  trace.flushed = true;
  for (const item of trace) {
    emit(item.level, item.message, item.ts);
  }
}

module.exports = {
  log,
  getLogs,
  createTrace,
  traceLog,
  flushTrace
};

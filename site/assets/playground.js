import { openEngine, queryDatabase } from './sql-engine.js';

const form = document.querySelector('.sql-form');
const input = document.querySelector('#sql-input');
const run = form.querySelector('.sql-run');
const command = run.querySelector('.sql-command');
const icon = run.querySelector('.sql-command-icon');
const reset = form.querySelector('.sql-reset');
const status = document.querySelector('.sql-status');
const errorBox = document.querySelector('.sql-error');
const results = document.querySelector('.sql-result');
const lang = document.documentElement.lang;
const strings = lang === 'zh-CN' ? {
  loading: '首次运行，正在加载 SQL 环境…',
  running: '正在执行查询…',
  stop: '停止',
  stopped: '已停止，可以重新运行。',
  empty: '请输入 SQL。',
  loadError: '无法加载 SQL 环境，请检查网络后重试。',
  queryError: '执行失败，请检查 SQL 后重试。',
  timeout: '查询超时，已停止。请缩小查询范围后重试。',
  summary: (count, time, limited) => `${limited ? '显示前 ' : ''}${count} 行 · ${time} ms`,
} : {
  loading: 'Loading the SQL environment for the first run…',
  running: 'Running query…',
  stop: 'Stop',
  stopped: 'Stopped. You can run the query again.',
  empty: 'Enter a SQL statement.',
  loadError: 'Could not load the SQL environment. Check your connection and try again.',
  queryError: 'Query failed. Check the SQL and try again.',
  timeout: 'Query timed out. Try a smaller query.',
  summary: (count, time, limited) => `${limited ? 'Showing first ' : ''}${count} ${count === 1 ? 'row' : 'rows'} · ${time} ms`,
};
const numberFormat = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 });
const initialStatus = status.textContent;
const runLabel = command.textContent;
let engine;
let active;

function setStatus(text, state = 'idle') {
  status.dataset.state = state;
  status.textContent = text;
}

function clearOutput() {
  errorBox.hidden = results.hidden = true;
  errorBox.textContent = '';
  results.replaceChildren();
}

function clearEngine() {
  engine?.close();
  engine = undefined;
}

function setBusy(busy) {
  command.textContent = busy ? strings.stop : runLabel;
  icon.textContent = busy ? '■' : '▶';
  run.formNoValidate = busy;
  reset.disabled = busy;
}

// Racing the abort signal also covers a stalled CDN import or an unresponsive worker.
async function abortable(signal, task) {
  let onAbort;
  try {
    signal.throwIfAborted();
    const interrupted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([interrupted, task()]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function errorDetail(error) {
  const raw = error?.message || String(error);
  try {
    // The worker can return structured exception metadata as a JSON string.
    const parsed = JSON.parse(raw);
    return typeof parsed?.exception_message === 'string' ? parsed.exception_message : raw;
  } catch {
    return raw;
  }
}

function displayValue(value) {
  const text = value === null ? 'NULL' : String(value);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function showResults({ columns, rows }) {
  if (!columns.length) return;
  const table = document.createElement('table');
  table.setAttribute('aria-label', results.getAttribute('aria-label'));
  const header = table.createTHead().insertRow();
  for (const name of columns) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = name;
    header.append(cell);
  }
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const value of row) tr.insertCell().textContent = displayValue(value);
  }
  results.replaceChildren(table);
  results.hidden = false;
}

async function execute(sql) {
  const controller = new AbortController();
  const { signal } = controller;
  active = controller;
  setBusy(true);
  clearOutput();
  let timeout;
  let loading = !engine;
  try {
    if (loading) {
      setStatus(strings.loading);
      timeout = setTimeout(() => controller.abort('timeout'), 45_000);
      engine = await abortable(signal, () => openEngine(signal, lang));
      clearTimeout(timeout);
      loading = false;
    }
    setStatus(strings.running);
    timeout = setTimeout(() => controller.abort('timeout'), 8_000);
    const started = performance.now();
    const output = await abortable(signal, () => queryDatabase(engine.connection, sql));
    const elapsed = numberFormat.format(performance.now() - started);
    showResults(output);
    setStatus(strings.summary(output.rows.length, elapsed, output.limited), 'success');
  } catch (error) {
    if (signal.aborted || loading) clearEngine();
    if (signal.reason === 'stop') {
      setStatus(strings.stopped);
    } else if (loading) {
      setStatus(strings.loadError, 'error');
    } else if (signal.aborted) {
      setStatus(strings.timeout, 'error');
    } else {
      setStatus(strings.queryError, 'error');
      errorBox.textContent = errorDetail(error).slice(0, 1600);
      errorBox.hidden = false;
    }
  } finally {
    clearTimeout(timeout);
    active = undefined;
    setBusy(false);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (active) {
    active.abort('stop');
    return;
  }
  const sql = input.value.trim();
  if (!sql) {
    input.setCustomValidity(strings.empty);
    input.reportValidity();
    return;
  }
  void execute(sql);
});

input.addEventListener('input', () => input.setCustomValidity(''));
input.addEventListener('keydown', (event) => {
  if (event.isComposing || event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  if (!active && !event.repeat) form.requestSubmit(run);
});
reset.addEventListener('click', () => {
  form.reset();
  input.setCustomValidity('');
  clearEngine();
  clearOutput();
  setStatus(initialStatus);
  input.focus();
});

input.disabled = run.disabled = reset.disabled = false;

import fs from 'node:fs';
import dns from 'node:dns/promises';
import { spawn } from 'node:child_process';

const targets = [
  { label: 'digital-eg', url: 'https://digital.gov.eg/' },
  { label: 'control-example', url: 'https://example.com/' },
];
const outputPath = process.env.DIAGNOSTIC_OUTPUT_PATH || '/tmp/digital-eg-connectivity-diagnostic.json';
const timeoutMs = Math.max(1000, Number(process.env.DIAGNOSTIC_TIMEOUT_MS || 15000));
const browserTimeoutMs = Math.max(1000, Number(process.env.DIAGNOSTIC_BROWSER_TIMEOUT_MS || 60000));
const browserCandidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
const browserBinary = process.env.CRAWLER_BROWSER_BIN || browserCandidates.find((candidate) => fs.existsSync(candidate)) || 'chromium';

function errorChain(error) {
  const chain = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1, current = current.cause) {
    const item = {};
    for (const key of ['name', 'message', 'code', 'errno', 'syscall', 'hostname', 'port']) {
      if (current[key] !== undefined && current[key] !== null) item[key] = String(current[key]).slice(0, 300);
    }
    chain.push(item);
  }
  return chain;
}

async function resolveHost(host) {
  const result = { host };
  try { result.lookup = await dns.lookup(host, { all: true, verbatim: true }); }
  catch (error) { result.lookupError = errorChain(error); }
  try { result.resolve4 = await dns.resolve4(host); }
  catch (error) { result.resolve4Error = errorChain(error); }
  try { result.resolve6 = await dns.resolve6(host); }
  catch (error) { result.resolve6Error = errorChain(error); }
  return result;
}

async function httpCheck(target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(target.url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'BahethMasrNetworkDiagnostic/1.0' },
    });
    let bytes = 0;
    let excerpt = '';
    if (response.body) {
      const reader = response.body.getReader();
      while (bytes < 65536) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (excerpt.length < 2000) excerpt += new TextDecoder().decode(value.slice(0, 2000 - excerpt.length), { stream: true });
      }
      await reader.cancel().catch(() => {});
    }
    return { label: target.label, url: target.url, ok: true, status: response.status, finalUrl: response.url, contentType: response.headers.get('content-type'), bytesRead: bytes, excerpt: excerpt.replace(/\s+/g, ' ').slice(0, 1000), durationMs: Date.now() - started };
  } catch (error) {
    return { label: target.label, url: target.url, ok: false, durationMs: Date.now() - started, error: errorChain(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function chromiumCheck(target) {
  const started = Date.now();
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(browserBinary, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--virtual-time-budget=30000', '--run-all-compositor-stages-before-draw', '--dump-dom', target.url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, browserTimeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ label: target.label, url: target.url, browserBinary, durationMs: Date.now() - started, timedOut, ...result });
    };
    child.stdout.on('data', (chunk) => { if (stdout.length < 8192) stdout += chunk.toString('utf8').slice(0, 8192 - stdout.length); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000); });
    child.once('error', (error) => finish({ ok: false, error: errorChain(error), stdoutBytes: Buffer.byteLength(stdout), stderrTail: stderr.slice(-2000) }));
    child.once('close', (code, signal) => finish({
      ok: !timedOut && code === 0 && stdout.trim().length > 0,
      exitCode: code,
      signal,
      stdoutBytes: Buffer.byteLength(stdout),
      htmlExcerpt: stdout.replace(/\s+/g, ' ').slice(0, 1000),
      stderrTail: stderr.slice(-2000),
    }));
  });
}

const hosts = [...new Set(targets.map((target) => new URL(target.url).hostname))];
const report = {
  generatedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  timeouts: { httpMs: timeoutMs, chromiumMs: browserTimeoutMs },
  dns: await Promise.all(hosts.map(resolveHost)),
  http: await Promise.all(targets.map(httpCheck)),
  chromium: [],
};
for (const target of targets) report.chromium.push(await chromiumCheck(target));
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

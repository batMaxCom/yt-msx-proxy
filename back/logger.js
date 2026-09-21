const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.YT_LOG_DIR ? path.resolve(process.env.YT_LOG_DIR) : path.join(__dirname, 'logs');
const MAX_STRING_LENGTH = 2000;
const MAX_STDERR_LENGTH = 600;

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const LEVELS = ['debug', 'info', 'warn', 'error'];

function today() {
    return new Date().toISOString().slice(0, 10);
}

function cap(value, max) {
    if (typeof value !== 'string') return value;
    if (value.length <= max) return value;
    return value.slice(0, max) + `…[truncated ${value.length - max} chars]`;
}

function sanitizeMeta(meta) {
    if (meta === undefined || meta === null) return undefined;
    const out = {};
    for (const [key, value] of Object.entries(meta)) {
        if (value === undefined || value === null) continue;
        out[key] = cap(value, MAX_STRING_LENGTH);
    }
    return out;
}

function entryFile(date) {
    return path.join(LOG_DIR, `events-${date}.ndjson`);
}

function write(level, category, message, meta) {
    const ts = new Date().toISOString();
    const entry = {
        ts,
        level,
        category,
        msg: cap(message, MAX_STRING_LENGTH),
        ...sanitizeMeta(meta),
    };
    try {
        fs.appendFileSync(entryFile(today()), JSON.stringify(entry) + '\n');
    } catch (err) {
        console.error('[logger] failed to write log entry:', err.message);
    }
    if (entry.level === 'error') {
        const file = entryFile(today()).replace(/\.ndjson$/, '-errors.ndjson');
        try {
            fs.appendFileSync(file, JSON.stringify(entry) + '\n');
        } catch (err) {
            console.error('[logger] failed to write error log entry:', err.message);
        }
    }
    return entry;
}

function info(category, message, meta) {
    return write('info', category, message, meta);
}

function warn(category, message, meta) {
    return write('warn', category, message, meta);
}

function error(category, message, meta) {
    return write('error', category, message, meta);
}

function http(req, res, status, durationMs, extra) {
    const meta = {
        method: (req && req.method) || '',
        path: (req && req.path) || '',
        status: status !== undefined ? status : (res && res.statusCode),
        durationMs,
        ip: (req && req.ip) || (req && req.connection && req.connection.remoteAddress),
        ua: (req && req.headers && req.headers['user-agent']) || '',
        ...extra,
    };
    const level = status && status >= 500 ? 'error' : status && status >= 400 ? 'warn' : 'info';
    return write(level, 'request', `${meta.method} ${meta.path} ${meta.status} (${durationMs}ms)`, meta);
}

function truncateStderr(text) {
    return cap(String(text), MAX_STDERR_LENGTH);
}

const FILES_CACHE = {};

function listDailyFiles() {
    if (FILES_CACHE.list) return FILES_CACHE.list;
    const files = fs.readdirSync(LOG_DIR)
        .filter(f => /^events-(\d{4}-\d{2}-\d{2})\.ndjson$/.test(f))
        .sort();
    FILES_CACHE.list = files;
    return files;
}

function clearDailyCache() {
    delete FILES_CACHE.list;
}

function readEntries(opts) {
    const files = listDailyFiles();
    const entries = [];
    const maxTail = opts.tail || 0;

    for (let i = files.length - 1; i >= 0; i--) {
        const file = path.join(LOG_DIR, files[i]);
        let raw;
        try {
            raw = fs.readFileSync(file, 'utf8');
        } catch (err) {
            continue;
        }
        const lines = raw.split('\n').filter(Boolean);
        for (let j = lines.length - 1; j >= 0; j--) {
            let entry;
            try {
                entry = JSON.parse(lines[j]);
            } catch (err) {
                continue;
            }
            if (opts.level && entry.level !== opts.level) continue;
            if (opts.minLevel) {
                const idx = LEVELS.indexOf(entry.level);
                const minIdx = LEVELS.indexOf(opts.minLevel);
                if (idx < minIdx) continue;
            }
            if (opts.category && entry.category !== opts.category) continue;
            if (opts.since && entry.ts < opts.since) continue;
            if (opts.grep && !(JSON.stringify(entry).toLowerCase().includes(opts.grep.toLowerCase()))) continue;
            entries.push(entry);
            if (maxTail && entries.length >= maxTail) return entries;
        }
        if (maxTail && entries.length >= maxTail) return entries;
    }
    return entries;
}

function errorSummary(opts) {
    const entries = readEntries({ minLevel: 'warn', tail: 0 });
    const buckets = new Map();
    for (const entry of entries) {
        const key = `${entry.level}:${entry.category}:${entry.msg}`;
        if (!buckets.has(key)) {
            buckets.set(key, { level: entry.level, category: entry.category, msg: entry.msg, count: 0, first: entry.ts, last: entry.ts });
        }
        const bucket = buckets.get(key);
        bucket.count++;
        bucket.last = entry.ts;
    }
    const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
    if (opts.top) return sorted.slice(0, opts.top);
    return sorted;
}

function runCli(argv) {
    const usage = `Structured log tools
Usage: node back/logger.js [command]

Commands:
  tail  [--tail N]       show last N entries (default 50)
        [--level LEVEL]  filter: info|warn|error
        [--min-level L]  minimum level
        [--category C]   filter by category (request|video-info|stream|qoe|proxy|system)
        [--grep TEXT]    substring filter over the whole entry
        [--since ISO]    only entries with ts >= ISO
  errors [--top N]       error/warn summary grouped by category+message
  help`;
    const cmd = argv[2] || 'help';
    const opts = {};
    for (let i = 3; i < argv.length; i++) {
        const flag = argv[i];
        const readNext = () => {
            const v = argv[++i];
            if (v === undefined) throw new Error(`missing value for ${flag}`);
            return v;
        };
        if (flag === '--tail') opts.tail = parseInt(readNext(), 10);
        else if (flag === '--level') opts.level = readNext();
        else if (flag === '--min-level') opts.minLevel = readNext();
        else if (flag === '--category') opts.category = readNext();
        else if (flag === '--grep') opts.grep = readNext();
        else if (flag === '--since') opts.since = readNext();
        else if (flag === '--top') opts.top = parseInt(readNext(), 10);
        else throw new Error(`unknown flag ${flag}`);
    }

    if (cmd === 'tail') {
        opts.tail = opts.tail || 50;
        for (const entry of readEntries(opts)) {
            const meta = JSON.stringify(entry).slice(1, -1);
            console.log(meta);
        }
    } else if (cmd === 'errors') {
        const rows = errorSummary({ top: opts.top || 20 });
        console.log('count  level  category  message');
        console.log('-----  -----  --------  -------');
        rows.forEach(r => console.log(`${String(r.count).padStart(5)}  ${r.level.padEnd(5)}  ${r.category.padEnd(10)}  ${r.msg}`));
    } else {
        console.log(usage);
    }
}

module.exports = {
    LOG_DIR,
    write,
    info,
    warn,
    error,
    http,
    truncateStderr,
    readEntries,
    errorSummary,
    listDailyFiles,
    levels: LEVELS,
};

if (require.main === module) {
    try {
        runCli(process.argv);
    } catch (err) {
        console.error('[logger] CLI error:', err.message);
        process.exit(1);
    }
}
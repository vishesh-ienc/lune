#!/usr/bin/env node
'use strict';
const { execSync } = require('child_process');

const USER_DATA_DIR = 'C:\\Users\\VISHESH\\AppData\\Roaming\\Antigravity IDE';

function splitCsvLine(line) {
  const result = []; let current = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += ch; }
  }
  result.push(current); return result;
}

const psCmd = [
  'Get-CimInstance Win32_Process',
  '| Select-Object ProcessId,Name,CommandLine',
  '| ConvertTo-Csv -NoTypeInformation',
].join(' ');

const raw = execSync(
  `powershell -NoProfile -NonInteractive -Command "${psCmd}"`,
  { encoding: 'utf8', windowsHide: true, maxBuffer: 50 * 1024 * 1024 }
);

const lines = raw.split(/\r?\n/).filter(Boolean);
const headers = splitCsvLine(lines[0]).map(h => h.replace(/"/g, '').trim().toLowerCase());
const idxPid  = headers.indexOf('processid');
const idxName = headers.indexOf('name');
const idxCmd  = headers.indexOf('commandline');

const entries = [];
for (let i = 1; i < lines.length; i++) {
  const cols = splitCsvLine(lines[i]);
  if (cols.length <= Math.max(idxPid, idxName, idxCmd)) continue;
  const pid         = (cols[idxPid]  || '').replace(/"/g, '').trim();
  const name        = (cols[idxName] || '').replace(/"/g, '').trim();
  const commandLine = (cols[idxCmd]  || '').replace(/^"|"$/g, '').trim();
  if (!pid || !/^\d+$/.test(pid)) continue;
  entries.push({ pid, name, commandLine });
}

// Filter: all processes referencing the profile directory
const procs = entries.filter(e =>
  e.commandLine.toLowerCase().includes(USER_DATA_DIR.toLowerCase())
);

console.log(`Total profile processes: ${procs.length}\n`);

procs.forEach(p => {
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`PID  : ${p.pid}`);
  console.log(`Name : ${p.name}`);
  console.log(`CMD  :`);
  // Print word-wrapped at 120 chars with indentation
  const WRAP = 120;
  const IND  = '       ';
  let line = IND;
  for (const tok of p.commandLine.split(' ')) {
    if (line.length + tok.length + 1 > WRAP && line.trim().length > 0) {
      console.log(line); line = IND;
    }
    line += (line.trim().length > 0 ? ' ' : '') + tok;
  }
  if (line.trim().length > 0) console.log(line);
  // Raw untruncated to stderr
  process.stderr.write(`\n[RAW pid=${p.pid}]\n${p.commandLine}\n`);
});

const fs = require('fs');
const file = 'C:\\\\Users\\\\VISHESH\\\\Desktop\\\\lune\\\\index.html';
let content = fs.readFileSync(file, 'utf8');

// Replace backgrounds
content = content.replace(/#11131A/gi, '#09090b');
content = content.replace(/#181B25/gi, '#18181b');
content = content.replace(/#141620/gi, '#18181b');
content = content.replace(/#1D202C/gi, '#27272a');

// Replace borders
content = content.replace(/#262A38/gi, '#27272a');
content = content.replace(/#3A3F52/gi, '#3f3f46');
content = content.replace(/#2F3447/gi, '#3f3f46');

// Replace Text
content = content.replace(/#E8E9EE/gi, '#e4e4e7');
content = content.replace(/#9298A8/gi, '#a1a1aa');
content = content.replace(/#5A6072/gi, '#71717a');

// Replace Accents (Indigo)
content = content.replace(/#7FB8A8/gi, '#818cf8');
content = content.replace(/#4FD9BC/gi, '#818cf8');
content = content.replace(/#5AB0C8/gi, '#a78bfa');
content = content.replace(/#A9D4C6/gi, '#a5b4fc');
content = content.replace(/#92D4C2/gi, '#a5b4fc');

// Replace rgba accents
content = content.replace(/rgba\(\s*127,\s*184,\s*168/gi, 'rgba(129, 140, 248');
content = content.replace(/rgba\(\s*79,\s*217,\s*188/gi, 'rgba(129, 140, 248');
content = content.replace(/rgba\(\s*90,\s*176,\s*200/gi, 'rgba(167, 139, 250');

// Replace Traffic Lights (Green)
content = content.replace(/#22C55E/gi, '#34d399');
content = content.replace(/rgba\(\s*34,\s*197,\s*94/gi, 'rgba(52, 211, 153');

// Replace Traffic Lights (Warn)
content = content.replace(/#EAB308/gi, '#fbbf24');
content = content.replace(/#F2B84D/gi, '#fbbf24');
content = content.replace(/#D9A662/gi, '#fbbf24');
content = content.replace(/rgba\(\s*234,\s*179,\s*8/gi, 'rgba(251, 191, 36');
content = content.replace(/rgba\(\s*217,\s*166,\s*98/gi, 'rgba(251, 191, 36');
content = content.replace(/rgba\(\s*242,\s*184,\s*77/gi, 'rgba(251, 191, 36');

// Replace Traffic Lights (Critical)
content = content.replace(/#EF4444/gi, '#f87171');
content = content.replace(/#F27878/gi, '#f87171');
content = content.replace(/#CE8484/gi, '#f87171');
content = content.replace(/rgba\(\s*239,\s*68,\s*68/gi, 'rgba(248, 113, 113');
content = content.replace(/rgba\(\s*206,\s*132,\s*132/gi, 'rgba(248, 113, 113');
content = content.replace(/rgba\(\s*242,\s*120,\s*120/gi, 'rgba(248, 113, 113');

// Same delta tag
content = content.replace(/rgba\(\s*90,\s*96,\s*114/gi, 'rgba(113, 113, 122');

// Special fix for .quota-bar-fill box shadows
content = content.replace(/\.quota-bar-fill\.healthy\s*\{\s*background:\s*#[a-fA-F0-9]{6};\s*box-shadow:[^}]+\}/g, '.quota-bar-fill.healthy  { background: #34d399; }');
content = content.replace(/\.quota-bar-fill\.warn\s*\{\s*background:\s*#[a-fA-F0-9]{6};\s*box-shadow:[^}]+\}/g, '.quota-bar-fill.warn     { background: #fbbf24; }');
content = content.replace(/\.quota-bar-fill\.critical\s*\{\s*background:\s*#[a-fA-F0-9]{6};\s*box-shadow:[^}]+\}/g, '.quota-bar-fill.critical { background: #f87171; }');

// Special fix for .sidebar-logo
const newLogo = `.sidebar-logo {
  width: 36px;
  height: 36px;
  background: #27272a;
  border: 1px solid #3f3f46;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 20px;
  flex-shrink: 0;
  transition: background .15s, border-color .15s;
}
.sidebar-logo:hover { background: #3f3f46; border-color: #71717a; }`;
content = content.replace(/\.sidebar-logo\s*\{[^}]+\}\s*\.sidebar-logo:hover\s*\{[^}]+\}/, newLogo);

fs.writeFileSync(file, content, 'utf8');
console.log('Colors replaced successfully.');

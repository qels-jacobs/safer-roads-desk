// "Parse, Ground & Normalise" (Run Once for All Items)
// Parses the LLM extraction, checks every extracted value against the source email (grounding),
// normalises contacts, and maps road names (incl. Afrikaans/abbreviations) onto the road register.
const emails = $('Prepare Emails').all().map(i => i.json);
const ref = Object.fromEntries($('Fetch Reference Data').all().map((r, i) => [$('Reference Files').all()[i].json.name, r.json.data]));

function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.some(x => x.trim()));
  return body.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] || '').trim()])));
}
const roads = parseCsv(ref.road_register);
const rules = JSON.parse(ref.hazard_rules).hazard_types;
const CODES = new Set(rules.map(r => r.hazard_code));

// "Voortrekkerweg" -> "voortrekker road", "Durban Rd" -> "durban road", "Jan Smutsrylaan" -> "jan smuts drive"
function canonRoad(s) {
  if (!s) return '';
  let x = String(s).toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  x = x.replace(/(\S)(weg|straat|rylaan|laan)$/, '$1 $2');
  const SUF = { rd: 'road', road: 'road', weg: 'road', st: 'street', str: 'street', street: 'street', straat: 'street',
                dr: 'drive', drive: 'drive', rylaan: 'drive', ave: 'avenue', avenue: 'avenue', laan: 'avenue' };
  const parts = x.split(' ');
  const last = parts[parts.length - 1];
  if (SUF[last]) parts[parts.length - 1] = SUF[last];
  return parts.join(' ').replace(/^the /, '');
}
const regNames = [...new Set(roads.map(r => r.road_name))];
function matchRegister(name) {
  const c = canonRoad(name);
  if (!c) return null;
  const exact = regNames.find(r => r.toLowerCase() === c);
  if (exact) return exact;
  const stem = c.replace(/ (road|street|drive|avenue)$/, '');
  return regNames.find(r => r.toLowerCase().replace(/ (road|street|drive|avenue)$/, '') === stem) || null;
}
const titleCase = s => s.replace(/\b([a-z])/g, m => m.toUpperCase());
const digits = s => String(s || '').replace(/\D/g, '');
function normPhone(raw, log) {
  if (!raw) return '';
  let d = String(raw).replace(/\(0\)/g, '').replace(/\D/g, '');
  if (d.startsWith('0') && d.length === 10) d = '27' + d.slice(1);
  if (d.startsWith('270') && d.length === 12) d = '27' + d.slice(3);
  if (/^27\d{9}$/.test(d)) { if ('+' + d !== raw) log.push(`phone "${raw}" -> +${d}`); return '+' + d; }
  log.push(`phone "${raw}" is not a valid SA number - kept for review`); return String(raw);
}
const strip = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const out = [];
$input.all().forEach((item, idx) => {
  const src = emails[idx] || {};
  const base = { email_id: src.email_id, subject: src.subject, received: src.received, log: [], flags: [] };
  let x;
  try { x = JSON.parse(String(item.json.text).replace(/```json|```/g, '').trim()); }
  catch (e) { out.push({ json: { ...base, kind: 'parse_error', geocode_query: '', flags: ['LLM output was not valid JSON - needs manual review'] } }); return; }
  if (!x.is_road_report) { out.push({ json: { ...base, kind: 'not_road_report', reason: x.reason || '', geocode_query: '' } }); return; }

  const text = strip(`${src.subject} ${src.body}`);
  const log = base.log, flags = base.flags;
  // --- grounding: anything the model claims must be traceable to the email text
  const loc = x.location || {}, res = x.resident || {};
  for (const [k, v] of [['road', loc.road], ['cross_street', loc.cross_street], ['suburb', loc.suburb]]) {
    if (!v) continue;
    const stem = strip(v).replace(/\b(road|rd|street|st|drive|dr|weg|straat|rylaan|avenue|ave)\b/g, '').trim().split(' ')[0];
    if (stem && !text.includes(stem)) { log.push(`LLM ${k} "${v}" not found in email - discarded`); loc[k] = ''; }
  }
  if (res.email && !text.includes(strip(res.email))) { log.push(`LLM email "${res.email}" not in source - discarded`); res.email = ''; }
  if (res.phone && !digits(text).includes(digits(res.phone).slice(-7))) { log.push(`LLM phone "${res.phone}" not in source - discarded`); res.phone = ''; }
  if (loc.house_number && !text.includes(String(loc.house_number))) { log.push(`house number "${loc.house_number}" not in source - discarded`); loc.house_number = ''; }
  let code = x.hazard_code;
  if (!CODES.has(code)) { flags.push(`unknown hazard type "${code}" - set to road_obstruction for review`); code = 'road_obstruction'; }

  // --- road names onto the register
  const road = matchRegister(loc.road), cross = matchRegister(loc.cross_street);
  if (road && road.toLowerCase() !== strip(loc.road)) log.push(`road "${loc.road}" -> "${road}"`);
  if (cross && cross.toLowerCase() !== strip(loc.cross_street)) log.push(`cross street "${loc.cross_street}" -> "${cross}"`);
  const roadName = road || (loc.road ? titleCase(canonRoad(loc.road)) : '');
  const crossName = cross || (loc.cross_street ? titleCase(canonRoad(loc.cross_street)) : '');
  const suburb = loc.suburb ? titleCase(String(loc.suburb).toLowerCase().trim()) : '';
  if (!roadName) flags.push('no usable street name in report');

  const email = (res.email || '').trim().toLowerCase();
  const geocode_query = roadName ? [loc.house_number, roadName].filter(Boolean).join(' ') + `, ${suburb ? suburb + ', ' : ''}Cape Town, South Africa` : '';
  out.push({ json: { ...base, kind: 'report', language: x.language || 'English', hazard_code: code,
    hazard_summary_en: x.hazard_summary_en || '', road: roadName, road_in_register: !!road, cross_street: crossName,
    house_number: loc.house_number || '', landmark: loc.landmark || '', suburb_reported: suburb,
    resident: { name: res.name ? titleCase(String(res.name).toLowerCase()) : '', email, phone: normPhone(res.phone, log) },
    danger_signals: x.danger_signals || [], geocode_query } });
});
return out;

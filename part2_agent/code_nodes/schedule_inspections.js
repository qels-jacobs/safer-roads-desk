// "Schedule Inspections" (Run Once for All Items)
// Reads inspectors' existing calendar events (busy blocks + already-booked cases) and books the earliest free
// 1-hour slot per case, in priority order, inside Mon-Fri 08:00-16:00 SAST. Idempotent: a case that already has
// an event is not booked twice.
const cases = $('Verify, Dedupe & Score').all().map(i => i.json);
const events = $('Read Inspector Calendar').all().map(i => i.json).filter(e => e.summary && e.start);
const OFF = 2 * 3600e3; // SAST = UTC+2, no daylight saving
const sast = ms => new Date(ms + OFF);
const iso = ms => { const d = sast(ms); return d.toISOString().slice(0, 19) + '+02:00'; };
const pretty = ms => { const d = sast(ms); return `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()]} ${d.getUTCDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2,'0')}:00`; };
const t = e => Date.parse(e.dateTime || e.date);

const busy = {};   // inspector -> [[start,end]]
const booked = {}; // case_id -> event
for (const e of events) {
  const m = e.summary.match(/\[(INS-\d+)\]/);
  if (m) (busy[m[1]] ||= []).push([t(e.start), t(e.end)]);
  const c = e.summary.match(/SRD-[0-9A-Z]{6}/);
  if (c) booked[c[0]] = e;
}
function nextSlot(ins, fromMs) {
  let d = sast(fromMs); d.setUTCMinutes(0, 0, 0);
  let ms = d.getTime() - OFF + 3600e3; // next full hour
  for (let k = 0; k < 24 * 10; k++, ms += 3600e3) {
    const s = sast(ms), h = s.getUTCHours(), wd = s.getUTCDay();
    if (wd === 0 || wd === 6 || h < 8 || h > 15) continue;
    const clash = (busy[ins] || []).some(([a, b]) => ms < b && ms + 3600e3 > a);
    if (!clash) return ms;
  }
  return null;
}
const COLOR = { P1: '11', P2: '6', P3: '9' };
const now = Date.now();
return cases.map(c => {
  const out = { ...c, inspection_start: '', start_iso: '', end_iso: '', calendar_action: 'none', schedule_note: '' };
  if (!c.inspection_required || !c.inspector_id) { out.schedule_note = c.inspection_required ? 'no inspector for area' : 'no inspection needed'; return { json: out }; }
  const existing = booked[c.case_id];
  if (existing) {
    const s = t(existing.start);
    Object.assign(out, { inspection_start: pretty(s), start_iso: iso(s), end_iso: iso(t(existing.end)), calendar_action: 'exists',
                         schedule_note: 'already booked in a previous run - not double-booked' });
    return { json: out };
  }
  const s = nextSlot(c.inspector_id, now);
  if (s === null) { out.schedule_note = 'no free slot in the next 10 days'; out.flags = [c.flags, 'no inspector slot available'].filter(Boolean).join(' | '); return { json: out }; }
  (busy[c.inspector_id] ||= []).push([s, s + 3600e3]);
  const late = s > Date.parse(c.due_by);
  Object.assign(out, {
    inspection_start: pretty(s), start_iso: iso(s), end_iso: iso(s + 3600e3), calendar_action: 'create',
    schedule_note: late ? `earliest slot is after the ${c.band} deadline - escalate to standby inspector` : 'within deadline',
    event_summary: `[${c.inspector_id}] ${c.band} inspect: ${c.hazard_label.split(' or ')[0]} - ${c.location_text} (${c.case_id})`,
    event_description: [`Case ${c.case_id} · ${c.priority} · risk score ${c.risk_score}`, `Score: ${c.score_breakdown}`,
      c.priority_reason && `Why: ${c.priority_reason}`, `Reports: ${c.reports} (${c.languages})`, `Summary: ${c.summary_en}`,
      c.hotspot_id && `Crash hotspot: ${c.hotspot_id} (${c.hotspot_match})`, `Due by: ${pretty(Date.parse(c.due_by))}`,
      c.lat && `Map: https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lon}#map=18/${c.lat}/${c.lon}`,
      c.flags && `Flags: ${c.flags}`].filter(Boolean).join('\n'),
    event_color: COLOR[c.band] || '8',
  });
  if (late) out.flags = [c.flags, 'inspection slot later than deadline'].filter(Boolean).join(' | ');
  return { json: out };
});

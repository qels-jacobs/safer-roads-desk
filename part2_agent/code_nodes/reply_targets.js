// "Reply Targets": one acknowledgement per resident not yet replied to (state read from the sheet).
const cfg = $('Config').first().json;
const prev = new Set($('Read Existing Cases').all().map(i => i.json).filter(r => r.case_id)
  .flatMap(r => String(r.replied_email_ids || '').split(';')).filter(Boolean));
const out = [];
for (const { json: c } of $('Schedule Inspections').all()) {
  for (const r of c.residents) {
    if (prev.has(r.email_id) || !r.email) continue;
    const kind = c.band === 'INCOMPLETE' ? 'need_location' : c.band === 'REFERRED' ? 'referred' : 'acknowledge';
    out.push({ json: {
      kind, case_id: c.case_id, language: r.language || 'English', resident_name: r.name, resident_email: r.email,
      hazard: c.hazard_label, location: c.location_text, priority: c.priority, inspection: c.inspection_start, due_by: c.due_by,
      send_to: String(cfg.demo_mode) === 'true' ? cfg.report_to : r.email,
      subject: `[Safer Roads Desk] Ref ${c.case_id}` + (String(cfg.demo_mode) === 'true' ? ` (demo: would go to ${r.email})` : ''),
    } });
  }
}
return out.length ? out : [{ json: { kind: 'none' } }];

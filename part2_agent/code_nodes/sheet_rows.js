// "Sheet Rows": flatten cases for the Command Centre Google Sheet (one row per case, upserted on case_id).
const prev = Object.fromEntries($('Read Existing Cases').all().map(i => i.json).filter(r => r.case_id)
  .map(r => [r.case_id, String(r.replied_email_ids || '')]));
return $('Schedule Inspections').all().map(({ json: c }) => {
  const replied = new Set(String(prev[c.case_id] || '').split(';').filter(Boolean));
  c.residents.filter(r => r.email || c.band === 'INCOMPLETE').forEach(r => replied.add(r.email_id));
  return { json: {
    case_id: c.case_id, priority: c.priority, risk_score: c.risk_score, score_breakdown: c.score_breakdown,
    priority_reason: c.priority_reason, hazard_code: c.hazard_code, hazard_label: c.hazard_label, department: c.department,
    location_text: c.location_text, road: c.road, cross_street: c.cross_street, suburb: c.suburb, area: c.area,
    lat: c.lat, lon: c.lon, geocode_status: c.geocode_status, hotspot_id: c.hotspot_id, reports: c.reports,
    languages: c.languages, inspector: c.inspector, inspection_start: c.inspection_start, schedule_note: c.schedule_note,
    first_reported: c.first_reported, due_by: c.due_by, flags: c.flags, corrections: c.corrections, sources: c.sources,
    residents: c.residents.map(r => `${r.name || '?'} <${r.email || 'no email'}>`).join('; '),
    replied_email_ids: [...replied].join(';'), updated_at: new Date().toISOString(),
  } };
});

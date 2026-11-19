// "Build Report": HTML dashboard email + CSV attachment (binary from "Convert to CSV").
const cfg = $('Config').first().json;
const cases = $('Schedule Inspections').all().map(i => i.json);
const skipped = $('Verify, Dedupe & Score').first().json._skipped || [];
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const C = { P1: '#dc2626', P2: '#d97706', P3: '#2563eb', REFERRED: '#6b7280', INCOMPLETE: '#9333ea' };
const n = b => cases.filter(c => c.band === b).length;
const reports = cases.reduce((s, c) => s + c.reports, 0);
const tile = (label, v, col) => `<td style="padding:10px 16px;border:1px solid #e5e7eb;text-align:center"><div style="font-size:22px;font-weight:bold;color:${col}">${v}</div><div style="font-size:11px;color:#6b7280">${label}</div></td>`;
const rows = cases.map(c => `<tr>
<td><span style="background:${C[c.band]};color:#fff;padding:2px 6px;border-radius:4px;font-size:11px">${esc(c.priority)}</span><br><span style="font-size:11px">${c.case_id}</span></td>
<td><b>${esc(c.hazard_label)}</b><br>${esc(c.location_text)}${c.hotspot_id ? `<br><span style="color:#dc2626">⚠ crash hotspot ${c.hotspot_id}</span>` : ''}</td>
<td style="text-align:center">${c.risk_score}</td><td style="text-align:center">${c.reports}<br><span style="font-size:10px">${esc(c.languages)}</span></td>
<td>${esc(c.inspector)}<br>${esc(c.inspection_start || c.schedule_note)}</td>
<td style="font-size:11px">${esc(c.score_breakdown)}${c.priority_reason ? '<br><i>' + esc(c.priority_reason) + '</i>' : ''}</td>
<td style="font-size:11px;color:#b45309">${esc(c.flags)}</td></tr>`).join('\n');
const html = `<div style="font-family:Arial,sans-serif;max-width:1100px">
<h2 style="margin-bottom:4px">🚦 Safer Roads Desk: hazard run report</h2>
<div style="color:#6b7280;font-size:12px">${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · synthetic demo data</div>
<table style="border-collapse:collapse;margin:14px 0"><tr>${tile('Emails read', reports + skipped.length, '#111')}${tile('Unique hazards', cases.length, '#111')}
${tile('Duplicates merged', reports - cases.length, '#111')}${tile('P1 urgent', n('P1'), C.P1)}${tile('P2 high', n('P2'), C.P2)}${tile('P3 routine', n('P3'), C.P3)}
${tile('Referred', n('REFERRED'), C.REFERRED)}${tile('Incomplete', n('INCOMPLETE'), C.INCOMPLETE)}</tr></table>
${cfg.command_centre_url ? `<p><a href="${cfg.command_centre_url}">Open the live Command Centre map →</a></p>` : ''}
<table border="1" cellpadding="6" style="border-collapse:collapse;font-size:12px;border-color:#e5e7eb">
<tr style="background:#f3f4f6"><th>Priority</th><th>Hazard & location</th><th>Risk</th><th>Reports</th><th>Inspection</th><th>Why this score</th><th>Flags</th></tr>
${rows}</table>
${skipped.length ? `<p style="font-size:12px;color:#6b7280">Not processed as road hazards: ${skipped.map(s => esc(`"${s.subject}" (${s.kind}${s.reason ? ': ' + s.reason : ''})`)).join('; ')}</p>` : ''}
<p style="font-size:11px;color:#9ca3af">Every value extracted by the AI was checked against the source email; full audit trail in the attached CSV ("corrections" column).</p></div>`;
return [{ json: { subject: `[Safer Roads Desk] Run report: ${n('P1')} urgent, ${cases.length} hazards`, html }, binary: $input.first().binary }];

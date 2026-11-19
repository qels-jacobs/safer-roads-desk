// "Verify, Dedupe & Score" (Run Once for All Items)
// $input = Nominatim responses, index-aligned with "Parse, Ground & Normalise".
const items = $('Parse, Ground & Normalise').all().map(i => i.json);
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
const roads = parseCsv(ref.road_register), hotspots = parseCsv(ref.hotspots), inspectors = parseCsv(ref.inspectors);
const rulesDoc = JSON.parse(ref.hazard_rules);
const rule = Object.fromEntries(rulesDoc.hazard_types.map(r => [r.hazard_code, r]));
const low = s => String(s || '').toLowerCase().trim();
const suburbArea = {};
inspectors.forEach(ins => ins.suburbs.split(';').forEach(s => { suburbArea[low(s)] = ins.area; }));
const toRad = d => d * Math.PI / 180;
const distM = (a, b, c, d) => { const R = 6371000, x = toRad(c - a), y = toRad(d - b);
  const h = Math.sin(x / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(y / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const hash = s => { let h = 5381; for (const ch of s) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0; return h.toString(36).toUpperCase().slice(0, 6).padStart(6, '0'); };

const reports = [], other = [];
items.forEach((it, i) => {
  if (it.kind !== 'report') { other.push(it); return; }
  // ---- 1. map verification (OpenStreetMap / Nominatim)
  let geo = null;
  try { const g = JSON.parse($input.all()[i]?.json?.geo_raw || '[]'); geo = Array.isArray(g) && g.length ? g[0] : null; } catch (e) { geo = null; }
  it.geo = { status: 'not_found' };
  if (it.geocode_query && geo) {
    const a = geo.address || {};
    const osmRoad = a.road || a.pedestrian || '';
    const osmSuburb = a.suburb || a.neighbourhood || a.quarter || a.city_district || a.town || '';
    const roadOk = low(osmRoad).replace(/ (road|street|drive|avenue)$/, '') === low(it.road).replace(/ (road|street|drive|avenue)$/, '');
    it.geo = { status: roadOk ? 'verified' : 'partial', lat: +geo.lat, lon: +geo.lon, osm_road: osmRoad, osm_suburb: osmSuburb,
               precision: geo.addresstype || geo.type, display: geo.display_name };
    if (!roadOk) it.flags.push(`map lookup returned "${osmRoad || geo.display_name}" not "${it.road}" - location needs checking`);
    if (it.suburb_reported && osmSuburb && low(osmSuburb) !== low(it.suburb_reported) && !suburbArea[low(it.suburb_reported)])
      it.flags.push(`resident said "${it.suburb_reported}", map says "${osmSuburb}"`);
  } else if (it.geocode_query) it.flags.push('address could not be verified on the map');

  // ---- 2. area, road segment, hotspot
  const suburb = it.geo.osm_suburb || it.suburb_reported;
  const segs = roads.filter(r => low(r.road_name) === low(it.road));
  let seg = segs.find(r => r.suburbs.split(';').some(s => low(s) === low(suburb))) || (segs.length === 1 ? segs[0] : null);
  let area = suburbArea[low(suburb)] || seg?.area || '';
  if (!seg && segs.length > 1 && area) seg = segs.find(r => r.area === area);
  const crossSeg = roads.find(r => low(r.road_name) === low(it.cross_street) && (!area || r.area === area));
  const pair = [low(it.road), low(it.cross_street)].sort().join('|');
  let hs = hotspots.find(h => [low(h.road_a), low(h.road_b)].sort().join('|') === pair && (!area || h.area === area));
  let hsHow = hs ? 'intersection match' : '';
  if (!hs && it.geo.lat) {
    const near = hotspots.map(h => [h, distM(it.geo.lat, it.geo.lon, +h.lat, +h.lon)]).sort((a, b) => a[1] - b[1])[0];
    if (near && near[1] <= 200 && [low(near[0].road_a), low(near[0].road_b)].includes(low(it.road))) { hs = near[0]; hsHow = `within ${Math.round(near[1])} m`; }
  }
  if (!area && hs) area = hs.area;
  if (!seg && it.road) it.flags.push(`"${it.road}" not in road register - defaults used (local road, 60 km/h, medium pedestrian volume)`);
  if (!area) it.flags.push('could not determine area / inspector');
  Object.assign(it, { area, suburb, seg, crossSeg, hs, hsHow,
    lat: hs ? +hs.lat : it.geo.lat, lon: hs ? +hs.lon : it.geo.lon });
  reports.push(it);
});

// ---- 3. deduplicate: same hazard + same place (intersection pair, house number, or <=120 m)
const placeKey = r => r.cross_street ? [low(r.road), low(r.cross_street)].sort().join('&') : `${low(r.road)}#${r.house_number || low(r.landmark) || ''}`;
const clusters = [];
for (const r of reports.filter(r => r.road)) {
  const c = clusters.find(c => c.hazard_code === r.hazard_code && (c.key === placeKey(r) ||
    (c.lat && r.lat && distM(c.lat, c.lon, r.lat, r.lon) <= 120 && low(c.reports[0].road) === low(r.road))));
  if (c) c.reports.push(r); else clusters.push({ hazard_code: r.hazard_code, key: placeKey(r), lat: r.lat, lon: r.lon, reports: [r] });
}
reports.filter(r => !r.road).forEach(r => clusters.push({ hazard_code: r.hazard_code, key: `nolocation#${r.email_id}`, reports: [r], incomplete: true }));

// ---- 4. risk score (formula published in hazard_response_rules.json)
const PED = { High: 1.5, Medium: 1.2, Low: 1.0 };
const now = Date.now();
const cases = clusters.map(c => {
  const r0 = c.reports.find(r => r.geo.status === 'verified') || c.reports.slice().sort((a, b) => a.received.localeCompare(b.received))[0];
  const rl = rule[c.hazard_code], seg = r0.seg, cs = r0.crossSeg, hs = r0.hs;
  const n = c.reports.length;
  let flags = [...new Set(c.reports.flatMap(r => r.flags))];
  if (c.reports.some(r => r.geo.status === 'verified')) flags = flags.filter(f => f !== 'address could not be verified on the map');
  const log = c.reports.flatMap(r => r.log.map(l => `${r.email_id}: ${l}`));
  if (n > 1) log.push(`merged ${n} reports of the same hazard (${c.reports.map(r => r.language).join(', ')})`);
  const speed = Math.max(+(seg?.speed_limit_kmh || 60), +(cs?.speed_limit_kmh || 0));
  const pedVol = [seg?.pedestrian_volume, cs?.pedestrian_volume].includes('High') ? 'High' : [seg?.pedestrian_volume, cs?.pedestrian_volume].includes('Medium') || !seg ? 'Medium' : 'Low';
  const fs = Math.round(speed / 60 * 100) / 100, fp = PED[pedVol];
  const fh = hs ? Math.min(3, Math.round((1 + 0.2 * +hs.fatal + 0.05 * +hs.serious) * 100) / 100) : 1;
  const fr = Math.min(1.5, Math.round((1 + 0.1 * (n - 1)) * 100) / 100);
  const score = Math.round(rl.severity * fs * fp * fh * fr * 10) / 10;
  const breakdown = `${rl.severity} severity (${c.hazard_code}) × ${fs} speed (${speed} km/h) × ${fp} pedestrians (${pedVol}) × ${fh} hotspot` +
    (hs ? ` (${hs.hotspot_id}: ${hs.fatal} fatal, ${hs.serious} serious)` : ' (none)') + ` × ${fr} reports (${n}) = ${score}`;
  let band = score >= 12 ? 'P1' : score >= 6 ? 'P2' : 'P3';
  const why = [];
  if (c.hazard_code === 'traffic_signal_outage' && hs && band !== 'P1') { band = 'P1'; why.push('override: signal outage at a hotspot is always P1'); }
  const national = [seg?.jurisdiction, cs?.jurisdiction].some(j => String(j || '').startsWith('National'));
  if (national) { band = 'REFERRED'; why.push('national road - referred to SANRAL'); }
  if (c.incomplete) { band = 'INCOMPLETE'; why.push('no location - resident asked for details'); }
  const capH = band === 'P1' ? 4 : band === 'P2' ? Math.min(48, rl.repair_deadline_hours) : rl.repair_deadline_hours;
  const first = Math.min(...c.reports.map(r => Date.parse(r.received) || now));
  const label = { P1: 'P1 - Urgent', P2: 'P2 - High', P3: 'P3 - Routine', REFERRED: 'REFERRED - SANRAL', INCOMPLETE: 'INCOMPLETE - needs location' }[band];
  const ins = inspectors.find(i => i.area === r0.area);
  const where = r0.road ? (r0.cross_street ? `${r0.road} & ${r0.cross_street}` : `${r0.house_number ? r0.house_number + ' ' : ''}${r0.road}${r0.landmark ? ' (' + r0.landmark + ')' : ''}`) + (r0.suburb ? `, ${r0.suburb}` : '') : 'Location not provided';
  return {
    case_id: 'SRD-' + hash(`${c.hazard_code}|${c.key}`), priority: label, band, risk_score: band === 'INCOMPLETE' ? 0 : score, score_breakdown: band === 'INCOMPLETE' ? 'not scored - location missing' : breakdown,
    priority_reason: why.join('; '), hazard_code: c.hazard_code, hazard_label: rl.description, department: national ? 'SANRAL (referral)' : rl.department,
    inspection_required: !national && !c.incomplete && (rl.inspection_required === true || band === 'P1' || band === 'P2'),
    location_text: where, road: r0.road, cross_street: r0.cross_street, suburb: r0.suburb, area: r0.area,
    lat: r0.lat ?? '', lon: r0.lon ?? '', geocode_status: r0.geo.status, hotspot_id: hs?.hotspot_id || '', hotspot_match: r0.hsHow,
    reports: n, languages: [...new Set(c.reports.map(r => r.language))].join(', '),
    first_reported: new Date(first).toISOString(), due_by: new Date(Math.max(first, now) + capH * 3600e3).toISOString(),
    inspector_id: ins?.inspector_id || '', inspector: ins?.name || '',
    residents: c.reports.map(r => ({ email_id: r.email_id, name: r.resident.name, email: r.resident.email, phone: r.resident.phone, language: r.language })),
    summary_en: r0.hazard_summary_en, danger_signals: [...new Set(c.reports.flatMap(r => r.danger_signals || []))].join('; '),
    flags: flags.join(' | '), corrections: log.join(' | '), sources: c.reports.map(r => `email:${r.email_id}`).join(' ; '),
  };
});
const order = { P1: 0, P2: 1, P3: 2, INCOMPLETE: 3, REFERRED: 4 };
cases.sort((a, b) => order[a.band] - order[b.band] || b.risk_score - a.risk_score);
const skipped = other.map(o => ({ email_id: o.email_id, subject: o.subject, kind: o.kind, reason: o.reason || o.flags?.join('; ') || '' }));
return cases.map((c, i) => ({ json: { ...c, _skipped: i === 0 ? skipped : undefined } }));

// "Reference Files": which reference datasets to download (same files the Part 1 RAG app uses).
const base = $('Config').first().json.reference_base_url.replace(/\/$/, '');
return [
  { name: 'road_register', file: 'road_register.csv' },
  { name: 'hotspots', file: 'hotspots.csv' },
  { name: 'hazard_rules', file: 'hazard_response_rules.json' },
  { name: 'inspectors', file: 'inspectors.csv' },
].map(f => ({ json: { ...f, url: `${base}/${f.file}` } }));

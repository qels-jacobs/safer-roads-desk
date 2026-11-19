// "Assemble Replies": pair each LLM-drafted reply with its target (same order).
const targets = $('Reply Targets').all().map(i => i.json);
return $input.all()
  .map((it, i) => ({ ...targets[i], body: String(it.json.text || '').trim() }))
  .filter(r => r.kind && r.kind !== 'none' && r.body)
  .map(r => ({ json: r }));

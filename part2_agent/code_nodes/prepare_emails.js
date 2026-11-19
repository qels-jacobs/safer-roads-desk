// "Prepare Emails": one clean item per complaint email for the LLM.
return $('Get Hazard Emails').all().map(i => {
  const m = i.json;
  const body = (m.text || m.textPlain || m.snippet || '').replace(/\r/g, '');
  const clean = body.split(/\n(?:On .+wrote:|Op .+geskryf:|-{2,} ?Original Message)/)[0].trim().slice(0, 6000);
  return { json: {
    email_id: m.id, subject: m.subject || '', from: m.from?.value?.[0]?.address || '',
    received: m.date ? new Date(m.date).toISOString() : new Date().toISOString(), body: clean } };
});

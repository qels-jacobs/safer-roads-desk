// DEMO SETUP "Inspector Busy Blocks": pre-existing calendar commitments so the agent must work around them.
const OFF = 2 * 3600e3;
const sast = ms => new Date(ms + OFF);
const iso = ms => sast(ms).toISOString().slice(0, 19) + '+02:00';
function workdays(n) { // next n working days (incl. today) at 00:00 SAST, as UTC ms
  const out = []; let d = sast(Date.now()); d.setUTCHours(0, 0, 0, 0);
  let ms = d.getTime() - OFF;
  while (out.length < n) { const wd = sast(ms).getUTCDay(); if (wd !== 0 && wd !== 6) out.push(ms); ms += 86400e3; }
  return out;
}
const [d0, d1] = workdays(2);
const at = (day, h) => day + h * 3600e3;
const nowH = sast(Date.now()).getUTCHours();
const blocks = [
  ['INS-01', 'Depot safety meeting', at(d0, Math.min(Math.max(nowH + 1, 8), 14)), 2], // blocks the next slots today
  ['INS-01', 'Site visit Tygervalley', at(d1, 8), 2],
  ['INS-02', 'Court appearance (claims)', at(d0, 13), 3],
  ['INS-03', 'Training: road marking standards', at(d1, 8), 4],
  ['INS-04', 'Community road-safety forum, Khayelitsha', at(d1, 9), 3],
  ['INS-04', 'Contractor handover Mitchells Plain', at(d0, 14), 2],
];
return blocks.map(([ins, what, s, hrs]) => ({ json: { summary: `[${ins}] Busy: ${what}`, start: iso(s), end: iso(s + hrs * 3600e3) } }));

// Import/export vCard (3.0). Pur (sans état) → facilement testable.
// Mapping Comet : FN→name, EMAIL→email, TEL→phone, ORG→company, NOTE→notes.

const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
const unesc = (s) => String(s || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
const splitSemi = (s) => String(s || '').split(/(?<!\\);/).map(unesc); // sépare sur les « ; » non échappés

// Génère un .vcf à partir des contacts.
export function toVcards(contacts) {
  return contacts.map((c) => {
    const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(c.name)}`, `N:${esc(c.name)};;;;`];
    if (c.email) lines.push(`EMAIL;TYPE=INTERNET:${esc(c.email)}`);
    if (c.phone) lines.push(`TEL:${esc(c.phone)}`);
    if (c.company) lines.push(`ORG:${esc(c.company)}`);
    if (c.labels && c.labels.length) lines.push(`CATEGORIES:${c.labels.map(esc).join(',')}`);
    if (c.notes) lines.push(`NOTE:${esc(c.notes)}`);
    lines.push('END:VCARD');
    return lines.join('\r\n');
  }).join('\r\n') + (contacts.length ? '\r\n' : '');
}

// Analyse un texte vCard (un ou plusieurs contacts) → liste de contacts Comet.
export function parseVcards(text) {
  // Dépliage RFC 6350 : une ligne commençant par espace/tab continue la précédente
  const unfolded = String(text || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const out = [];
  const re = /BEGIN:VCARD([\s\S]*?)END:VCARD/gi;
  let m;
  while ((m = re.exec(unfolded))) {
    const props = {};
    for (const rawLine of m[1].split('\n')) {
      const line = rawLine.trim();
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const left = line.slice(0, colon);
      const value = line.slice(colon + 1);
      // Nom de propriété : avant le premier « ; » (paramètres) et sans préfixe « itemN. » (style Apple)
      const name = left.split(';')[0].replace(/^[^.]*\./, '').toUpperCase();
      if (!(name in props)) props[name] = value; // 1re valeur gagne
    }
    let name = unesc(props.FN || '');
    if (!name && props.N) { const p = splitSemi(props.N); name = [p[1], p[0]].filter(Boolean).join(' ').trim(); }
    const c = {
      name: name.trim(),
      email: unesc(props.EMAIL || ''),
      phone: unesc(props.TEL || ''),
      company: props.ORG ? splitSemi(props.ORG)[0] : '',
      notes: unesc(props.NOTE || ''),
      labels: props.CATEGORIES ? unesc(props.CATEGORIES).split(',').map((s) => s.trim()).filter(Boolean) : [],
    };
    if (c.name || c.email) out.push(c);
  }
  return out;
}

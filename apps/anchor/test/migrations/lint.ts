/** grep-level lint for risky migration SQL; a `-- reviewed: <reason>` comment silences it */
export function dangerousSql(sql: string) {
  const code = sql.replace(/--.*$/gm, '');
  const found: string[] = [];
  const has = (re: RegExp) => re.test(code);
  if (has(/\bDROP\s+COLUMN\b/i)) found.push('DROP COLUMN');
  if (has(/\bDROP\s+TABLE\b/i)) found.push('DROP TABLE');
  if (has(/\bALTER\s+COLUMN\b[^;]*?\b(SET\s+DATA\s+)?TYPE\b/i)) found.push('ALTER COLUMN TYPE');
  if (has(/\bALTER\s+TABLE\b[^;]*\bADD\s+CONSTRAINT\b[^;]*\bUNIQUE\b/i))
    found.push('ADD CONSTRAINT UNIQUE');
  for (const [, table] of code.matchAll(
    /\bALTER\s+TABLE\s+("?[\w]+"?)\s+ALTER\s+COLUMN\s+[^;]*\bSET\s+NOT\s+NULL\b/gi
  )) {
    if (!new RegExp(`\\bUPDATE\\s+${table}(?![\\w])`, 'i').test(code))
      found.push(`SET NOT NULL on ${table} without a backfill`);
  }
  return found;
}

export const hasReview = (sql: string) => /^[ \t]*--[ \t]*reviewed:[ \t]*\S+/m.test(sql);

import type postgres from "postgres";

/** A foreign key: `child` has a column that references `parent`. */
export type TableRef = { child: string; parent: string };

/**
 * The order to empty `tables` in so no DELETE trips a foreign key: every table comes before the
 * tables it references. References to tables outside the list (e.g. `users`) and a table's
 * references to itself don't constrain the order. Ties go alphabetically, so the order is stable.
 */
export function deleteOrder({ tables, refs }: { tables: readonly string[]; refs: readonly TableRef[] }): string[] {
  const inList = new Set(tables);
  const edges = refs.filter((r) => r.child !== r.parent && inList.has(r.child) && inList.has(r.parent));
  const order: string[] = [];
  let left = [...tables].sort();
  while (left.length) {
    // A table is ready once no table still waiting to be emptied references it.
    const ready = left.filter((t) => !edges.some((e) => e.parent === t && left.includes(e.child)));
    if (!ready.length) throw new Error(`resetTables: foreign keys form a cycle among ${left.join(", ")}.`);
    order.push(...ready);
    left = left.filter((t) => !ready.includes(t));
  }
  return order;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * Empty every table except `users`, restart their sequences (so `facts.no` starts at 1 again), and
 * put the single users row back to its defaults. Tables, foreign keys and sequences are all read
 * from the catalog, so a new table is covered without editing this.
 *
 * DELETE in foreign-key order rather than TRUNCATE: TRUNCATE swaps every table's files, which made
 * resetDb average about 16 ms over `bun test`; with these DELETEs it averages about 2.5 ms. The LOCK keeps
 * TRUNCATE's guarantee that no other transaction (a test's background task, or the e2e server)
 * writes between the deletes. Everything goes in one simple-protocol query, which Postgres runs as
 * one transaction.
 */
export async function resetTables(sql: postgres.Sql): Promise<void> {
  const [catalog] = await sql<{ tables: string[]; refs: TableRef[]; sequences: string[] }[]>`
    WITH t AS (
      SELECT c.oid, c.relname FROM pg_tables p
      JOIN pg_class c ON c.oid = (quote_ident(p.schemaname) || '.' || quote_ident(p.tablename))::regclass
      WHERE p.schemaname = 'public' AND p.tablename <> 'users'
    )
    SELECT
      (SELECT coalesce(json_agg(relname ORDER BY relname), '[]') FROM t) AS tables,
      (SELECT coalesce(json_agg(json_build_object('child', ch.relname, 'parent', pa.relname)), '[]')
        FROM pg_constraint k JOIN pg_class ch ON ch.oid = k.conrelid JOIN pg_class pa ON pa.oid = k.confrelid
        WHERE k.contype = 'f' AND k.conrelid IN (SELECT oid FROM t)) AS refs,
      -- Sequences owned by a column of these tables: identity ('i') and serial ('a'), as RESTART IDENTITY did.
      (SELECT coalesce(json_agg(quote_ident(sn.nspname) || '.' || quote_ident(s.relname) ORDER BY s.relname), '[]')
        FROM pg_depend d JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
        JOIN pg_namespace sn ON sn.oid = s.relnamespace
        WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
          AND d.deptype IN ('a', 'i') AND d.refobjid IN (SELECT oid FROM t)) AS sequences`;
  if (!catalog) throw new Error("resetTables: the catalog query returned no row.");
  const tables = deleteOrder({ tables: catalog.tables, refs: catalog.refs });
  const statements = [
    ...(tables.length ? [`LOCK TABLE ${tables.map(quote).join(", ")} IN ACCESS EXCLUSIVE MODE`] : []),
    ...tables.map((t) => `DELETE FROM ${quote(t)}`),
    ...catalog.sequences.map((s) => `ALTER SEQUENCE ${s} RESTART`),
    `UPDATE users SET full_name = DEFAULT, email = DEFAULT, phone = DEFAULT, location = DEFAULT,
      links = DEFAULT, standard_answers = DEFAULT, target_titles = DEFAULT, role_families = DEFAULT,
      exclude_title_words = DEFAULT, seniority = DEFAULT, years_experience = DEFAULT, min_pay = DEFAULT,
      ai_provider = DEFAULT, ai_key_hint = DEFAULT,
      model_light = DEFAULT, model_writing = DEFAULT, monthly_cap_usd = DEFAULT,
      ai_eligibility_on_refresh = DEFAULT, view_currency = DEFAULT, fx_rates = DEFAULT, fx_fetch = DEFAULT`,
  ];
  await sql.unsafe(statements.join(";\n")).simple();
}

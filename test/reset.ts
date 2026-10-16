import type postgres from "postgres";

/**
 * Truncate every table except `users` and put the single users row back to its defaults.
 * The table list is read from the catalog, so new tables are covered without editing this.
 */
export async function resetTables(sql: postgres.Sql): Promise<void> {
  const rows = await sql<{ name: string }[]>`
    SELECT tablename AS name FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> 'users'`;
  if (rows.length) {
    await sql.unsafe(`TRUNCATE ${rows.map((r) => `"${r.name}"`).join(", ")} RESTART IDENTITY CASCADE`);
  }
  await sql`
    UPDATE users SET full_name = DEFAULT, email = DEFAULT, phone = DEFAULT, location = DEFAULT,
      links = DEFAULT, standard_answers = DEFAULT, ai_provider = DEFAULT, ai_key_hint = DEFAULT,
      model_light = DEFAULT, model_writing = DEFAULT, monthly_cap_usd = DEFAULT,
      ai_eligibility_on_refresh = DEFAULT, view_currency = DEFAULT, fx_rates = DEFAULT`;
}

import { describe, expect, test } from "bun:test";
import { deleteOrder } from "./reset";
import { resetDb, testSql } from "./setup";

describe("deleteOrder", () => {
  test("puts every table before the tables it references", () => {
    const order = deleteOrder({
      tables: ["jobs", "opportunities", "outputs", "output_facts", "facts"],
      refs: [
        { child: "opportunities", parent: "jobs" },
        { child: "outputs", parent: "opportunities" },
        { child: "output_facts", parent: "outputs" },
        { child: "output_facts", parent: "facts" },
      ],
    });
    expect(order).toEqual(["output_facts", "facts", "outputs", "opportunities", "jobs"]);
  });

  test("ignores references to tables it does not empty, and a table's references to itself", () => {
    const order = deleteOrder({
      tables: ["b", "a"],
      refs: [
        { child: "a", parent: "users" },
        { child: "a", parent: "a" },
        { child: "b", parent: "a" },
      ],
    });
    expect(order).toEqual(["b", "a"]);
  });

  test("a reference cycle is an error that names the tables", () => {
    expect(() =>
      deleteOrder({
        tables: ["a", "b", "c"],
        refs: [
          { child: "a", parent: "b" },
          { child: "b", parent: "a" },
        ],
      }),
    ).toThrow(/a, b/);
  });
});

describe("resetDb", () => {
  test("empties every table except users, resets the user row, and restarts facts.no at 1", async () => {
    await resetDb();
    const sql = testSql();
    const [user] = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
    if (!user) throw new Error("resetDb left no users row");
    await sql`UPDATE users SET full_name = 'Someone'`;
    const [item] = await sql<{ id: string }[]>`
      INSERT INTO profile_items (user_id, kind, title, body) VALUES (${user.id}, 'experience', 'Acme', 'body')
      RETURNING id`;
    if (!item) throw new Error("no profile item");
    await sql`INSERT INTO facts (user_id, item_id, text, seen_rev)
      VALUES (${user.id}, ${item.id}, 'one', 1), (${user.id}, ${item.id}, 'two', 1)`;
    const [job] = await sql<{ id: string }[]>`
      INSERT INTO jobs (user_id, origin, title, company, title_key, company_key, description, content_hash, description_key)
      VALUES (${user.id}, 'paste', 'Dev', 'Acme', 'dev', 'acme', 'desc', 'hash', 'desc')
      RETURNING id`;
    if (!job) throw new Error("no job");
    // opportunities -> jobs is ON DELETE RESTRICT, so the jobs delete only works after this row goes.
    await sql`INSERT INTO opportunities (user_id, job_id, dismissed_at) VALUES (${user.id}, ${job.id}, now())`;
    await sql`INSERT INTO tasks (user_id, kind, input) VALUES (${user.id}, 'refresh', '{}'::jsonb)`;
    await sql`INSERT INTO sources (user_id, kind, label) VALUES (${user.id}, 'jobicy', 'Jobicy')`;

    await resetDb();

    const tables = await sql<{ name: string }[]>`
      SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'users'`;
    expect(tables.length).toBeGreaterThan(10);
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      const [row] = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${name}"`);
      counts[name] = row?.n ?? -1;
    }
    expect(Object.entries(counts).filter(([, n]) => n !== 0)).toEqual([]);

    const users = await sql<{ id: string; full_name: string }[]>`SELECT id, full_name FROM users`;
    expect([...users]).toEqual([{ id: user.id, full_name: "" }]);

    const [again] = await sql<{ id: string }[]>`
      INSERT INTO profile_items (user_id, kind, title, body) VALUES (${user.id}, 'experience', 'Acme', 'body')
      RETURNING id`;
    if (!again) throw new Error("no profile item");
    const [fact] = await sql<{ no: number }[]>`
      INSERT INTO facts (user_id, item_id, text, seen_rev) VALUES (${user.id}, ${again.id}, 'one', 1) RETURNING no`;
    expect(fact?.no).toBe(1);
    await resetDb();
  });
});

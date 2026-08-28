import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname, join } from "path";

// DB_PATH ชี้ไป mounted volume ตอน deploy (Railway volume ฯลฯ) ไม่งั้นข้อมูลหายตอน redeploy
const DB_PATH = process.env.DB_PATH || join(import.meta.dir, "../data/trivia.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS question_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    set_id INTEGER NOT NULL,
    q TEXT NOT NULL,
    opts TEXT NOT NULL,
    correct INTEGER NOT NULL,
    position INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_questions_set ON questions(set_id);
`);

export interface QuestionInput {
  q: string;
  opts: string[];
  correct: number;
}

export function validateQuestions(qs: unknown): qs is QuestionInput[] {
  return (
    Array.isArray(qs) &&
    qs.length > 0 &&
    qs.every(
      (x) =>
        x &&
        typeof x.q === "string" &&
        x.q.trim() !== "" &&
        Array.isArray(x.opts) &&
        x.opts.length === 4 &&
        x.opts.every((o: unknown) => typeof o === "string" && o.trim() !== "") &&
        Number.isInteger(x.correct) &&
        x.correct >= 0 &&
        x.correct <= 3
    )
  );
}

export function listSets() {
  return db
    .query(
      `SELECT s.id, s.name, s.updated_at AS updatedAt, COUNT(q.id) AS count
       FROM question_sets s
       LEFT JOIN questions q ON q.set_id = s.id
       GROUP BY s.id
       ORDER BY s.updated_at DESC`
    )
    .all();
}

export function getSet(id: number) {
  const set = db.query(`SELECT id, name FROM question_sets WHERE id = ?`).get(id) as
    | { id: number; name: string }
    | null;
  if (!set) return null;
  const questions = (
    db
      .query(`SELECT q, opts, correct FROM questions WHERE set_id = ? ORDER BY position`)
      .all(id) as { q: string; opts: string; correct: number }[]
  ).map((r) => ({ q: r.q, opts: JSON.parse(r.opts), correct: r.correct }));
  return { ...set, questions };
}

// upsert ตามชื่อชุด: บันทึกชื่อเดิมซ้ำ = แทนที่คำถามทั้งชุด
export const saveSet = db.transaction((name: string, questions: QuestionInput[]) => {
  let row = db.query(`SELECT id FROM question_sets WHERE name = ?`).get(name) as
    | { id: number }
    | null;
  let id: number;
  if (row) {
    id = row.id;
    db.query(`UPDATE question_sets SET updated_at = datetime('now') WHERE id = ?`).run(id);
    db.query(`DELETE FROM questions WHERE set_id = ?`).run(id);
  } else {
    id = (
      db.query(`INSERT INTO question_sets (name) VALUES (?) RETURNING id`).get(name) as {
        id: number;
      }
    ).id;
  }
  const ins = db.query(
    `INSERT INTO questions (set_id, q, opts, correct, position) VALUES (?, ?, ?, ?, ?)`
  );
  questions.forEach((qq, i) => ins.run(id, qq.q, JSON.stringify(qq.opts), qq.correct, i));
  return id;
});

export function deleteSet(id: number) {
  db.query(`DELETE FROM questions WHERE set_id = ?`).run(id);
  db.query(`DELETE FROM question_sets WHERE id = ?`).run(id);
}

export function searchQuestions(term: string, limit = 30) {
  const like = `%${term}%`;
  return (
    db
      .query(
        `SELECT q.id, q.q, q.opts, q.correct, s.name AS setName
         FROM questions q
         JOIN question_sets s ON s.id = q.set_id
         WHERE q.q LIKE ? OR q.opts LIKE ?
         ORDER BY q.id DESC
         LIMIT ?`
      )
      .all(like, like, limit) as { id: number; q: string; opts: string; correct: number; setName: string }[]
  ).map((r) => ({ ...r, opts: JSON.parse(r.opts) }));
}

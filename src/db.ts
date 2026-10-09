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
// migration: คอลัมน์ที่เพิ่มทีหลัง (DB เก่าบน volume ยังไม่มี)
const cols = (db.query(`PRAGMA table_info(questions)`).all() as { name: string }[]).map((c) => c.name);
if (!cols.includes("image")) db.exec(`ALTER TABLE questions ADD COLUMN image TEXT`);
if (!cols.includes("double")) db.exec(`ALTER TABLE questions ADD COLUMN double INTEGER NOT NULL DEFAULT 0`);

export interface QuestionInput {
  q: string;
  opts: string[];
  correct: number;
  image?: string; // URL (http/https) หรือ data:image/... ที่ client ย่อขนาดมาแล้ว
  double?: boolean; // ข้อคะแนน x2
}

export const MAX_QUESTIONS = 200;
const MAX_TEXT = 500;
const MAX_IMAGE = 400_000; // ~300KB หลัง base64 — client ย่อรูปไว้ราว 50–100KB

function validImage(x: unknown): boolean {
  if (x === undefined || x === null || x === "") return true;
  return (
    typeof x === "string" &&
    x.length <= MAX_IMAGE &&
    (/^https?:\/\//i.test(x) || /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(x))
  );
}

export function validateQuestions(qs: unknown): qs is QuestionInput[] {
  return (
    Array.isArray(qs) &&
    qs.length > 0 &&
    qs.length <= MAX_QUESTIONS &&
    qs.every(
      (x) =>
        x &&
        typeof x.q === "string" &&
        x.q.trim() !== "" &&
        x.q.length <= MAX_TEXT &&
        Array.isArray(x.opts) &&
        x.opts.length === 4 &&
        x.opts.every((o: unknown) => typeof o === "string" && o.trim() !== "" && o.length <= MAX_TEXT) &&
        Number.isInteger(x.correct) &&
        x.correct >= 0 &&
        x.correct <= 3 &&
        validImage(x.image) &&
        (x.double === undefined || typeof x.double === "boolean")
    )
  );
}

// เก็บเฉพาะ field ที่รู้จัก — กัน client ยัด field แปลกๆ เข้า room/DB
export function cleanQuestion(x: QuestionInput): QuestionInput {
  const out: QuestionInput = { q: x.q.trim(), opts: x.opts.map((o) => o.trim()), correct: x.correct };
  if (x.image) out.image = x.image;
  if (x.double) out.double = true;
  return out;
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

function rowToQuestion(r: { q: string; opts: string; correct: number; image: string | null; double: number }) {
  const out: QuestionInput = { q: r.q, opts: JSON.parse(r.opts), correct: r.correct };
  if (r.image) out.image = r.image;
  if (r.double) out.double = true;
  return out;
}

export function getSet(id: number) {
  const set = db.query(`SELECT id, name FROM question_sets WHERE id = ?`).get(id) as
    | { id: number; name: string }
    | null;
  if (!set) return null;
  const questions = (
    db
      .query(`SELECT q, opts, correct, image, double FROM questions WHERE set_id = ? ORDER BY position`)
      .all(id) as { q: string; opts: string; correct: number; image: string | null; double: number }[]
  ).map((r) => rowToQuestion(r));
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
    `INSERT INTO questions (set_id, q, opts, correct, position, image, double) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  questions.forEach((qq, i) =>
    ins.run(id, qq.q, JSON.stringify(qq.opts), qq.correct, i, qq.image ?? null, qq.double ? 1 : 0)
  );
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
        `SELECT q.id, q.q, q.opts, q.correct, q.image, q.double, s.name AS setName
         FROM questions q
         JOIN question_sets s ON s.id = q.set_id
         WHERE q.q LIKE ? OR q.opts LIKE ?
         ORDER BY q.id DESC
         LIMIT ?`
      )
      .all(like, like, limit) as {
      id: number; q: string; opts: string; correct: number; image: string | null; double: number; setName: string;
    }[]
  ).map((r) => ({ id: r.id, setName: r.setName, ...rowToQuestion(r) }));
}

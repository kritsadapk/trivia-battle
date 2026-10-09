import { cleanQuestion, validateQuestions, type QuestionInput } from "./db";

// สร้างคำถามผ่าน OpenRouter — เลือกโมเดลได้ (รวมโมเดลราคาถูก) โดยไม่ผูกกับเจ้าเดียว
const API_KEY = process.env.OPENROUTER_API_KEY?.trim() || "";
export const aiEnabled = !!API_KEY;

// Gemini 2.5 Flash: ภาษาไทยดี ราคาถูก รองรับ structured outputs
const MODEL = "google/gemini-2.5-flash";

export interface GenerateInput {
  topic: string;
  count: number;
  difficulty: "easy" | "medium" | "hard" | "mixed";
  language: "th" | "en";
}

const DIFFICULTY = { easy: "easy", medium: "medium", hard: "hard", mixed: "mixed, from easy to hard" };

const SYSTEM = `You write multiple-choice questions for a live team quiz game played on phones (like Kahoot).
Rules for every question:
- Exactly 4 options, exactly one correct. "correct" is the 0-based index of the right option.
- Question under 120 characters, each option under 60 characters — players read them on a phone in seconds.
- Distractors must be plausible; avoid "all of the above"/"none of the above".
- Spread the correct index across positions 0-3; don't favour one position.
- Base facts only on the topic/material the host gives. If material is provided, every question must be answerable from it.
- Make it fun: a light, playful tone is welcome, but the correct answer must be unambiguous.
Reply with JSON only: {"questions":[{"q":"...","opts":["...","...","...","..."],"correct":0}]}`;

const SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          q: { type: "string" },
          opts: { type: "array", items: { type: "string" } },
          correct: { type: "integer" },
        },
        required: ["q", "opts", "correct"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
};

// บางโมเดลห่อ JSON ด้วย ```json ... ``` หรือมีข้อความนำ — ดึงเฉพาะก้อน JSON
function extractJson(text: string): any {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no json in response");
  return JSON.parse(text.slice(start, end + 1));
}

export async function generateQuestions(input: GenerateInput): Promise<QuestionInput[]> {
  if (!aiEnabled) throw new Error("AI not configured");
  const lang = input.language === "en" ? "English" : "Thai (ภาษาไทย)";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "Quiz Rush",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `Write ${input.count} questions in ${lang}. Difficulty: ${DIFFICULTY[input.difficulty]}.\n\n<topic_or_material>\n${input.topic}\n</topic_or_material>`,
        },
      ],
      response_format: { type: "json_schema", json_schema: { name: "quiz", strict: true, schema: SCHEMA } },
      // ส่งไปเฉพาะ provider ที่รองรับ structured output
      provider: { require_parameters: true },
      max_tokens: 8000,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as any;
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("empty response");
  const parsed = extractJson(content);
  const qs = (Array.isArray(parsed?.questions) ? parsed.questions : [])
    .map((q: any) => ({ q: q?.q, opts: q?.opts, correct: Number(q?.correct) }))
    .filter((q: unknown) => validateQuestions([q])) as QuestionInput[];
  return qs.slice(0, input.count).map(cleanQuestion);
}

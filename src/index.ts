import { Elysia } from "elysia";
import { join } from "path";
import { readFileSync } from "fs";
import {
  listSets, getSet, saveSet, deleteSet, searchQuestions, validateQuestions, cleanQuestion,
  type QuestionInput,
} from "./db";
import { aiEnabled, generateQuestions, type GenerateInput } from "./ai";

// Serve index.html natively — works without @elysiajs/static
// PUBLIC_URL ใช้ทำลิงก์เต็มของรูปพรีวิว (og:image ต้องเป็น absolute URL)
const PUBLIC_URL = (process.env.PUBLIC_URL || "https://quizzy.deskmate.site").replace(/\/+$/, "");
const HTML = readFileSync(join(import.meta.dir, "../public/index.html"), "utf-8").replaceAll("%PUBLIC_URL%", PUBLIC_URL);
// ไฟล์แบรนด์ (favicon / รูปพรีวิว) — โหลดครั้งเดียวตอนเริ่ม
const ASSETS: Record<string, { body: Uint8Array; type: string }> = Object.fromEntries(
  [["icon.svg", "image/svg+xml"], ["og.png", "image/png"], ["apple-touch-icon.png", "image/png"]].map(([f, type]) => [
    f, { body: readFileSync(join(import.meta.dir, "../public", f)), type },
  ])
);
const asset = (f: string) => new Response(ASSETS[f].body, {
  headers: { "Content-Type": ASSETS[f].type, "Cache-Control": "public, max-age=86400" },
});

// ══════════════════════════════════════
// TYPES
// ══════════════════════════════════════
interface Player {
  name: string;
  avatar: string;
  ws: any;
  token: string; // ใช้ยืนยันตัวตนตอนกลับเข้าเกม — กันคนอื่นสวมชื่อคนที่หลุด
  team?: string;
  score: number;
  answered: boolean;
  streak: number;
  correctCount: number;
  lastCorrect?: boolean;
  lastPts?: number;
  lastAnswerMs?: number;
  lastReactAt?: number;
}

type Question = QuestionInput;

interface QuestionStat {
  q: string;
  correctText: string;
  counts: number[];
  answered: number;
  correctCount: number;
  players: number;
  avgCorrectMs: number | null;
}

interface Room {
  code: string;
  gameName: string;
  timePerQ: number;
  questions: Question[];
  teams: string[]; // ว่าง = เล่นเดี่ยว
  players: Map<string, Player>;
  hostWs: any;
  hostToken: string;
  hostGraceTimer?: Timer;
  phase: "lobby" | "question" | "reveal" | "leaderboard" | "final";
  currentQ: number;
  timerInterval?: Timer;
  introTimer?: Timer;
  timeLeft: number;
  answeredCount: number;
  answerCounts: number[];
  questionStartAt: number;
  fastest?: { name: string; avatar: string; ms: number };
  prevRanks?: Map<string, number>;
  history: QuestionStat[];
  lastActivity: number;
}

// ══════════════════════════════════════
// STATE
// ══════════════════════════════════════
const MAX_NAME_LEN = 20;
const MAX_PLAYERS = 300;
const MAX_ROOMS = 300;
const MAX_TEAMS = 8;
const DOUBLE_INTRO_MS = 2200; // เวลาโชว์ "x2" ก่อนเริ่มนับเวลา
const REACT_COOLDOWN_MS = 600;
const REACTIONS = ["👏", "😂", "🔥", "😱", "❤️", "🎉", "🤯", "👍"];
const rooms = new Map<string, Room>();
const wsMap = new Map<any, { roomCode: string; playerName: string; role: "host" | "player" }>();

// ══════════════════════════════════════
// HELPERS
// ══════════════════════════════════════
// ตัด 0/O, 1/I/L ออก — คนอ่านรหัสจากจอโปรเจกเตอร์พิมพ์ผิดน้อยลง
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function genCode(): string {
  let code: string;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
  } while (rooms.has(code));
  return code;
}

// Elysia ห่อ socket ใหม่ทุก event — เทียบตัวจริงผ่าน .raw
function sameWs(a: any, b: any): boolean {
  return !!a && !!b && (a.raw ?? a) === (b.raw ?? b);
}

function isLive(ws: any): boolean {
  return ws?.readyState === 1;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function shuffleOptions(q: Question): Question {
  const order = shuffle([0, 1, 2, 3]);
  return { ...q, opts: order.map((i) => q.opts[i]), correct: order.indexOf(q.correct) };
}

function stopTimers(room: Room) {
  clearInterval(room.timerInterval);
  clearTimeout(room.introTimer);
}

function destroyRoom(room: Room, reason?: string) {
  stopTimers(room);
  clearTimeout(room.hostGraceTimer);
  if (reason) broadcast(room, { type: "error", message: reason });
  rooms.delete(room.code);
}

// กวาดห้องร้าง (host ws ตายโดยไม่มี close event / ห้องถูกทิ้งไว้) กัน memory รั่ว
const ROOM_IDLE_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room) => {
    if (now - room.lastActivity > ROOM_IDLE_MS) destroyRoom(room, "ห้องหมดอายุ");
  });
}, 10 * 60 * 1000);

function broadcast(room: Room, msg: object, excludeWs?: any) {
  const data = JSON.stringify(msg);
  room.players.forEach((p) => {
    if (p.ws !== excludeWs && p.ws.readyState === 1) {
      p.ws.send(data);
    }
  });
  if (room.hostWs && room.hostWs !== excludeWs && room.hostWs.readyState === 1) {
    room.hostWs.send(data);
  }
}

function sendTo(ws: any, msg: object) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

function publicQuestion(q: Question) {
  return { q: q.q, opts: q.opts, image: q.image ?? null, double: !!q.double };
}

function getRoomPublicPlayers(room: Room) {
  return Array.from(room.players.values()).map((p) => ({
    name: p.name,
    avatar: p.avatar,
    score: p.score,
    team: p.team ?? null,
  }));
}

function getLeaderboard(room: Room) {
  return Array.from(room.players.values())
    .map((p) => ({ name: p.name, avatar: p.avatar, score: p.score, streak: p.streak, team: p.team ?? null }))
    .sort((a, b) => b.score - a.score);
}

// คะแนนทีม = ค่าเฉลี่ยต่อคน (ทีมคนเยอะไม่ได้เปรียบ)
function getTeamBoard(room: Room) {
  if (!room.teams.length) return null;
  return room.teams
    .map((name) => {
      const members = Array.from(room.players.values()).filter((p) => p.team === name);
      const total = members.reduce((s, p) => s + p.score, 0);
      return { name, members: members.length, total, avg: members.length ? Math.round(total / members.length) : 0 };
    })
    .sort((a, b) => b.avg - a.avg);
}

// leaderboard พร้อมบอกว่าใครขยับขึ้น/ลงกี่อันดับเทียบกับข้อก่อนหน้า
function getLeaderboardWithDelta(room: Room) {
  const lb = getLeaderboard(room);
  const withDelta = lb.map((p, i) => ({
    ...p,
    delta: room.prevRanks?.has(p.name) ? room.prevRanks.get(p.name)! - i : 0,
  }));
  room.prevRanks = new Map(lb.map((p, i) => [p.name, i]));
  return withDelta;
}

// ตัวคูณสตรีค: ตอบถูกติดกันยิ่งนาน คะแนนยิ่งคูณ
function streakMultiplier(streak: number): number {
  if (streak >= 5) return 2;
  if (streak >= 3) return 1.5;
  if (streak >= 2) return 1.2;
  return 1;
}

function assignMissingTeams(room: Room) {
  if (!room.teams.length) return;
  room.players.forEach((p) => {
    if (p.team && room.teams.includes(p.team)) return;
    // ใส่ทีมที่คนน้อยสุด ให้ทีมสมดุล
    const sizes = room.teams.map((t) => Array.from(room.players.values()).filter((x) => x.team === t).length);
    p.team = room.teams[sizes.indexOf(Math.min(...sizes))];
  });
}

function isLastQuestion(room: Room) {
  return room.currentQ >= room.questions.length - 1;
}

// ══════════════════════════════════════
// GAME TIMER
// ══════════════════════════════════════
function startQuestionTimer(room: Room) {
  stopTimers(room);
  const q = room.questions[room.currentQ];
  const intro = q.double ? DOUBLE_INTRO_MS : 0;
  room.timeLeft = room.timePerQ;
  room.answeredCount = 0;
  room.answerCounts = [0, 0, 0, 0];
  room.questionStartAt = Date.now() + intro;
  room.fastest = undefined;
  room.players.forEach((p) => { p.answered = false; p.lastCorrect = undefined; p.lastPts = undefined; p.lastAnswerMs = undefined; });

  broadcast(room, {
    type: "question_start",
    currentQ: room.currentQ,
    total: room.questions.length,
    question: publicQuestion(q),
    timeLeft: room.timeLeft,
    introMs: intro,
  });

  room.introTimer = setTimeout(() => {
    room.timerInterval = setInterval(() => {
      room.timeLeft--;
      broadcast(room, { type: "timer", timeLeft: room.timeLeft });
      if (room.timeLeft <= 0) revealAndLeaderboard(room);
    }, 1000);
  }, intro);
}

function getQuestionResults(room: Room) {
  return Array.from(room.players.values()).map((p) => ({
    name: p.name,
    avatar: p.avatar,
    correct: p.answered ? !!p.lastCorrect : null, // null = ไม่ทันตอบ
    pts: p.answered ? p.lastPts ?? 0 : 0,
  }));
}

function revealAndLeaderboard(room: Room) {
  stopTimers(room);
  // ค้างที่หน้าเฉลยจนกว่า host จะกด "ดูอันดับ" — ไม่ auto เปลี่ยนหน้า
  room.phase = "reveal";
  // คนที่ไม่ทันตอบข้อนี้ = สตรีคขาด
  room.players.forEach((p) => { if (!p.answered) p.streak = 0; });
  const q = room.questions[room.currentQ];

  const correctTimes = Array.from(room.players.values())
    .filter((p) => p.lastCorrect && p.lastAnswerMs !== undefined)
    .map((p) => p.lastAnswerMs!);
  room.history[room.currentQ] = {
    q: q.q,
    correctText: q.opts[q.correct],
    counts: [...room.answerCounts],
    answered: room.answeredCount,
    correctCount: room.answerCounts[q.correct],
    players: room.players.size,
    avgCorrectMs: correctTimes.length ? Math.round(correctTimes.reduce((a, b) => a + b, 0) / correctTimes.length) : null,
  };

  broadcast(room, {
    type: "reveal",
    correct: q.correct,
    counts: room.answerCounts,
    answeredTotal: room.answeredCount,
    results: getQuestionResults(room),
    fastest: room.fastest ?? null,
    leaderboard: getLeaderboardWithDelta(room),
    teamBoard: getTeamBoard(room),
    isLastQuestion: isLastQuestion(room),
  });
}

function endGame(room: Room) {
  stopTimers(room);
  room.phase = "final";
  room.lastActivity = Date.now();
  // broadcast ครอบคลุม host อยู่แล้ว — ห้ามส่งซ้ำ ไม่งั้น client เล่นลำดับประกาศผล 2 รอบ
  broadcast(room, { type: "final", leaderboard: getLeaderboard(room), teamBoard: getTeamBoard(room) });
}

// ══════════════════════════════════════
// MESSAGE HANDLERS
// ══════════════════════════════════════
function handleMessage(ws: any, raw: string | object) {
  let msg: any;
  if (typeof raw === "object" && raw !== null) {
    msg = raw;
  } else {
    try { msg = JSON.parse(String(raw)); } catch { return; }
  }

  const info = wsMap.get(ws.raw ?? ws);

  switch (msg.type) {

    case "create_room": {
      if (rooms.size >= MAX_ROOMS) { sendTo(ws, { type: "error", message: "เซิร์ฟเวอร์เต็ม ลองใหม่อีกครั้ง" }); return; }
      // ตรวจทุกอย่างฝั่ง server — ข้อมูลเสียทำให้ timer ค้าง (NaN) หรือ server throw ตอนเริ่มเกม
      if (!validateQuestions(msg.questions) || msg.questions.length < 2) {
        sendTo(ws, { type: "error", message: "คำถามไม่ถูกต้อง (ต้องมีอย่างน้อย 2 ข้อ ตัวเลือกครบ 4)" });
        return;
      }
      const t = Number(msg.timePerQ);
      const timePerQ = Number.isInteger(t) && t >= 5 && t <= 120 ? t : 20;

      let questions = (msg.questions as QuestionInput[]).map(cleanQuestion);
      if (msg.shuffleQuestions) questions = shuffle(questions);
      if (msg.shuffleOptions) questions = questions.map(shuffleOptions);
      // ข้อสุดท้ายชี้ชะตา — ใส่หลังสุ่มลำดับ จะได้เป็นข้อสุดท้ายจริงๆ
      if (msg.finalDouble) questions[questions.length - 1].double = true;

      const teams: string[] = Array.isArray(msg.teams)
        ? [...new Set<string>(
            msg.teams
              .filter((x: unknown) => typeof x === "string")
              .map((x: string) => x.trim().slice(0, MAX_NAME_LEN))
              .filter(Boolean)
          )].slice(0, MAX_TEAMS)
        : [];

      const code = genCode();
      const room: Room = {
        code,
        gameName: (typeof msg.gameName === "string" ? msg.gameName.trim().slice(0, 40) : "") || "Quizzy",
        timePerQ,
        questions,
        teams: teams.length >= 2 ? teams : [],
        players: new Map(),
        hostWs: ws,
        hostToken: crypto.randomUUID(),
        phase: "lobby",
        currentQ: 0,
        timeLeft: 0,
        answeredCount: 0,
        answerCounts: [0, 0, 0, 0],
        questionStartAt: 0,
        history: [],
        lastActivity: Date.now(),
      };
      rooms.set(code, room);
      wsMap.set(ws.raw ?? ws, { roomCode: code, playerName: "__host__", role: "host" });
      sendTo(ws, {
        type: "room_created", code, gameName: room.gameName, token: room.hostToken,
        teams: room.teams, total: questions.length, timePerQ,
      });
      break;
    }

    case "host_reconnect": {
      const room = rooms.get(msg.code?.toUpperCase());
      if (!room || room.hostToken !== msg.token) {
        sendTo(ws, { type: "reconnect_failed" });
        return;
      }
      clearTimeout(room.hostGraceTimer);
      room.hostWs = ws;
      room.lastActivity = Date.now();
      wsMap.set(ws.raw ?? ws, { roomCode: room.code, playerName: "__host__", role: "host" });
      const snapshot: any = {
        type: "host_reconnected",
        code: room.code,
        gameName: room.gameName,
        teams: room.teams,
        // host หลุดกลางหน้าเฉลย → กลับมาที่หน้าอันดับ (มีปุ่มไปข้อถัดไปครบ)
        phase: room.phase === "reveal" ? "leaderboard" : room.phase,
        currentQ: room.currentQ,
        total: room.questions.length,
        timePerQ: room.timePerQ,
        players: getRoomPublicPlayers(room),
        leaderboard: getLeaderboard(room),
        teamBoard: getTeamBoard(room),
        fastest: room.fastest ?? null,
        timeLeft: room.timeLeft,
        answeredCount: room.answeredCount,
        isLastQuestion: isLastQuestion(room),
      };
      if (room.phase === "question") snapshot.question = publicQuestion(room.questions[room.currentQ]);
      sendTo(ws, snapshot);
      break;
    }

    case "join_room": {
      const room = rooms.get(msg.code?.toUpperCase());
      if (!room) { sendTo(ws, { type: "error", message: "ไม่พบห้องนี้" }); return; }
      // จำกัดความยาวชื่อฝั่ง server เสมอ — client เก่า/ยิงตรงผ่าน ws ก็โดนตัดเหมือนกัน
      const name = typeof msg.name === "string" ? msg.name.trim().slice(0, MAX_NAME_LEN) : "";
      const avatar = typeof msg.avatar === "string" ? msg.avatar.slice(0, 8) : "🎮";
      if (!name) { sendTo(ws, { type: "error", message: "ใส่ชื่อด้วย" }); return; }
      const existing = room.players.get(name);
      // token ตรง = คนเดิมกลับมา (refresh / เน็ตหลุด) — ยึด ws ใหม่ได้แม้ ws เก่ายังไม่ปิด
      const isOwner = !!existing && typeof msg.token === "string" && msg.token === existing.token;

      // กลับเข้าเกมกลางคัน: อนุญาตเฉพาะเจ้าของชื่อ (token ตรง) คะแนนคงเดิม
      if (room.phase !== "lobby") {
        if (!existing || !isOwner) {
          sendTo(ws, { type: "error", message: existing ? "ชื่อนี้ถูกใช้แล้ว" : "เกมเริ่มไปแล้ว" });
          return;
        }
        existing.ws = ws;
        room.lastActivity = Date.now();
        wsMap.set(ws.raw ?? ws, { roomCode: room.code, playerName: name, role: "player" });
        sendTo(ws, {
          type: "joined", code: room.code, gameName: room.gameName, score: existing.score,
          token: existing.token, teams: room.teams, team: existing.team ?? null,
        });
        if (room.phase === "question") {
          sendTo(ws, {
            type: "question_start",
            currentQ: room.currentQ,
            total: room.questions.length,
            question: publicQuestion(room.questions[room.currentQ]),
            timeLeft: room.timeLeft,
            introMs: Math.max(0, room.questionStartAt - Date.now()),
            answered: existing.answered,
          });
        } else if (room.phase === "reveal" || room.phase === "leaderboard") {
          // คนกลับเข้ามาระหว่างเฉลย/ดูอันดับ — พาไปหน้าอันดับเลย (เฉลยผ่านไปแล้ว)
          sendTo(ws, {
            type: "show_leaderboard",
            fastest: room.fastest ?? null,
            leaderboard: getLeaderboard(room),
            teamBoard: getTeamBoard(room),
            isLastQuestion: isLastQuestion(room),
          });
        } else if (room.phase === "final") {
          sendTo(ws, { type: "final", leaderboard: getLeaderboard(room), teamBoard: getTeamBoard(room) });
        }
        sendTo(room.hostWs, { type: "player_joined", players: getRoomPublicPlayers(room) });
        return;
      }

      if (existing && isLive(existing.ws) && !isOwner) { sendTo(ws, { type: "error", message: "ชื่อนี้ถูกใช้แล้ว" }); return; }
      if (!existing && room.players.size >= MAX_PLAYERS) { sendTo(ws, { type: "error", message: "ห้องเต็มแล้ว" }); return; }

      const player: Player = isOwner
        ? existing!
        : { name, avatar, ws, token: crypto.randomUUID(), score: 0, answered: false, streak: 0, correctCount: 0 };
      player.ws = ws;
      room.players.set(name, player);
      room.lastActivity = Date.now();
      wsMap.set(ws.raw ?? ws, { roomCode: room.code, playerName: name, role: "player" });

      sendTo(ws, {
        type: "joined", code: room.code, gameName: room.gameName, score: player.score,
        token: player.token, teams: room.teams, team: player.team ?? null,
      });
      // broadcast รวม host อยู่แล้ว
      broadcast(room, { type: "player_joined", players: getRoomPublicPlayers(room) }, ws);
      break;
    }

    case "pick_team": {
      if (!info || info.role !== "player") return;
      const room = rooms.get(info.roomCode);
      if (!room || room.phase !== "lobby" || !room.teams.includes(msg.team)) return;
      const player = room.players.get(info.playerName);
      if (!player) return;
      player.team = msg.team;
      sendTo(ws, { type: "team_set", team: player.team });
      sendTo(room.hostWs, { type: "player_joined", players: getRoomPublicPlayers(room) });
      break;
    }

    case "start_game": {
      if (!info || info.role !== "host") return;
      const room = rooms.get(info.roomCode);
      if (!room || room.players.size === 0) { sendTo(ws, { type: "error", message: "ยังไม่มีผู้เล่น" }); return; }
      if (room.phase !== "lobby") return;
      assignMissingTeams(room);
      room.players.forEach((p) => {
        if (p.team) sendTo(p.ws, { type: "team_set", team: p.team });
      });
      room.phase = "question";
      room.currentQ = 0;
      room.prevRanks = undefined;
      room.history = [];
      room.lastActivity = Date.now();
      startQuestionTimer(room);
      break;
    }

    case "answer": {
      if (!info || info.role !== "player") return;
      const room = rooms.get(info.roomCode);
      if (!room || room.phase !== "question") return;
      const now = Date.now();
      if (now < room.questionStartAt) return; // ยังอยู่ช่วงโชว์ x2
      const player = room.players.get(info.playerName);
      if (!player || player.answered) return;

      if (!Number.isInteger(msg.answer) || msg.answer < 0 || msg.answer > 3) return;

      player.answered = true;
      room.answeredCount++;
      room.answerCounts[msg.answer]++;
      room.lastActivity = now;

      const q = room.questions[room.currentQ];
      const isCorrect = msg.answer === q.correct;
      const elapsed = now - room.questionStartAt;
      player.lastCorrect = isCorrect;
      player.lastAnswerMs = elapsed;
      if (isCorrect) {
        player.correctCount++;
        if (!room.fastest || elapsed < room.fastest.ms) {
          room.fastest = { name: player.name, avatar: player.avatar, ms: elapsed };
        }
      }
      player.streak = isCorrect ? player.streak + 1 : 0;
      // โบนัสความเร็วคิดละเอียดระดับ ms (5 คะแนน/วินาทีที่เหลือ) — ตอบห่างกันเสี้ยววินาทีก็ได้คะแนนไม่เท่ากัน
      const remainingMs = Math.max(0, room.timePerQ * 1000 - elapsed);
      const timeBonus = Math.round(remainingMs / 200);
      const base = Math.round((100 + timeBonus) * streakMultiplier(player.streak));
      const pts = isCorrect ? base * (q.double ? 2 : 1) : 0;
      player.score += pts;
      player.lastPts = pts;

      sendTo(ws, { type: "answer_result", correct: isCorrect, pts, score: player.score, streak: player.streak });
      sendTo(room.hostWs, {
        type: "answer_update",
        answeredCount: room.answeredCount,
        total: room.players.size,
      });

      if (room.answeredCount >= room.players.size) {
        revealAndLeaderboard(room);
      }
      break;
    }

    // host กด "ดูอันดับ" จากหน้าเฉลย
    case "show_leaderboard": {
      if (!info || info.role !== "host") return;
      const room = rooms.get(info.roomCode);
      if (!room || room.phase !== "reveal") return;
      room.phase = "leaderboard";
      room.lastActivity = Date.now();
      broadcast(room, {
        type: "show_leaderboard",
        fastest: room.fastest ?? null,
        leaderboard: getLeaderboard(room),
        teamBoard: getTeamBoard(room),
        isLastQuestion: isLastQuestion(room),
      });
      break;
    }

    case "next_question": {
      if (!info || info.role !== "host") return;
      const room = rooms.get(info.roomCode);
      if (!room || room.phase === "lobby" || room.phase === "final") return;
      // เกินข้อสุดท้าย = จบเกม (กัน index หลุด array → server crash)
      if (room.currentQ + 1 >= room.questions.length) {
        endGame(room);
        return;
      }
      room.currentQ++;
      room.phase = "question";
      room.lastActivity = Date.now();
      startQuestionTimer(room);
      break;
    }

    case "end_game": {
      if (!info || info.role !== "host") return;
      const room = rooms.get(info.roomCode);
      if (!room) return;
      endGame(room);
      break;
    }

    // เล่นรอบใหม่ห้องเดิม: รีเซ็ตคะแนน คงผู้เล่นที่ยังต่ออยู่ กลับสู่ lobby
    case "restart_game": {
      if (!info || info.role !== "host") return;
      const room = rooms.get(info.roomCode);
      if (!room) return;
      stopTimers(room);
      room.phase = "lobby";
      room.currentQ = 0;
      room.answeredCount = 0;
      room.answerCounts = [0, 0, 0, 0];
      room.prevRanks = undefined;
      room.fastest = undefined;
      room.history = [];
      room.lastActivity = Date.now();
      // เคลียร์ผู้เล่นที่หลุดไปแล้ว ไม่ให้ชื่อค้างล็อกคนอื่น
      room.players.forEach((p, name) => { if (!isLive(p.ws)) room.players.delete(name); });
      room.players.forEach((p) => { p.score = 0; p.streak = 0; p.answered = false; p.correctCount = 0; });
      broadcast(room, {
        type: "game_reset",
        code: room.code,
        gameName: room.gameName,
        teams: room.teams,
        players: getRoomPublicPlayers(room),
      });
      break;
    }

    // อีโมจิรีแอคชัน — ส่งให้จอ host (จอใหญ่) เท่านั้น ไม่กระจายทุกคน กัน traffic พุ่งในห้องใหญ่
    case "reaction": {
      if (!info || info.role !== "player") return;
      const room = rooms.get(info.roomCode);
      if (!room || !REACTIONS.includes(msg.emoji)) return;
      const player = room.players.get(info.playerName);
      if (!player) return;
      const now = Date.now();
      if (player.lastReactAt && now - player.lastReactAt < REACT_COOLDOWN_MS) return;
      player.lastReactAt = now;
      sendTo(room.hostWs, { type: "reaction", emoji: msg.emoji, name: player.name });
      break;
    }

    // host ขอผลสรุปไปทำ CSV
    case "get_results": {
      if (!info || info.role !== "host") return;
      const room = rooms.get(info.roomCode);
      if (!room) return;
      sendTo(ws, {
        type: "results",
        gameName: room.gameName,
        history: room.history.filter(Boolean),
        players: getLeaderboard(room).map((p) => ({
          ...p,
          correct: room.players.get(p.name)?.correctCount ?? 0,
        })),
        teamBoard: getTeamBoard(room),
      });
      break;
    }

    // ออกจากห้องแบบตั้งใจ (กดกลับหน้าแรก) — ต่างจาก ws หลุดที่ต้องเผื่อกลับมา
    case "leave_room": {
      if (!info) return;
      const room = rooms.get(info.roomCode);
      wsMap.delete(ws.raw ?? ws);
      if (!room) return;
      if (info.role === "player") {
        room.players.delete(info.playerName);
        broadcast(room, { type: "player_left", players: getRoomPublicPlayers(room) });
      } else {
        destroyRoom(room, "Host ปิดห้อง");
      }
      break;
    }
  }
}

function handleClose(ws: any) {
  const info = wsMap.get(ws.raw ?? ws);
  if (!info) return;
  wsMap.delete(ws.raw ?? ws);

  const room = rooms.get(info.roomCode);
  if (!room) return;

  if (info.role === "player") {
    const player = room.players.get(info.playerName);
    // ws เก่าที่ปิดตามหลังหลังจากคนเดิมต่อ ws ใหม่ไปแล้ว — ไม่ต้องทำอะไร
    if (!player || !sameWs(player.ws, ws)) return;
    if (room.phase === "lobby") {
      // ใน lobby ลบออกได้เลย ชื่อยังว่างให้เข้าใหม่ (broadcast รวม host อยู่แล้ว)
      room.players.delete(info.playerName);
      broadcast(room, { type: "player_left", players: getRoomPublicPlayers(room) });
    }
    // ระหว่างเกม: เก็บ record ไว้ให้กลับเข้ามาต่อได้ (คะแนนคงเดิม) ws ที่ตายแล้ว broadcast จะข้ามให้เอง
  } else if (info.role === "host") {
    if (!sameWs(room.hostWs, ws)) return;
    // ให้เวลา host กลับเข้ามา (refresh หน้า / เน็ตหลุด) ก่อนปิดห้อง
    clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = setTimeout(() => {
      if (!rooms.has(info.roomCode)) return;
      if (isLive(room.hostWs)) return;
      destroyRoom(room, "Host ออกจากเกม");
    }, 60_000);
  }
}

// ══════════════════════════════════════
// ADMIN PIN — ป้องกันการแก้/ลบคลังคำถาม และการใช้ AI (มีค่าใช้จ่าย)
// ไม่ตั้ง ADMIN_PIN = เปิดหมด (สะดวกตอน dev บนเครื่อง)
// ══════════════════════════════════════
const ADMIN_PIN = process.env.ADMIN_PIN?.trim() || "";
function isAdmin(headers: Record<string, string | undefined>) {
  return !ADMIN_PIN || headers["x-admin-pin"] === ADMIN_PIN;
}

// จำกัดการเรียก AI: กันกดรัวจนบิลบาน
const AI_LIMIT_PER_HOUR = 30;
let aiCalls: number[] = [];
let aiInFlight = 0;

// ══════════════════════════════════════
// SERVER
// ══════════════════════════════════════
const app = new Elysia()
  // Serve HTML — no static plugin needed
  .get("/", () => new Response(HTML, { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
  } }))
  .get("/icon.svg", () => asset("icon.svg"))
  .get("/favicon.ico", () => asset("icon.svg"))
  .get("/og.png", () => asset("og.png"))
  .get("/apple-touch-icon.png", () => asset("apple-touch-icon.png"))
  .get("/health", () => ({ status: "ok", rooms: rooms.size }))
  .get("/api/config", () => ({ pinRequired: !!ADMIN_PIN, aiEnabled }))
  .post("/api/admin/check", ({ headers, set }) => {
    if (!isAdmin(headers)) { set.status = 401; return { error: "pin" }; }
    return { ok: true };
  })
  // ── Question bank API ──
  .get("/api/sets", () => listSets())
  .get("/api/sets/:id", ({ params, set }) => {
    const found = getSet(Number(params.id));
    if (!found) { set.status = 404; return { error: "not found" }; }
    return found;
  })
  .post("/api/sets", ({ body, headers, set }) => {
    if (!isAdmin(headers)) { set.status = 401; return { error: "pin" }; }
    const { name, questions } = (body ?? {}) as { name?: string; questions?: unknown };
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed || trimmed.length > 100) { set.status = 400; return { error: "invalid name" }; }
    if (!validateQuestions(questions)) { set.status = 400; return { error: "invalid questions" }; }
    const id = saveSet(trimmed, questions.map(cleanQuestion));
    return { id, name: trimmed, count: questions.length };
  })
  .delete("/api/sets/:id", ({ params, headers, set }) => {
    if (!isAdmin(headers)) { set.status = 401; return { error: "pin" }; }
    deleteSet(Number(params.id));
    return { ok: true };
  })
  .get("/api/questions/search", ({ query }) => {
    const term = (query.q ?? "").trim();
    if (!term) return [];
    return searchQuestions(term);
  })
  // ── AI question generator ──
  .post("/api/ai/generate", async ({ body, headers, set }) => {
    if (!aiEnabled) { set.status = 503; return { error: "ai disabled" }; }
    if (!isAdmin(headers)) { set.status = 401; return { error: "pin" }; }
    const b = (body ?? {}) as Partial<GenerateInput>;
    const topic = typeof b.topic === "string" ? b.topic.trim() : "";
    if (!topic || topic.length > 20_000) { set.status = 400; return { error: "invalid topic" }; }
    const count = Math.min(20, Math.max(3, Number(b.count) || 10));
    const difficulty = (["easy", "medium", "hard", "mixed"] as const).includes(b.difficulty as any) ? b.difficulty! : "mixed";
    const language = b.language === "en" ? "en" : "th";

    const now = Date.now();
    aiCalls = aiCalls.filter((t) => now - t < 3_600_000);
    if (aiCalls.length >= AI_LIMIT_PER_HOUR || aiInFlight >= 3) { set.status = 429; return { error: "rate limit" }; }
    aiCalls.push(now);
    aiInFlight++;
    try {
      const questions = await generateQuestions({ topic, count, difficulty, language });
      if (!questions.length) { set.status = 502; return { error: "empty" }; }
      return { questions };
    } catch (e) {
      console.error("AI generate failed:", e);
      set.status = 502;
      return { error: "ai failed" };
    } finally {
      aiInFlight--;
    }
  })
  .ws("/ws", {
    open(ws) {},
    message(ws, message) {
      try {
        handleMessage(ws, message as any);
      } catch (e) {
        // ข้อความเพี้ยนห้ามทำให้ทั้ง server ล้ม
        console.error("ws message error:", e);
      }
    },
    close(ws) {
      handleClose(ws);
    },
  })
  .listen(process.env.PORT || 3000);

console.log(`🎉 Quizzy running at http://localhost:${app.server?.port}`);

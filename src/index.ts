import { Elysia } from "elysia";
import { join } from "path";
import { readFileSync } from "fs";
import { listSets, getSet, saveSet, deleteSet, searchQuestions, validateQuestions } from "./db";

// Serve index.html natively — works without @elysiajs/static
const HTML = readFileSync(join(import.meta.dir, "../public/index.html"), "utf-8");

// ══════════════════════════════════════
// TYPES
// ══════════════════════════════════════
interface Player {
  name: string;
  avatar: string;
  ws: any;
  score: number;
  answered: boolean;
  streak: number;
  lastCorrect?: boolean;
  lastPts?: number;
  lastAnswerTime?: number;
}

interface Question {
  q: string;
  opts: string[];
  correct: number;
}

interface Room {
  code: string;
  gameName: string;
  timePerQ: number;
  questions: Question[];
  players: Map<string, Player>;
  hostWs: any;
  hostToken: string;
  hostGraceTimer?: Timer;
  phase: "lobby" | "question" | "reveal" | "leaderboard" | "final";
  currentQ: number;
  timerInterval?: Timer;
  timeLeft: number;
  answeredCount: number;
  answerCounts: number[];
  questionStartAt: number;
  fastest?: { name: string; avatar: string; ms: number };
  prevRanks?: Map<string, number>;
  lastActivity: number;
}

// ══════════════════════════════════════
// STATE
// ══════════════════════════════════════
const MAX_NAME_LEN = 20;
const rooms = new Map<string, Room>();
const wsMap = new Map<any, { roomCode: string; playerName: string; role: "host" | "player" }>();

// ══════════════════════════════════════
// HELPERS
// ══════════════════════════════════════
function genCode(): string {
  let code: string;
  do {
    code = Math.random().toString(36).substring(2, 6).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function isLive(ws: any): boolean {
  return ws?.readyState === 1;
}

function destroyRoom(room: Room, reason?: string) {
  clearInterval(room.timerInterval);
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

function getRoomPublicPlayers(room: Room) {
  return Array.from(room.players.values()).map((p) => ({
    name: p.name,
    avatar: p.avatar,
    score: p.score,
  }));
}

function getLeaderboard(room: Room) {
  return Array.from(room.players.values())
    .map((p) => ({ name: p.name, avatar: p.avatar, score: p.score, streak: p.streak }))
    .sort((a, b) => b.score - a.score);
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

// ══════════════════════════════════════
// GAME TIMER
// ══════════════════════════════════════
function startQuestionTimer(room: Room) {
  clearInterval(room.timerInterval);
  room.timeLeft = room.timePerQ;
  room.answeredCount = 0;
  room.answerCounts = [0, 0, 0, 0];
  room.questionStartAt = Date.now();
  room.fastest = undefined;
  room.players.forEach((p) => { p.answered = false; p.lastCorrect = undefined; p.lastPts = undefined; });

  broadcast(room, {
    type: "question_start",
    currentQ: room.currentQ,
    total: room.questions.length,
    question: {
      q: room.questions[room.currentQ].q,
      opts: room.questions[room.currentQ].opts,
    },
    timeLeft: room.timeLeft,
  });

  room.timerInterval = setInterval(() => {
    room.timeLeft--;
    broadcast(room, { type: "timer", timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) {
      clearInterval(room.timerInterval);
      revealAndLeaderboard(room);
    }
  }, 1000);
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
  clearInterval(room.timerInterval);
  // ค้างที่หน้าเฉลยจนกว่า host จะกด "ดูอันดับ" — ไม่ auto เปลี่ยนหน้า
  room.phase = "reveal";
  // คนที่ไม่ทันตอบข้อนี้ = สตรีคขาด
  room.players.forEach((p) => { if (!p.answered) p.streak = 0; });
  const q = room.questions[room.currentQ];
  broadcast(room, {
    type: "reveal",
    correct: q.correct,
    counts: room.answerCounts,
    answeredTotal: room.answeredCount,
    results: getQuestionResults(room),
    fastest: room.fastest ?? null,
    leaderboard: getLeaderboardWithDelta(room),
    isLastQuestion: room.currentQ >= room.questions.length - 1,
  });
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
      const code = genCode();
      const room: Room = {
        code,
        gameName: (typeof msg.gameName === "string" ? msg.gameName.trim().slice(0, 40) : "") || "Team Trivia",
        timePerQ: msg.timePerQ || 20,
        questions: msg.questions || [],
        players: new Map(),
        hostWs: ws,
        hostToken: crypto.randomUUID(),
        phase: "lobby",
        currentQ: 0,
        timeLeft: 0,
        answeredCount: 0,
        answerCounts: [0, 0, 0, 0],
        questionStartAt: 0,
        lastActivity: Date.now(),
      };
      rooms.set(code, room);
      wsMap.set(ws.raw ?? ws, { roomCode: code, playerName: "__host__", role: "host" });
      sendTo(ws, { type: "room_created", code, gameName: room.gameName, token: room.hostToken });
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
        // host หลุดกลางหน้าเฉลย → กลับมาที่หน้าอันดับ (มีปุ่มไปข้อถัดไปครบ)
        phase: room.phase === "reveal" ? "leaderboard" : room.phase,
        currentQ: room.currentQ,
        total: room.questions.length,
        players: getRoomPublicPlayers(room),
        leaderboard: getLeaderboard(room),
        fastest: room.fastest ?? null,
        timeLeft: room.timeLeft,
        answeredCount: room.answeredCount,
        isLastQuestion: room.currentQ >= room.questions.length - 1,
      };
      if (room.phase === "question") {
        const q = room.questions[room.currentQ];
        snapshot.question = { q: q.q, opts: q.opts };
      }
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

      // กลับเข้าเกมกลางคัน: อนุญาตเฉพาะชื่อเดิมที่ ws หลุดไปแล้ว (จอดับ/refresh) คะแนนคงเดิม
      if (room.phase !== "lobby") {
        if (!existing || isLive(existing.ws)) {
          sendTo(ws, { type: "error", message: existing ? "ชื่อนี้ถูกใช้แล้ว" : "เกมเริ่มไปแล้ว" });
          return;
        }
        existing.ws = ws;
        room.lastActivity = Date.now();
        wsMap.set(ws.raw ?? ws, { roomCode: room.code, playerName: name, role: "player" });
        sendTo(ws, { type: "joined", code: room.code, gameName: room.gameName, score: existing.score });
        if (room.phase === "question") {
          const q = room.questions[room.currentQ];
          sendTo(ws, {
            type: "question_start",
            currentQ: room.currentQ,
            total: room.questions.length,
            question: { q: q.q, opts: q.opts },
            timeLeft: room.timeLeft,
            answered: existing.answered,
          });
        } else if (room.phase === "reveal" || room.phase === "leaderboard") {
          // คนกลับเข้ามาระหว่างเฉลย/ดูอันดับ — พาไปหน้าอันดับเลย (เฉลยผ่านไปแล้ว)
          sendTo(ws, {
            type: "show_leaderboard",
            fastest: room.fastest ?? null,
            leaderboard: getLeaderboard(room),
            isLastQuestion: room.currentQ >= room.questions.length - 1,
          });
        } else if (room.phase === "final") {
          sendTo(ws, { type: "final", leaderboard: getLeaderboard(room) });
        }
        sendTo(room.hostWs, { type: "player_joined", players: getRoomPublicPlayers(room) });
        return;
      }

      if (existing && isLive(existing.ws)) { sendTo(ws, { type: "error", message: "ชื่อนี้ถูกใช้แล้ว" }); return; }

      const player: Player = existing ?? { name, avatar, ws, score: 0, answered: false, streak: 0 };
      player.ws = ws;
      room.players.set(name, player);
      room.lastActivity = Date.now();
      wsMap.set(ws.raw ?? ws, { roomCode: room.code, playerName: name, role: "player" });

      sendTo(ws, { type: "joined", code: room.code, gameName: room.gameName, score: player.score });
      broadcast(room, { type: "player_joined", players: getRoomPublicPlayers(room) }, ws);
      sendTo(room.hostWs, { type: "player_joined", players: getRoomPublicPlayers(room) });
      break;
    }

    case "start_game": {
      if (!info || info.role !== "host") return;
      const room = rooms.get(info.roomCode);
      if (!room || room.players.size === 0) { sendTo(ws, { type: "error", message: "ยังไม่มีผู้เล่น" }); return; }
      room.phase = "question";
      room.currentQ = 0;
      room.prevRanks = undefined;
      room.lastActivity = Date.now();
      startQuestionTimer(room);
      break;
    }

    case "answer": {
      if (!info || info.role !== "player") return;
      const room = rooms.get(info.roomCode);
      if (!room || room.phase !== "question") return;
      const player = room.players.get(info.playerName);
      if (!player || player.answered) return;

      if (!Number.isInteger(msg.answer) || msg.answer < 0 || msg.answer > 3) return;

      player.answered = true;
      room.answeredCount++;
      room.answerCounts[msg.answer]++;
      room.lastActivity = Date.now();

      const q = room.questions[room.currentQ];
      const isCorrect = msg.answer === q.correct;
      player.lastCorrect = isCorrect;
      if (isCorrect) {
        const elapsed = Date.now() - room.questionStartAt;
        if (!room.fastest || elapsed < room.fastest.ms) {
          room.fastest = { name: player.name, avatar: player.avatar, ms: elapsed };
        }
      }
      player.streak = isCorrect ? player.streak + 1 : 0;
      const timeBonus = Math.round(room.timeLeft * 5);
      const pts = isCorrect ? Math.round((100 + timeBonus) * streakMultiplier(player.streak)) : 0;
      player.score += pts;
      player.lastPts = pts;
      player.lastAnswerTime = Date.now();

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
        isLastQuestion: room.currentQ >= room.questions.length - 1,
      });
      break;
    }

    case "next_question": {
      if (!info || info.role !== "host") return;
      const room = rooms.get(info.roomCode);
      if (!room) return;
      // เกินข้อสุดท้าย = จบเกม (กัน index หลุด array → server crash)
      if (room.currentQ + 1 >= room.questions.length) {
        clearInterval(room.timerInterval);
        room.phase = "final";
        broadcast(room, { type: "final", leaderboard: getLeaderboard(room) });
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
      clearInterval(room.timerInterval);
      room.phase = "final";
      // broadcast ครอบคลุม host อยู่แล้ว — ห้ามส่งซ้ำ ไม่งั้น client เล่นลำดับประกาศผล 2 รอบ
      broadcast(room, { type: "final", leaderboard: getLeaderboard(room) });
      break;
    }

    // เล่นรอบใหม่ห้องเดิม: รีเซ็ตคะแนน คงผู้เล่นที่ยังต่ออยู่ กลับสู่ lobby
    case "restart_game": {
      if (!info || info.role !== "host") return;
      const room = rooms.get(info.roomCode);
      if (!room) return;
      clearInterval(room.timerInterval);
      room.phase = "lobby";
      room.currentQ = 0;
      room.answeredCount = 0;
      room.answerCounts = [0, 0, 0, 0];
      room.prevRanks = undefined;
      room.fastest = undefined;
      room.lastActivity = Date.now();
      // เคลียร์ผู้เล่นที่หลุดไปแล้ว ไม่ให้ชื่อค้างล็อกคนอื่น
      room.players.forEach((p, name) => { if (!isLive(p.ws)) room.players.delete(name); });
      room.players.forEach((p) => { p.score = 0; p.streak = 0; p.answered = false; });
      broadcast(room, {
        type: "game_reset",
        code: room.code,
        gameName: room.gameName,
        players: getRoomPublicPlayers(room),
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
    if (room.phase === "lobby") {
      // ใน lobby ลบออกได้เลย ชื่อยังว่างให้เข้าใหม่
      room.players.delete(info.playerName);
      broadcast(room, { type: "player_left", players: getRoomPublicPlayers(room) });
      sendTo(room.hostWs, { type: "player_left", players: getRoomPublicPlayers(room) });
    }
    // ระหว่างเกม: เก็บ record ไว้ให้กลับเข้ามาต่อได้ (คะแนนคงเดิม) ws ที่ตายแล้ว broadcast จะข้ามให้เอง
  } else if (info.role === "host") {
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
// SERVER
// ══════════════════════════════════════
const app = new Elysia()
  // Serve HTML — no static plugin needed
  .get("/", () => new Response(HTML, { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
  } }))
  .get("/health", () => ({ status: "ok", rooms: rooms.size }))
  // ── Question bank API ──
  .get("/api/sets", () => listSets())
  .get("/api/sets/:id", ({ params, set }) => {
    const found = getSet(Number(params.id));
    if (!found) { set.status = 404; return { error: "not found" }; }
    return found;
  })
  .post("/api/sets", ({ body, set }) => {
    const { name, questions } = (body ?? {}) as { name?: string; questions?: unknown };
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed || trimmed.length > 100) { set.status = 400; return { error: "invalid name" }; }
    if (!validateQuestions(questions)) { set.status = 400; return { error: "invalid questions" }; }
    const id = saveSet(trimmed, questions);
    return { id, name: trimmed, count: questions.length };
  })
  .delete("/api/sets/:id", ({ params }) => {
    deleteSet(Number(params.id));
    return { ok: true };
  })
  .get("/api/questions/search", ({ query }) => {
    const term = (query.q ?? "").trim();
    if (!term) return [];
    return searchQuestions(term);
  })
  .ws("/ws", {
    open(ws) {},
    message(ws, message) {
      handleMessage(ws, message as any);
    },
    close(ws) {
      handleClose(ws);
    },
  })
  .listen(process.env.PORT || 3000);

console.log(`🎮 Trivia Battle running at http://localhost:${app.server?.port}`);

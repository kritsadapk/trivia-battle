import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { join } from "path";

// ══════════════════════════════════════
// TYPES
// ══════════════════════════════════════
interface Player {
  name: string;
  avatar: string;
  ws: any;
  score: number;
  answered: boolean;
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
  phase: "lobby" | "question" | "leaderboard" | "final";
  currentQ: number;
  timerInterval?: Timer;
  timeLeft: number;
  answeredCount: number;
}

// ══════════════════════════════════════
// STATE
// ══════════════════════════════════════
const rooms = new Map<string, Room>();
// ws → { roomCode, playerName }
const wsMap = new Map<any, { roomCode: string; playerName: string; role: "host" | "player" }>();

// ══════════════════════════════════════
// HELPERS
// ══════════════════════════════════════
function genCode(): string {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

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
    .map((p) => ({ name: p.name, avatar: p.avatar, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

// ══════════════════════════════════════
// GAME TIMER
// ══════════════════════════════════════
function startQuestionTimer(room: Room) {
  clearInterval(room.timerInterval);
  room.timeLeft = room.timePerQ;
  room.answeredCount = 0;
  room.players.forEach((p) => (p.answered = false));

  broadcast(room, {
    type: "question_start",
    currentQ: room.currentQ,
    total: room.questions.length,
    question: {
      q: room.questions[room.currentQ].q,
      opts: room.questions[room.currentQ].opts,
      // Don't send correct answer yet
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

function revealAndLeaderboard(room: Room) {
  clearInterval(room.timerInterval);
  room.phase = "leaderboard";

  const q = room.questions[room.currentQ];
  broadcast(room, {
    type: "reveal",
    correct: q.correct,
    leaderboard: getLeaderboard(room),
    isLastQuestion: room.currentQ >= room.questions.length - 1,
  });
}

// ══════════════════════════════════════
// MESSAGE HANDLERS
// ══════════════════════════════════════
function handleMessage(ws: any, raw: string) {
  let msg: any;
  try { msg = JSON.parse(raw); } catch { return; }

  const info = wsMap.get(ws);

  switch (msg.type) {

    // ── HOST: Create room ──
    case "create_room": {
      const code = genCode();
      const room: Room = {
        code,
        gameName: msg.gameName || "Team Trivia",
        timePerQ: msg.timePerQ || 20,
        questions: msg.questions || [],
        players: new Map(),
        hostWs: ws,
        phase: "lobby",
        currentQ: 0,
        timeLeft: 0,
        answeredCount: 0,
      };
      rooms.set(code, room);
      wsMap.set(ws, { roomCode: code, playerName: "__host__", role: "host" });
      sendTo(ws, { type: "room_created", code, gameName: room.gameName });
      break;
    }

    // ── PLAYER: Join room ──
    case "join_room": {
      const room = rooms.get(msg.code?.toUpperCase());
      if (!room) { sendTo(ws, { type: "error", message: "ไม่พบห้องนี้" }); return; }
      if (room.phase !== "lobby") { sendTo(ws, { type: "error", message: "เกมเริ่มไปแล้ว" }); return; }
      if (room.players.has(msg.name)) { sendTo(ws, { type: "error", message: "ชื่อนี้ถูกใช้แล้ว" }); return; }

      const player: Player = { name: msg.name, avatar: msg.avatar, ws, score: 0, answered: false };
      room.players.set(msg.name, player);
      wsMap.set(ws, { roomCode: room.code, playerName: msg.name, role: "player" });

      sendTo(ws, { type: "joined", code: room.code, gameName: room.gameName });
      broadcast(room, { type: "player_joined", players: getRoomPublicPlayers(room) }, ws);
      sendTo(room.hostWs, { type: "player_joined", players: getRoomPublicPlayers(room) });
      break;
    }

    // ── HOST: Start game ──
    case "start_game": {
      if (!info || info.role !== "host") return;
      const room = rooms.get(info.roomCode);
      if (!room || room.players.size === 0) { sendTo(ws, { type: "error", message: "ยังไม่มีผู้เล่น" }); return; }
      room.phase = "question";
      room.currentQ = 0;
      startQuestionTimer(room);
      break;
    }

    // ── PLAYER: Answer ──
    case "answer": {
      if (!info || info.role !== "player") return;
      const room = rooms.get(info.roomCode);
      if (!room || room.phase !== "question") return;
      const player = room.players.get(info.playerName);
      if (!player || player.answered) return;

      player.answered = true;
      room.answeredCount++;

      const q = room.questions[room.currentQ];
      const isCorrect = msg.answer === q.correct;
      const timeBonus = Math.round(room.timeLeft * 5);
      const pts = isCorrect ? 100 + timeBonus : 0;
      player.score += pts;
      player.lastAnswerTime = Date.now();

      sendTo(ws, { type: "answer_result", correct: isCorrect, pts, score: player.score });

      // Update host with answered count
      sendTo(room.hostWs, {
        type: "answer_update",
        answeredCount: room.answeredCount,
        total: room.players.size,
      });

      // All answered → reveal early
      if (room.answeredCount >= room.players.size) {
        revealAndLeaderboard(room);
      }
      break;
    }

    // ── HOST: Next question ──
    case "next_question": {
      if (!info || info.role !== "host") return;
      const room = rooms.get(info.roomCode);
      if (!room) return;
      room.currentQ++;
      room.phase = "question";
      startQuestionTimer(room);
      break;
    }

    // ── HOST: End game ──
    case "end_game": {
      if (!info || info.role !== "host") return;
      const room = rooms.get(info.roomCode);
      if (!room) return;
      clearInterval(room.timerInterval);
      room.phase = "final";
      broadcast(room, {
        type: "final",
        leaderboard: getLeaderboard(room),
      });
      sendTo(room.hostWs, {
        type: "final",
        leaderboard: getLeaderboard(room),
      });
      break;
    }
  }
}

function handleClose(ws: any) {
  const info = wsMap.get(ws);
  if (!info) return;
  wsMap.delete(ws);

  const room = rooms.get(info.roomCode);
  if (!room) return;

  if (info.role === "player") {
    room.players.delete(info.playerName);
    broadcast(room, { type: "player_left", players: getRoomPublicPlayers(room) });
    sendTo(room.hostWs, { type: "player_left", players: getRoomPublicPlayers(room) });
  } else if (info.role === "host") {
    // Host disconnected → clean up room after delay
    setTimeout(() => {
      if (!rooms.has(info.roomCode)) return;
      broadcast(room, { type: "error", message: "Host ออกจากเกม" });
      clearInterval(room.timerInterval);
      rooms.delete(info.roomCode);
    }, 5000);
  }
}

// ══════════════════════════════════════
// SERVER
// ══════════════════════════════════════
const app = new Elysia()
  .use(staticPlugin({ assets: "public", prefix: "/" }))
  .ws("/ws", {
    open(ws) {},
    message(ws, message) {
      handleMessage(ws, message as string);
    },
    close(ws) {
      handleClose(ws);
    },
  })
  .get("/health", () => ({ status: "ok", rooms: rooms.size }))
  .listen(process.env.PORT || 3000);

console.log(`🎮 Trivia Battle running at http://localhost:${app.server?.port}`);

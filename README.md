# 🏆 Team Trivia Battle

เกมตอบคำถาม Real-time สำหรับทีม — Bun + Elysia.js + WebSocket

## Stack
- **Runtime**: Bun
- **Framework**: Elysia.js
- **Realtime**: WebSocket (built-in)
- **Database**: SQLite (`bun:sqlite`) — เก็บคลังคำถาม
- **Frontend**: Vanilla HTML/CSS/JS (single file)
- **Hosting**: Render.com (Docker)

---

## 🚀 Deploy บน Render

### Step 1 — Push ขึ้น GitHub

```bash
git add .
git commit -m "deploy"
git push
```

### Step 2 — สร้าง / อัปเดต Service

**ครั้งแรก:** https://render.com → **New +** → **Web Service** → เลือก repo นี้
→ Runtime: **Docker**, Region: **Singapore**, Plan ตามต้องการ → Create
(healthcheck `/health` อยู่ใน `render.yaml` แล้ว)

**มี service อยู่แล้ว:** push แล้ว Render auto-deploy ให้เอง

แชร์ URL ให้ทีมแล้วเล่นได้เลย 🎉 (WebSocket ใช้ port เดียวกับ HTTP ไม่ต้องตั้งอะไรเพิ่ม)

### ⚠️ เรื่องคลังคำถามบน Free plan

คลังคำถาม (ชุดคำถามที่กด "บันทึก") เก็บใน SQLite บน disk ของ service —
**Free plan ไม่มี persistent disk** ดังนั้น:

| Plan | ผล |
|------|-----|
| **Free** | เกมเล่นได้ครบทุกอย่าง แต่คลังคำถามจะหายเมื่อ service หลับ (idle 15 นาที) หรือ redeploy |
| **Starter ขึ้นไป** | เพิ่ม **Persistent Disk** mount ที่ `/data` (เปิดคอมเมนต์ส่วน `disk:` ใน `render.yaml`) → คลังคำถามอยู่ถาวร |

ถ้าอยู่ Free plan: เตรียมคำถามเสร็จให้**บันทึกชุด + สร้างห้องเล่นต่อเนื่องในคราวเดียว** จะไม่มีปัญหา
(ห้องเกมและคะแนนระหว่างเล่นอยู่ใน memory ไม่เกี่ยวกับ disk — spin down ตอนไม่มีคนใช้เท่านั้น ระหว่างเล่นมี traffic ตลอด service ไม่หลับ)

### ⏰ Free plan หลับ 15 นาที

เปิด URL อุ่นเครื่องก่อนเริ่มงานจริง ~1 นาที (ตื่นครั้งแรกช้า 30-60 วิ) แล้วค่อยแชร์ให้ทีม

---

## 🎮 วิธีเล่น

### Host (คนจัดเกม)
1. เปิด URL → กด **"สร้างเกม"**
2. เพิ่มคำถามเอง / โหลดตัวอย่าง / โหลดจาก **คลังคำถาม** (บันทึกชุดไว้ใช้ซ้ำได้)
3. กด **"สร้างห้องเกม"** → ได้รหัส 4 ตัว + **QR code**
4. ทีมสแกน QR หรือใส่รหัส → กด **"เริ่มเกม"**
5. คุมจังหวะเอง: เฉลย → (ดูอันดับ หรือข้าม) → ข้อถัดไป
6. จบเกมกด **"เล่นรอบใหม่ (คนเดิม)"** ได้เลย ไม่ต้องตั้งห้องใหม่

### ผู้เล่น
1. สแกน QR หรือเปิด URL → **"เข้าร่วม"** → ใส่รหัส + ชื่อ
2. ตอบเร็ว = โบนัสเยอะ ตอบถูกติดกัน = ตัวคูณสตรีค 🔥
3. เน็ตหลุด / จอดับ / เผลอ refresh — กลับเข้าห้องเดิมอัตโนมัติ คะแนนไม่หาย

---

## ⚡ ระบบคะแนน

| สถานการณ์ | คะแนน |
|-----------|-------|
| ตอบถูก | 100 + (เวลาที่เหลือ × 5) |
| สตรีค 2 ข้อติด | × 1.2 |
| สตรีค 3 ข้อติด | × 1.5 |
| สตรีค 5 ข้อติด | × 2 |
| ตอบผิด / ไม่ตอบ | 0 (สตรีคขาด) |

---

## 🛠️ Run Local

```bash
bun install
bun run dev
# เปิด http://localhost:3000 สอง tab: Host + Player
```

ทดสอบแบบ Docker (เหมือน production):

```bash
docker build -t trivia-battle .
docker run -p 3000:3000 -v $(pwd)/data:/data trivia-battle
```

---

## 📁 โครงสร้างโปรเจกต์

```
trivia-battle/
├── src/
│   ├── index.ts        # Elysia server + WebSocket + game logic
│   └── db.ts           # SQLite — คลังคำถาม (question sets + search API)
├── public/
│   └── index.html      # Frontend ทั้งหมด (single file)
├── Dockerfile          # Render build จากตัวนี้
├── render.yaml         # Render config (healthcheck /health + disk ตัวเลือก)
└── package.json
```

## 🔧 Env

| ตัวแปร | ค่าเริ่มต้น | หมายเหตุ |
|--------|------------|----------|
| `PORT` | 3000 | render.yaml ตั้งไว้แล้ว |
| `DB_PATH` | `data/trivia.db` (local) / `/data/trivia.db` (Docker) | ชี้ไป Persistent Disk ถ้ามี |

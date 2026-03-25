# 🏆 Team Trivia Battle

เกมตอบคำถาม Real-time สำหรับทีม WFH — Bun + Elysia.js + WebSocket

## Stack
- **Runtime**: Bun
- **Framework**: Elysia.js
- **Realtime**: WebSocket (built-in)
- **Frontend**: Vanilla HTML/CSS/JS (single file)
- **Hosting**: Render.com (Free)

---

## 🚀 Deploy บน Render.com (ฟรี ไม่ต้องบัตร)

### ขั้นตอนทั้งหมด ~5 นาที

---

### Step 1 — Push ขึ้น GitHub

```bash
cd trivia-battle
git init
git add .
git commit -m "init: trivia battle"
```

สร้าง repo ใหม่บน GitHub แล้ว:

```bash
git remote add origin https://github.com/YOUR_USERNAME/trivia-battle.git
git branch -M main
git push -u origin main
```

---

### Step 2 — Deploy บน Render

1. ไปที่ **https://render.com** → Sign up / Login (ใช้ GitHub ได้เลย)
2. กด **"New +"** → เลือก **"Web Service"**
3. กด **"Connect a repository"** → เลือก repo `trivia-battle`
4. ตั้งค่าดังนี้:

| ฟิลด์ | ค่า |
|-------|-----|
| **Name** | trivia-battle |
| **Region** | Singapore (ใกล้ไทยสุด) |
| **Branch** | main |
| **Runtime** | Docker |
| **Plan** | Free |

5. กด **"Create Web Service"**
6. รอ build ~3-5 นาที
7. ได้ URL เช่น `https://trivia-battle.onrender.com`

---

### Step 3 — แชร์ให้ทีม

แชร์ URL ใน Line/Slack → ทีมเปิดบราวเซอร์แล้วเล่นได้เลย! 🎉

---

## ⚠️ Free Tier — สิ่งที่ต้องรู้

| เรื่อง | รายละเอียด |
|--------|-----------|
| **Sleep** | Service หยุดหลังไม่มีคนใช้ 15 นาที |
| **Wake up** | ครั้งแรกช้า ~30-60 วินาที |
| **วิธีแก้** | เปิด URL ก่อนเล่น 1 นาที แล้วรีเฟรช |
| **ระหว่างเล่น** | ไม่มีปัญหา เพราะมี traffic ตลอด |

---

## 🎮 วิธีเล่น

### Host (คนจัดเกม)
1. เปิด URL → กด **"สร้างเกม"**
2. ตั้งชื่อเกม + เวลาต่อข้อ
3. เพิ่มคำถาม หรือกด **"โหลดตัวอย่าง"** (10 ข้อ)
4. กด **"สร้างห้องเกม"** → ได้รหัส 4 ตัว เช่น `AB12`
5. แชร์รหัสให้ทีมใน Line
6. รอคนเข้า → กด **"เริ่มเกม"**

### ผู้เล่น
1. เปิด URL เดียวกัน → กด **"เข้าร่วม"**
2. ใส่รหัสห้อง + ชื่อ → กด **"เข้าร่วมเกม"**
3. รอ Host เริ่ม → ตอบคำถามแข่งกัน!

---

## ⚡ ระบบคะแนน

| สถานการณ์ | คะแนน |
|-----------|-------|
| ตอบถูก + เวลาเหลือ 20 วิ | 100 + 100 = **200** |
| ตอบถูก + เวลาเหลือ 10 วิ | 100 + 50 = **150** |
| ตอบถูก + เวลาเหลือ 5 วิ  | 100 + 25 = **125** |
| ตอบผิด / ไม่ตอบ | **0** |

> ตอบเร็วสุดในทีม + ถูก = คะแนนสูงสุด!

---

## 🛠️ Run Local (ทดสอบก่อน deploy)

```bash
bun install
bun run dev
# เปิด http://localhost:3000
# เปิด 2 tab: tab แรก Host, tab สอง Player
```

---

## 📁 โครงสร้างโปรเจกต์

```
trivia-battle/
├── src/
│   └── index.ts        # Elysia server + WebSocket + game logic
├── public/
│   └── index.html      # Frontend ทั้งหมด (single file)
├── Dockerfile          # Render ใช้ตัวนี้ build
├── render.yaml         # Render config
├── package.json
└── tsconfig.json
```

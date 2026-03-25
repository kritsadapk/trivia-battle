# 🏆 Team Trivia Battle

เกมตอบคำถาม Real-time สำหรับทีม WFH — Bun + Elysia.js + WebSocket

## Stack
- **Runtime**: Bun
- **Framework**: Elysia.js
- **Realtime**: WebSocket (built-in)
- **Frontend**: Vanilla HTML/CSS/JS (single file)
- **Hosting**: Railway

---

## 🚀 Deploy บน Railway (5 นาที)

### ขั้นตอน

**1. Push ขึ้น GitHub**
```bash
git init
git add .
git commit -m "init: trivia battle"
git remote add origin https://github.com/YOUR_USERNAME/trivia-battle.git
git push -u origin main
```

**2. Deploy บน Railway**
1. ไปที่ https://railway.app → Sign in with GitHub
2. กด **"New Project"** → **"Deploy from GitHub repo"**
3. เลือก repo `trivia-battle`
4. Railway จะ detect Dockerfile และ build อัตโนมัติ
5. รอ 2-3 นาที → กด **"Generate Domain"**
6. ได้ URL เช่น `https://trivia-battle-production.up.railway.app`

**3. แชร์ให้ทีม**
แชร์ URL นั้นใน Line/Slack → ทีมเปิดบราวเซอร์แล้วเล่นได้เลย!

---

## 🎮 วิธีเล่น

### Host (คนจัดเกม)
1. เปิด URL → กด **"สร้างเกม"**
2. ตั้งชื่อเกม + เวลาต่อข้อ
3. เพิ่มคำถาม (หรือกด "โหลดตัวอย่าง")
4. กด **"สร้างห้องเกม"** → จะได้รหัส 4 ตัว เช่น `AB12`
5. แชร์รหัสให้ทีมใน Line
6. รอคนเข้า → กด **"เริ่มเกม"**

### ผู้เล่น
1. เปิด URL เดียวกัน → กด **"เข้าร่วม"**
2. ใส่รหัสห้อง + ชื่อ → กด **"เข้าร่วมเกม"**
3. รอ Host เริ่ม → ตอบคำถามแข่งกัน!

---

## ⚡ ระบบคะแนน
- ตอบถูก = **100 คะแนน** + โบนัสเวลา (`เวลาที่เหลือ × 5`)
- ตอบผิด = 0 คะแนน
- ตอบเร็วสุด + ถูก = คะแนนสูงสุด

---

## 🛠️ Run Local

```bash
bun install
bun run dev
# เปิด http://localhost:3000
```

---

## 📁 โครงสร้าง

```
trivia-battle/
├── src/
│   └── index.ts       # Elysia server + WebSocket + game logic
├── public/
│   └── index.html     # Frontend (single file)
├── Dockerfile
├── railway.json
└── package.json
```

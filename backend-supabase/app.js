const express = require("express");
const http = require("http");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const dotenv = require("dotenv");
const path = require("path");
const { Server } = require("socket.io");

dotenv.config();

const userRoutes = require("./routes/userRoutes");
const chatRoutes = require("./routes/chatRoutes");
const messageRoutes = require("./routes/messageRoutes");

const app = express();
const server = http.createServer(app);

const fileUpload = require("express-fileupload");

// Middleware
app.use(cors({
  origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
  credentials: true,
}));
app.use(cookieParser());
app.use(fileUpload({ limits: { fileSize: 50 * 1024 * 1024 } }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// API Routes
app.use("/api/user", userRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/message", messageRoutes);

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "ok", backend: "supabase", timestamp: new Date().toISOString() });
});

// Production static file serving
const rootDir = path.resolve();
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(rootDir, "frontend", "build")));
  app.get("*", (req, res) => {
    res.sendFile(path.resolve(rootDir, "frontend", "build", "index.html"));
  });
} else {
  app.get("/", (req, res) => {
    res.send("ChatMind Supabase Backend API is running...");
  });
}

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Error:", err.stack || err.message);
  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message || "Internal Server Error",
  });
});

// Socket.IO Server for real-time messaging
const io = new Server(server, {
  pingTimeout: 60000,
  cors: {
    origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  console.log("Connected to Socket.io client:", socket.id);

  socket.on("setup", (userData) => {
    if (!userData) return;
    const userId = userData._id || userData.id;
    socket.join(userId);
    socket.emit("connected");
    console.log(`User ${userId} joined their personal room`);
  });

  socket.on("join chat", (room) => {
    socket.join(room);
    console.log("User joined chat room: " + room);
  });

  socket.on("typing", (room) => {
    socket.in(room).emit("typing");
  });

  socket.on("stop typing", (room) => {
    socket.in(room).emit("stop typing");
  });

  socket.on("new message", (newMessageRecieved) => {
    const chat = newMessageRecieved?.chat;
    if (!chat || !chat.users) return;

    chat.users.forEach((user) => {
      const recipientId = user._id || user.id;
      const senderId = newMessageRecieved.sender?._id || newMessageRecieved.sender?.id;

      if (recipientId === senderId) return;

      socket.in(recipientId).emit("message recieved", newMessageRecieved);
    });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected from socket:", socket.id);
  });
});

let PORT = process.env.PORT || 5001;

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.warn(`⚠️ Port ${PORT} is busy, attempting port ${Number(PORT) + 1}...`);
    PORT = Number(PORT) + 1;
    server.listen(PORT);
  } else {
    console.error("Server error:", e);
  }
});

server.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`🚀 ChatMind Supabase Server started on port ${PORT}`);
  console.log(`⚡ Supabase URL: ${process.env.SUPABASE_URL || "Not set (set in .env)"}`);
  console.log(`========================================`);
});

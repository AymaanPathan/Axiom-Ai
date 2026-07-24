// backend/src/config/socket.ts
import { Server as IOServer } from "socket.io";
import type { Server as HTTPServer } from "node:http";

let io: IOServer | undefined;

export function initSocket(httpServer: HTTPServer): IOServer {
  io = new IOServer(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:5173",
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    socket.on("run:subscribe", (runId: string) => socket.join(`run:${runId}`));
    socket.on("run:unsubscribe", (runId: string) =>
      socket.leave(`run:${runId}`),
    );

    socket.on("service:subscribe", (repositoryId: string) =>
      socket.join(`repo:${repositoryId}`),
    );
    socket.on("service:unsubscribe", (repositoryId: string) =>
      socket.leave(`repo:${repositoryId}`),
    );

    // NEW — arena-scoped room. The Optimization Arena view joins this the
    // moment it has an arenaId (before any candidate has started) so it
    // catches every `arena:candidate:status` / `arena:candidate:metrics`
    // / `arena:complete` event for that run. Same subscribe/unsubscribe
    // shape as run: and service: above, for consistency.
    socket.on("arena:subscribe", (arenaId: string) =>
      socket.join(`arena:${arenaId}`),
    );
    socket.on("arena:unsubscribe", (arenaId: string) =>
      socket.leave(`arena:${arenaId}`),
    );
  });

  return io;
}

export function getIO(): IOServer {
  if (!io)
    throw new Error("Socket.IO not initialized — call initSocket() first");
  return io;
}

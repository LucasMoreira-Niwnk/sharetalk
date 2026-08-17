import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    roomId: text("room_id").notNull(),
    authorId: text("author_id").notNull(),
    authorName: text("author_name").notNull(),
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_chat_messages_room_created").on(table.roomId, table.createdAt)],
);

export const roomSignals = sqliteTable(
  "room_signals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    roomId: text("room_id").notNull(),
    senderId: text("sender_id").notNull(),
    recipientId: text("recipient_id"),
    kind: text("kind").notNull(),
    payload: text("payload").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_room_signals_room_id").on(table.roomId, table.id)],
);

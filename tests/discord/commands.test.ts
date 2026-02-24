import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Message } from "discord.js";
import {
  handleSlashCommand,
  buildGuideMarkdown,
  isSaveCommand,
  isCancelCommand,
  guideSessions,
  SLASH_COMMANDS,
} from "../../src/discord/commands.js";
import * as postgres from "../../src/store/postgres.js";

vi.mock("../../src/store/postgres.js", () => ({
  setTroubleshootingGuide: vi.fn().mockResolvedValue(undefined),
  getAlertStatusSummary: vi.fn().mockResolvedValue(null),
  getAlertStatusTable: vi.fn().mockResolvedValue([]),
  getLastAlertEvent: vi.fn().mockResolvedValue(null),
  getTroubleshootingGuide: vi.fn().mockResolvedValue(null),
  getAllTroubleshootingGuides: vi.fn().mockResolvedValue({}),
  getPool: vi.fn(),
  initSchema: vi.fn().mockResolvedValue(undefined),
  insertAlertEvent: vi.fn().mockResolvedValue(undefined),
  getAlertsConfigFromDb: vi.fn().mockResolvedValue(null),
  setAlertsConfigInDb: vi.fn().mockResolvedValue(undefined),
}));

const TEST_THREAD_ID = "thread-123";
const TEST_USER_ID = "user-456";
const TEST_ALERT_NAME = "RdsCpuUtilizationHigh";

function createMockMessage(overrides: Partial<{ content: string; createdTimestamp: number; attachments: Map<string, { name: string | null; url: string; contentType: string | null }> }> = {}): Message {
  const { content = "", createdTimestamp = 0, attachments = new Map() } = overrides;
  return {
    content,
    createdTimestamp,
    attachments: { values: () => attachments.values(), get: () => undefined },
    author: { id: TEST_USER_ID },
  } as unknown as Message;
}

function createMockInteraction(
  commandName: string,
  options: { getString?: (name: string, required?: boolean) => string | null } = {},
  channel: { id: string; isThread?: () => boolean; parent?: unknown; delete?: ReturnType<typeof vi.fn>; threads?: { create: ReturnType<typeof vi.fn> }; members?: { add: ReturnType<typeof vi.fn> }; send?: ReturnType<typeof vi.fn> } | null = null
) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const reply = vi.fn().mockResolvedValue(undefined);
  const followUp = vi.fn().mockResolvedValue(undefined);
  return {
    isChatInputCommand: () => true,
    commandName,
    options: {
      getString: (name: string, required?: boolean) => options.getString?.(name, required) ?? null,
    },
    user: { id: TEST_USER_ID, username: "testuser" },
    channel,
    channelId: channel?.id ?? null,
    guildId: "guild-1",
    deferReply,
    editReply,
    reply,
    followUp,
  } as unknown as Parameters<typeof handleSlashCommand>[0];
}

function createMockLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("guide helpers", () => {
  describe("buildGuideMarkdown", () => {
    it("returns empty string for no messages", () => {
      expect(buildGuideMarkdown([])).toBe("");
    });

    it("concatenates text content in order of createdTimestamp", () => {
      const msgs = [
        createMockMessage({ content: "Step 1", createdTimestamp: 1000 }),
        createMockMessage({ content: "Step 2", createdTimestamp: 2000 }),
      ];
      expect(buildGuideMarkdown(msgs)).toBe("Step 1\n\nStep 2");
    });

    it("excludes /save and /cancel from output", () => {
      const msgs = [
        createMockMessage({ content: "Guide text", createdTimestamp: 1000 }),
        createMockMessage({ content: "/save", createdTimestamp: 2000 }),
        createMockMessage({ content: "/cancel", createdTimestamp: 3000 }),
      ];
      expect(buildGuideMarkdown(msgs)).toBe("Guide text");
    });

    it("excludes only exact /save and /cancel (not plain save/cancel)", () => {
      const msgs = [
        createMockMessage({ content: "/save", createdTimestamp: 1000 }),
        createMockMessage({ content: "/cancel", createdTimestamp: 2000 }),
      ];
      expect(buildGuideMarkdown(msgs)).toBe("");
    });

    it("includes image attachments as markdown image syntax", () => {
      const att = new Map<string, { name: string | null; url: string; contentType: string | null }>();
      att.set("1", { name: "pic.png", url: "https://cdn.example/pic.png", contentType: "image/png" });
      const msgs = [createMockMessage({ content: "See below", createdTimestamp: 1000, attachments: att })];
      expect(buildGuideMarkdown(msgs)).toContain("![pic.png](https://cdn.example/pic.png)");
    });

    it("includes non-image attachments as markdown links", () => {
      const att = new Map<string, { name: string | null; url: string; contentType: string | null }>();
      att.set("1", { name: "file.pdf", url: "https://cdn.example/file.pdf", contentType: "application/pdf" });
      const msgs = [createMockMessage({ content: "", createdTimestamp: 1000, attachments: att })];
      expect(buildGuideMarkdown(msgs)).toContain("[file.pdf](https://cdn.example/file.pdf)");
    });

    it("preserves order: messages by timestamp, attachments then text within each message", () => {
      const att1 = new Map<string, { name: string | null; url: string; contentType: string | null }>();
      att1.set("1", { name: "first.png", url: "https://cdn.example/first.png", contentType: "image/png" });
      const att2 = new Map<string, { name: string | null; url: string; contentType: string | null }>();
      att2.set("2", { name: "second.png", url: "https://cdn.example/second.png", contentType: "image/png" });
      const msgs = [
        createMockMessage({ content: "Caption after first image", createdTimestamp: 2000, attachments: att1 }),
        createMockMessage({ content: "Text only message", createdTimestamp: 1000 }),
        createMockMessage({ content: "Caption after second", createdTimestamp: 3000, attachments: att2 }),
      ];
      const out = buildGuideMarkdown(msgs);
      const idxTextOnly = out.indexOf("Text only message");
      const idxFirstImg = out.indexOf("![first.png](https://cdn.example/first.png)");
      const idxFirstCaption = out.indexOf("Caption after first image");
      const idxSecondImg = out.indexOf("![second.png](https://cdn.example/second.png)");
      const idxSecondCaption = out.indexOf("Caption after second");
      expect(idxTextOnly).toBeLessThan(idxFirstImg);
      expect(idxFirstImg).toBeLessThan(idxFirstCaption);
      expect(idxFirstCaption).toBeLessThan(idxSecondImg);
      expect(idxSecondImg).toBeLessThan(idxSecondCaption);
    });
  });

  describe("isSaveCommand", () => {
    it("returns true for /save and save (case insensitive)", () => {
      expect(isSaveCommand("/save")).toBe(true);
      expect(isSaveCommand("save")).toBe(true);
      expect(isSaveCommand("/Save")).toBe(true);
      expect(isSaveCommand("  /save  ")).toBe(true);
    });

    it("returns false for other strings", () => {
      expect(isSaveCommand("/cancel")).toBe(false);
      expect(isSaveCommand("saved")).toBe(false);
      expect(isSaveCommand("")).toBe(false);
    });
  });

  describe("isCancelCommand", () => {
    it("returns true for /cancel and cancel (case insensitive)", () => {
      expect(isCancelCommand("/cancel")).toBe(true);
      expect(isCancelCommand("cancel")).toBe(true);
      expect(isCancelCommand("  /cancel  ")).toBe(true);
    });

    it("returns false for other strings", () => {
      expect(isCancelCommand("/save")).toBe(false);
      expect(isCancelCommand("cancelled")).toBe(false);
    });
  });
});

describe("slash commands: add-guide", () => {
  beforeEach(() => {
    guideSessions.clear();
    vi.resetModules();
  });

  it("replies with database unavailable when DATABASE_URL is unset", async () => {
    const orig = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const interaction = createMockInteraction("add-guide", { getString: () => TEST_ALERT_NAME }, { id: "ch-1", isThread: () => false, threads: { create: vi.fn() } });
    const log = createMockLog();
    await handleSlashCommand(interaction, log);
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Troubleshooting guides are not available (database not configured)." })
    );
    if (orig !== undefined) process.env.DATABASE_URL = orig;
  });

  it("replies with error when alert_name is empty", async () => {
    process.env.DATABASE_URL = "postgres://local/db";
    const interaction = createMockInteraction("add-guide", { getString: () => "" }, { id: "ch-1", isThread: () => false, threads: { create: vi.fn() } });
    const log = createMockLog();
    await handleSlashCommand(interaction, log);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("alert_name") }));
  });

  it("replies when channel does not support threads", async () => {
    process.env.DATABASE_URL = "postgres://local/db";
    const interaction = createMockInteraction("add-guide", { getString: () => TEST_ALERT_NAME }, null);
    const log = createMockLog();
    await handleSlashCommand(interaction, log);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "This channel does not support threads. Use a text channel." })
    );
  });

  it("creates thread and registers guide session on success", async () => {
    process.env.DATABASE_URL = "postgres://local/db";
    const threadSend = vi.fn().mockResolvedValue(null);
    const membersAdd = vi.fn().mockResolvedValue(undefined);
    const collectorStop = vi.fn();
    const createMessageCollector = vi.fn().mockReturnValue({ on: vi.fn(), stop: collectorStop });
    const createdThread = {
      id: TEST_THREAD_ID,
      members: { add: membersAdd },
      send: threadSend,
      createMessageCollector,
    };
    const threadsCreate = vi.fn().mockResolvedValue(createdThread);
    const textChannel = {
      id: "parent-1",
      isThread: () => false,
      threads: { create: threadsCreate },
    };
    const interaction = createMockInteraction("add-guide", { getString: () => TEST_ALERT_NAME }, textChannel);
    const log = createMockLog();

    await handleSlashCommand(interaction, log);

    expect(threadsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringContaining("Guide:"), type: 12 })
    );
    expect(membersAdd).toHaveBeenCalledWith(TEST_USER_ID);
    expect(threadSend).toHaveBeenCalledWith(expect.stringContaining("Troubleshooting guide for"));
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining(TEST_THREAD_ID) })
    );
    expect(guideSessions.has(TEST_THREAD_ID)).toBe(true);
    expect(guideSessions.get(TEST_THREAD_ID)?.alertName).toBe(TEST_ALERT_NAME);
    expect(guideSessions.get(TEST_THREAD_ID)?.userId).toBe(TEST_USER_ID);
  });

  it("replies with error and logs when thread creation fails", async () => {
    process.env.DATABASE_URL = "postgres://local/db";
    const threadsCreate = vi.fn().mockRejectedValue(new Error("Permission denied"));
    const textChannel = {
      id: "parent-1",
      isThread: () => false,
      threads: { create: threadsCreate },
    };
    const interaction = createMockInteraction("add-guide", { getString: () => TEST_ALERT_NAME }, textChannel);
    const log = createMockLog();

    await handleSlashCommand(interaction, log);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Permission denied") })
    );
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "error", alertName: TEST_ALERT_NAME }),
      "slash_add_guide_thread_failed"
    );
  });
});

describe("slash commands: save", () => {
  beforeEach(() => {
    guideSessions.clear();
  });

  it("replies when not in a thread", async () => {
    const interaction = createMockInteraction("save", {}, null);
    const log = createMockLog();
    await handleSlashCommand(interaction, log);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Use this command inside a guide thread (created with /add-guide)." })
    );
  });

  it("replies when in thread but no active session", async () => {
    const channel = { id: TEST_THREAD_ID, isThread: () => true };
    const interaction = createMockInteraction("save", {}, channel);
    const log = createMockLog();
    await handleSlashCommand(interaction, log);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "No active guide session in this thread. Use /add-guide to start one." })
    );
  });

  it("replies when another user tries to save", async () => {
    const stop = vi.fn();
    guideSessions.set(TEST_THREAD_ID, {
      alertName: TEST_ALERT_NAME,
      userId: TEST_USER_ID,
      messages: [],
      collector: { stop },
    });
    const channel = { id: TEST_THREAD_ID, isThread: () => true, send: vi.fn() };
    const interaction = createMockInteraction("save", {}, channel);
    (interaction as { user: { id: string } }).user.id = "other-user";
    const log = createMockLog();
    await handleSlashCommand(interaction, log);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Only the user who started this guide can save." })
    );
    expect(stop).not.toHaveBeenCalled();
  });

  it("calls setTroubleshootingGuide and clears session when same user saves", async () => {
    const setTroubleshootingGuideMock = vi.mocked(postgres.setTroubleshootingGuide);

    const stop = vi.fn();
    const msgs = [
      createMockMessage({ content: "First line", createdTimestamp: 1000 }),
      createMockMessage({ content: "Second line", createdTimestamp: 2000 }),
    ];
    guideSessions.set(TEST_THREAD_ID, {
      alertName: TEST_ALERT_NAME,
      userId: TEST_USER_ID,
      messages: msgs,
      collector: { stop },
    });
    const threadSend = vi.fn().mockResolvedValue(null);
    const channel = { id: TEST_THREAD_ID, isThread: () => true, send: threadSend };
    const interaction = createMockInteraction("save", {}, channel);
    const log = createMockLog();

    await handleSlashCommand(interaction, log);

    expect(stop).toHaveBeenCalledWith("save");
    expect(guideSessions.has(TEST_THREAD_ID)).toBe(false);
    await vi.waitFor(() => {
      expect(setTroubleshootingGuideMock).toHaveBeenCalledWith(TEST_ALERT_NAME, "First line\n\nSecond line");
    });
  });
});

describe("slash commands: delete-this", () => {
  it("replies when not in a thread", async () => {
    const interaction = createMockInteraction("delete-this", {}, null);
    const log = createMockLog();
    await handleSlashCommand(interaction, log);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Use this command inside a thread to delete it." })
    );
  });

  it("replies ephemeral and deletes thread when in a thread", async () => {
    const deleteChannel = vi.fn().mockResolvedValue(undefined);
    const channel = {
      id: TEST_THREAD_ID,
      isThread: () => true,
      delete: deleteChannel,
    };
    const interaction = createMockInteraction("delete-this", {}, channel);
    const log = createMockLog();

    await handleSlashCommand(interaction, log);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Deleting this thread…", flags: 64 })
    );
    expect(deleteChannel).toHaveBeenCalled();
  });

  it("logs error and followUp when thread delete fails", async () => {
    const err = new Error("Missing Access");
    const deleteChannel = vi.fn().mockRejectedValue(err);
    const channel = {
      id: TEST_THREAD_ID,
      isThread: () => true,
      delete: deleteChannel,
    };
    const interaction = createMockInteraction("delete-this", {}, channel);
    const log = createMockLog();

    await handleSlashCommand(interaction, log);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: TEST_THREAD_ID, err }),
      "slash_delete_this_failed"
    );
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Manage Threads"), flags: 64 })
    );
  });
});

describe("SLASH_COMMANDS", () => {
  it("includes add-guide, save, and delete-this", () => {
    const names = SLASH_COMMANDS.map((c: { name: string }) => c.name);
    expect(names).toContain("add-guide");
    expect(names).toContain("save");
    expect(names).toContain("delete-this");
  });

  it("add-guide has alert_name option", () => {
    const addGuide = SLASH_COMMANDS.find((c: { name: string }) => c.name === "add-guide");
    expect(addGuide).toBeDefined();
    expect((addGuide as { options?: { name: string }[] }).options?.some((o: { name: string }) => o.name === "alert_name")).toBe(true);
  });
});
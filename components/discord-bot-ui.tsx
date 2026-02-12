"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";

interface GuildInfo {
  id: string;
  name: string;
  icon: string | null;
  memberCount: number;
  onlineCount: number;
}

interface Role {
  id: string;
  name: string;
  color: string | null;
  position: number;
  managed: boolean;
}

interface LogEntry {
  id: number;
  status: "success" | "failed" | "dm_closed" | "ratelimit" | "info" | "error";
  message: string;
  timestamp: Date;
}

interface ProgressData {
  sent: number;
  failed: number;
  total: number;
  dmClosed: number;
}

export default function DiscordBotUI() {
  // Config state
  const [botToken, setBotToken] = useState("");
  const [guildId, setGuildId] = useState("");
  const [statusChannelId, setStatusChannelId] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [guildInfo, setGuildInfo] = useState<GuildInfo | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);

  // Send options state
  const [sendMode, setSendMode] = useState<"all" | "roles">("all");
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [delay, setDelay] = useState(2);
  const [messageText, setMessageText] = useState("");

  // Progress state
  const [isSending, setIsSending] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [isComplete, setIsComplete] = useState(false);

  const logIdRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const addLog = useCallback(
    (status: LogEntry["status"], message: string) => {
      logIdRef.current++;
      setLogs((prev) => [
        ...prev,
        { id: logIdRef.current, status, message, timestamp: new Date() },
      ]);
    },
    []
  );

  // Connect to guild
  const handleConnect = async () => {
    if (!botToken.trim() || !guildId.trim()) return;

    setIsConnecting(true);
    setGuildInfo(null);
    setRoles([]);

    try {
      const [guildRes, rolesRes] = await Promise.all([
        fetch("/api/discord/guild-info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ botToken, guildId }),
        }),
        fetch("/api/discord/roles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ botToken, guildId }),
        }),
      ]);

      const guildData = await guildRes.json();
      const rolesData = await rolesRes.json();

      if (!guildRes.ok) {
        addLog("error", `Connection failed: ${guildData.error}`);
        return;
      }

      setGuildInfo(guildData);
      if (rolesRes.ok) {
        setRoles(rolesData);
      }

      addLog("info", `Connected to ${guildData.name}`);
    } catch {
      addLog("error", "Failed to connect to Discord");
    } finally {
      setIsConnecting(false);
    }
  };

  // Send DMs
  const handleSendDM = async () => {
    if (!messageText.trim() || !guildInfo) return;
    if (sendMode === "roles" && selectedRoles.length === 0) return;

    setIsSending(true);
    setIsComplete(false);
    setLogs([]);
    setProgress(null);
    logIdRef.current = 0;

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch("/api/discord/send-dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botToken,
          guildId,
          message: messageText,
          mode: sendMode,
          roleIds: sendMode === "roles" ? selectedRoles : [],
          delay,
          statusChannelId: statusChannelId.trim() || null,
        }),
        signal: abort.signal,
      });

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No reader");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let currentEvent = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7);
          } else if (line.startsWith("data: ") && currentEvent) {
            try {
              const data = JSON.parse(line.slice(6));
              switch (currentEvent) {
                case "log":
                  addLog(data.status, data.message);
                  break;
                case "progress":
                  setProgress(data);
                  break;
                case "complete":
                  setProgress(data);
                  setIsComplete(true);
                  addLog(
                    "info",
                    `Complete! Sent: ${data.sent} | Failed: ${data.failed} | DM Closed: ${data.dmClosed}`
                  );
                  break;
                case "error":
                  addLog("error", data.message);
                  break;
              }
            } catch {
              // skip parse errors
            }
            currentEvent = "";
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        addLog("error", `Connection error: ${(err as Error).message}`);
      }
    } finally {
      setIsSending(false);
      abortRef.current = null;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    setIsSending(false);
    addLog("info", "Stopped by user");
  };

  const toggleRole = (roleId: string) => {
    setSelectedRoles((prev) =>
      prev.includes(roleId) ? prev.filter((r) => r !== roleId) : [...prev, roleId]
    );
  };

  const progressPercent =
    progress && progress.total > 0
      ? Math.round(((progress.sent + progress.failed + progress.dmClosed) / progress.total) * 100)
      : 0;

  const getLogColor = (status: LogEntry["status"]) => {
    switch (status) {
      case "success":
        return "text-emerald-400";
      case "failed":
        return "text-red-400";
      case "dm_closed":
        return "text-amber-400";
      case "ratelimit":
        return "text-orange-400";
      case "info":
        return "text-blue-400";
      case "error":
        return "text-red-500";
      default:
        return "text-foreground";
    }
  };

  const getLogPrefix = (status: LogEntry["status"]) => {
    switch (status) {
      case "success":
        return "OK";
      case "failed":
        return "FAIL";
      case "dm_closed":
        return "DM CLOSED";
      case "ratelimit":
        return "RATE LIMIT";
      case "info":
        return "INFO";
      case "error":
        return "ERROR";
      default:
        return "LOG";
    }
  };

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="mx-auto max-w-5xl flex flex-col gap-6">
        {/* Header */}
        <header className="flex items-center gap-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[hsl(var(--primary))]">
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-6 w-6 text-primary-foreground"
            >
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground text-balance">
              Discord Bot DM Panel
            </h1>
            <p className="text-sm text-muted-foreground">
              Mass DM Control Panel
            </p>
          </div>
        </header>

        <Separator />

        {/* Section 1: Bot Configuration */}
        <Card className="border-border bg-card">
          <CardHeader className="pb-4">
            <CardTitle className="text-base font-medium text-foreground">
              Bot Configuration
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="bot-token" className="text-sm text-muted-foreground">
                Bot Token
              </Label>
              <div className="flex gap-2">
                <Input
                  id="bot-token"
                  type={showToken ? "text" : "password"}
                  placeholder="Enter your bot token"
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  className="flex-1 bg-secondary border-border text-foreground placeholder:text-muted-foreground font-mono text-sm"
                  disabled={isSending}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowToken(!showToken)}
                  className="shrink-0 border-border text-muted-foreground hover:text-foreground"
                >
                  {showToken ? "Hide" : "Show"}
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="guild-id" className="text-sm text-muted-foreground">
                  Guild (Server) ID
                </Label>
                <Input
                  id="guild-id"
                  placeholder="Enter guild ID"
                  value={guildId}
                  onChange={(e) => setGuildId(e.target.value)}
                  className="bg-secondary border-border text-foreground placeholder:text-muted-foreground font-mono text-sm"
                  disabled={isSending}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="status-channel" className="text-sm text-muted-foreground">
                  Status Channel ID
                  <span className="ml-1 text-xs text-muted-foreground/60">(optional)</span>
                </Label>
                <Input
                  id="status-channel"
                  placeholder="Channel for progress updates"
                  value={statusChannelId}
                  onChange={(e) => setStatusChannelId(e.target.value)}
                  className="bg-secondary border-border text-foreground placeholder:text-muted-foreground font-mono text-sm"
                  disabled={isSending}
                />
              </div>
            </div>

            <Button
              onClick={handleConnect}
              disabled={!botToken.trim() || !guildId.trim() || isConnecting || isSending}
              className="w-full md:w-auto self-start bg-[hsl(var(--primary))] text-primary-foreground hover:bg-[hsl(var(--primary)/0.9)]"
            >
              {isConnecting ? "Connecting..." : "Connect"}
            </Button>

            {/* Guild info display */}
            {guildInfo && (
              <div className="flex items-center gap-3 rounded-lg bg-secondary p-3">
                {guildInfo.icon ? (
                  <img
                    src={guildInfo.icon}
                    alt={guildInfo.name}
                    className="h-10 w-10 rounded-full"
                    crossOrigin="anonymous"
                  />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-foreground text-sm font-medium">
                    {guildInfo.name.charAt(0)}
                  </div>
                )}
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">
                    {guildInfo.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {guildInfo.memberCount.toLocaleString()} members
                    {guildInfo.onlineCount > 0 &&
                      ` / ${guildInfo.onlineCount.toLocaleString()} online`}
                  </span>
                </div>
                <Badge
                  variant="outline"
                  className="ml-auto border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                >
                  Connected
                </Badge>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Section 2: Send Options (only show when connected) */}
        {guildInfo && (
          <Card className="border-border bg-card">
            <CardHeader className="pb-4">
              <CardTitle className="text-base font-medium text-foreground">
                Send Options
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              {/* Mode selection */}
              <div className="flex flex-col gap-3">
                <Label className="text-sm text-muted-foreground">Target</Label>
                <RadioGroup
                  value={sendMode}
                  onValueChange={(v) => setSendMode(v as "all" | "roles")}
                  className="flex flex-col gap-2"
                  disabled={isSending}
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="all" id="mode-all" />
                    <Label htmlFor="mode-all" className="text-sm text-foreground cursor-pointer">
                      Send to all members
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="roles" id="mode-roles" />
                    <Label htmlFor="mode-roles" className="text-sm text-foreground cursor-pointer">
                      Send to specific roles only
                    </Label>
                  </div>
                </RadioGroup>
              </div>

              {/* Role selection */}
              {sendMode === "roles" && roles.length > 0 && (
                <div className="flex flex-col gap-2">
                  <Label className="text-sm text-muted-foreground">
                    Select Roles ({selectedRoles.length} selected)
                  </Label>
                  <ScrollArea className="h-48 rounded-lg border border-border bg-secondary p-3">
                    <div className="flex flex-col gap-2">
                      {roles.map((role) => (
                        <div
                          key={role.id}
                          className="flex items-center gap-2 rounded-md p-1.5 hover:bg-muted/50 transition-colors"
                        >
                          <Checkbox
                            id={`role-${role.id}`}
                            checked={selectedRoles.includes(role.id)}
                            onCheckedChange={() => toggleRole(role.id)}
                            disabled={isSending}
                          />
                          <label
                            htmlFor={`role-${role.id}`}
                            className="flex items-center gap-2 text-sm cursor-pointer text-foreground"
                          >
                            <span
                              className="inline-block h-3 w-3 rounded-full shrink-0"
                              style={{
                                backgroundColor: role.color || "hsl(var(--muted-foreground))",
                              }}
                            />
                            {role.name}
                          </label>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              )}

              {/* Delay setting */}
              <div className="flex flex-col gap-2">
                <Label className="text-sm text-muted-foreground">
                  Delay between messages: {delay}s
                </Label>
                <div className="flex items-center gap-4">
                  <Slider
                    value={[delay]}
                    onValueChange={(v) => setDelay(v[0])}
                    min={0.5}
                    max={10}
                    step={0.5}
                    className="flex-1"
                    disabled={isSending}
                  />
                  <Input
                    type="number"
                    value={delay}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v) && v >= 0.5 && v <= 30) setDelay(v);
                    }}
                    className="w-20 bg-secondary border-border text-foreground text-sm text-center"
                    min={0.5}
                    max={30}
                    step={0.5}
                    disabled={isSending}
                  />
                </div>
              </div>

              <Separator />

              {/* Message input */}
              <div className="flex flex-col gap-2">
                <Label htmlFor="message" className="text-sm text-muted-foreground">
                  Message Content
                </Label>
                <Textarea
                  id="message"
                  placeholder={"Type your message here...\nUse <user> to mention the recipient"}
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  rows={5}
                  className="bg-secondary border-border text-foreground placeholder:text-muted-foreground resize-none"
                  disabled={isSending}
                />
                <p className="text-xs text-muted-foreground/70">
                  {"Use <user> to mention the recipient. Example: Hello <user>, welcome!"}
                </p>
              </div>

              {/* Send / Stop buttons */}
              <div className="flex gap-3">
                {!isSending ? (
                  <Button
                    onClick={handleSendDM}
                    disabled={
                      !messageText.trim() ||
                      (sendMode === "roles" && selectedRoles.length === 0)
                    }
                    className="bg-[hsl(var(--primary))] text-primary-foreground hover:bg-[hsl(var(--primary)/0.9)]"
                  >
                    Send Messages
                  </Button>
                ) : (
                  <Button
                    variant="destructive"
                    onClick={handleStop}
                  >
                    Stop
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Section 3: Progress & Logs */}
        {(logs.length > 0 || progress) && (
          <Card className="border-border bg-card">
            <CardHeader className="pb-4">
              <CardTitle className="text-base font-medium text-foreground">
                {isComplete ? "Results" : isSending ? "Sending..." : "Progress"}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {/* Progress bar */}
              {progress && progress.total > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {progress.sent + progress.failed + progress.dmClosed} / {progress.total}
                    </span>
                    <span className="text-muted-foreground">{progressPercent}%</span>
                  </div>
                  <Progress value={progressPercent} className="h-2" />
                </div>
              )}

              {/* Stats cards */}
              {progress && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="rounded-lg bg-secondary p-3 flex flex-col items-center">
                    <span className="text-lg font-semibold text-foreground">
                      {progress.total}
                    </span>
                    <span className="text-xs text-muted-foreground">Total</span>
                  </div>
                  <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-3 flex flex-col items-center">
                    <span className="text-lg font-semibold text-emerald-400">
                      {progress.sent}
                    </span>
                    <span className="text-xs text-emerald-400/70">Success</span>
                  </div>
                  <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 flex flex-col items-center">
                    <span className="text-lg font-semibold text-red-400">
                      {progress.failed}
                    </span>
                    <span className="text-xs text-red-400/70">Failed</span>
                  </div>
                  <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 flex flex-col items-center">
                    <span className="text-lg font-semibold text-amber-400">
                      {progress.dmClosed}
                    </span>
                    <span className="text-xs text-amber-400/70">DM Closed</span>
                  </div>
                </div>
              )}

              <Separator />

              {/* Log area */}
              <div className="flex flex-col gap-1">
                <Label className="text-sm text-muted-foreground">Log</Label>
                <ScrollArea className="h-64 rounded-lg border border-border bg-[hsl(232,30%,6%)] p-3">
                  <div className="flex flex-col gap-0.5 font-mono text-xs">
                    {logs.map((log) => (
                      <div key={log.id} className="flex gap-2 leading-relaxed">
                        <span className="text-muted-foreground/50 shrink-0 tabular-nums">
                          {log.timestamp.toLocaleTimeString("th-TH")}
                        </span>
                        <span
                          className={`shrink-0 font-semibold w-24 text-right ${getLogColor(
                            log.status
                          )}`}
                        >
                          [{getLogPrefix(log.status)}]
                        </span>
                        <span className="text-foreground/80">{log.message}</span>
                      </div>
                    ))}
                    <div ref={logEndRef} />
                  </div>
                </ScrollArea>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Footer note */}
        <p className="text-center text-xs text-muted-foreground/50 pb-4">
          Bot must have SERVER MEMBERS INTENT enabled in Discord Developer Portal.
          Deploy on Railway with next start.
        </p>
      </div>
    </div>
  );
}

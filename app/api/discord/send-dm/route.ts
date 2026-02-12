import { NextRequest } from "next/server";

const DISCORD_API = "https://discord.com/api/v10";

interface DiscordMember {
  user: {
    id: string;
    username: string;
    discriminator: string;
    bot?: boolean;
    global_name?: string;
  };
  roles: string[];
}

async function discordFetch(url: string, botToken: string, options: RequestInit = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (res.status === 429) {
    const data = await res.json();
    return { rateLimited: true, retryAfter: data.retry_after || 5 };
  }

  return { rateLimited: false, response: res };
}

async function getAllMembers(guildId: string, botToken: string): Promise<DiscordMember[]> {
  const members: DiscordMember[] = [];
  let after = "0";
  let hasMore = true;

  while (hasMore) {
    const result = await discordFetch(
      `${DISCORD_API}/guilds/${guildId}/members?limit=1000&after=${after}`,
      botToken
    );

    if (result.rateLimited) {
      await new Promise((resolve) => setTimeout(resolve, (result.retryAfter as number) * 1000));
      continue;
    }

    if (!result.response!.ok) {
      throw new Error(`Failed to fetch members: ${result.response!.status}`);
    }

    const batch: DiscordMember[] = await result.response!.json();
    if (batch.length === 0) {
      hasMore = false;
    } else {
      members.push(...batch);
      after = batch[batch.length - 1].user.id;
      if (batch.length < 1000) {
        hasMore = false;
      }
    }
  }

  return members;
}

async function sendStatusMessage(
  channelId: string,
  botToken: string,
  content: string
): Promise<string | null> {
  const result = await discordFetch(`${DISCORD_API}/channels/${channelId}/messages`, botToken, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
  if (result.rateLimited || !result.response?.ok) return null;
  const data = await result.response.json();
  return data.id;
}

async function editStatusMessage(
  channelId: string,
  messageId: string,
  botToken: string,
  content: string
) {
  await discordFetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, botToken, {
    method: "PATCH",
    body: JSON.stringify({ content }),
  });
}

export async function POST(req: NextRequest) {
  const { botToken, guildId, message, mode, roleIds, delay, statusChannelId } = await req.json();

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(eventType: string, data: Record<string, unknown>) {
        controller.enqueue(
          encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      }

      try {
        // Step 1: Fetch all members
        send("log", { status: "info", message: "Fetching server members..." });

        let members: DiscordMember[];
        try {
          members = await getAllMembers(guildId, botToken);
        } catch (err) {
          send("error", { message: `Failed to fetch members: ${(err as Error).message}` });
          controller.close();
          return;
        }

        // Step 2: Filter out bots
        members = members.filter((m) => !m.user.bot);

        // Step 3: Filter by roles if needed
        if (mode === "roles" && roleIds && roleIds.length > 0) {
          members = members.filter((m) =>
            m.roles.some((r: string) => roleIds.includes(r))
          );
        }

        const total = members.length;
        send("log", {
          status: "info",
          message: `Found ${total} members to message`,
        });
        send("progress", { sent: 0, failed: 0, total, dmClosed: 0 });

        if (total === 0) {
          send("complete", { sent: 0, failed: 0, total: 0, dmClosed: 0 });
          controller.close();
          return;
        }

        // Step 4: Send initial status message to Discord channel
        let statusMessageId: string | null = null;
        if (statusChannelId) {
          statusMessageId = await sendStatusMessage(
            statusChannelId,
            botToken,
            `**Mass DM Started**\nProgress: 0/${total} members\nSuccess: 0 | Failed: 0`
          );
        }

        let sent = 0;
        let failed = 0;
        let dmClosed = 0;
        const delayMs = (delay || 1) * 1000;

        // Step 5: Send DMs
        for (let i = 0; i < members.length; i++) {
          const member = members[i];
          const displayName = member.user.global_name || member.user.username;

          try {
            // Create DM channel
            let dmResult = await discordFetch(`${DISCORD_API}/users/@me/channels`, botToken, {
              method: "POST",
              body: JSON.stringify({ recipient_id: member.user.id }),
            });

            // Handle rate limit for DM channel creation
            if (dmResult.rateLimited) {
              const waitTime = dmResult.retryAfter as number;
              send("log", {
                status: "ratelimit",
                message: `Rate limited! Waiting ${waitTime}s...`,
              });
              await new Promise((r) => setTimeout(r, waitTime * 1000));
              dmResult = await discordFetch(`${DISCORD_API}/users/@me/channels`, botToken, {
                method: "POST",
                body: JSON.stringify({ recipient_id: member.user.id }),
              });
            }

            if (!dmResult.response?.ok) {
              throw new Error("Cannot create DM channel");
            }

            const dmChannel = await dmResult.response.json();

            // Replace <user> placeholder with mention
            const finalMessage = message.replace(/<user>/g, `<@${member.user.id}>`);

            // Send message
            let msgResult = await discordFetch(
              `${DISCORD_API}/channels/${dmChannel.id}/messages`,
              botToken,
              {
                method: "POST",
                body: JSON.stringify({ content: finalMessage }),
              }
            );

            // Handle rate limit for message sending
            if (msgResult.rateLimited) {
              const waitTime = msgResult.retryAfter as number;
              send("log", {
                status: "ratelimit",
                message: `Rate limited! Waiting ${waitTime}s...`,
              });
              await new Promise((r) => setTimeout(r, waitTime * 1000));
              msgResult = await discordFetch(
                `${DISCORD_API}/channels/${dmChannel.id}/messages`,
                botToken,
                {
                  method: "POST",
                  body: JSON.stringify({ content: finalMessage }),
                }
              );
            }

            if (msgResult.response?.ok) {
              sent++;
              send("log", {
                status: "success",
                message: `Sent to ${displayName}`,
                username: displayName,
              });
            } else {
              const errStatus = msgResult.response?.status;
              if (errStatus === 403) {
                dmClosed++;
                send("log", {
                  status: "dm_closed",
                  message: `${displayName} - DMs disabled`,
                  username: displayName,
                });
              } else {
                failed++;
                send("log", {
                  status: "failed",
                  message: `Failed: ${displayName} (${errStatus})`,
                  username: displayName,
                });
              }
            }
          } catch {
            failed++;
            send("log", {
              status: "failed",
              message: `Failed: ${displayName} - Error`,
              username: displayName,
            });
          }

          send("progress", { sent, failed, total, dmClosed });

          // Update status message in Discord channel every 5 members
          if (statusChannelId && statusMessageId && (i + 1) % 5 === 0) {
            const progress = sent + failed + dmClosed;
            await editStatusMessage(statusChannelId, statusMessageId, botToken,
              `**Mass DM In Progress...**\nProgress: ${progress}/${total} members\nSuccess: ${sent} | Failed: ${failed} | DM Closed: ${dmClosed}`
            );
          }

          // Delay between messages
          if (i < members.length - 1) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }

        // Final status message update
        if (statusChannelId && statusMessageId) {
          const progress = sent + failed + dmClosed;
          await editStatusMessage(statusChannelId, statusMessageId, botToken,
            `**Mass DM Complete!**\nTotal: ${progress}/${total} members\nSuccess: ${sent} | Failed: ${failed} | DM Closed: ${dmClosed}`
          );
        }

        send("complete", { sent, failed, total, dmClosed });
      } catch (err) {
        send("error", { message: `Unexpected error: ${(err as Error).message}` });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

import { NextRequest, NextResponse } from "next/server";

const DISCORD_API = "https://discord.com/api/v10";

export async function POST(req: NextRequest) {
  try {
    const { botToken, guildId } = await req.json();

    if (!botToken || !guildId) {
      return NextResponse.json(
        { error: "Bot Token and Guild ID are required" },
        { status: 400 }
      );
    }

    const res = await fetch(`${DISCORD_API}/guilds/${guildId}?with_counts=true`, {
      headers: {
        Authorization: `Bot ${botToken}`,
      },
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: errData.message || `Discord API error: ${res.status}` },
        { status: res.status }
      );
    }

    const data = await res.json();

    return NextResponse.json({
      id: data.id,
      name: data.name,
      icon: data.icon
        ? `https://cdn.discordapp.com/icons/${data.id}/${data.icon}.png`
        : null,
      memberCount: data.approximate_member_count || 0,
      onlineCount: data.approximate_presence_count || 0,
    });
  } catch (err) {
    console.error("Guild info error:", err);
    return NextResponse.json(
      { error: "Failed to fetch guild info" },
      { status: 500 }
    );
  }
}

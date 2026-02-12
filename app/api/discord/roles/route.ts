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

    const res = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, {
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

    const roles = await res.json();

    // Filter out @everyone role and sort by position descending
    const filtered = roles
      .filter((r: { name: string }) => r.name !== "@everyone")
      .sort((a: { position: number }, b: { position: number }) => b.position - a.position)
      .map((r: { id: string; name: string; color: number; position: number; managed: boolean }) => ({
        id: r.id,
        name: r.name,
        color: r.color ? `#${r.color.toString(16).padStart(6, "0")}` : null,
        position: r.position,
        managed: r.managed,
      }));

    return NextResponse.json(filtered);
  } catch (err) {
    console.error("Roles error:", err);
    return NextResponse.json(
      { error: "Failed to fetch roles" },
      { status: 500 }
    );
  }
}

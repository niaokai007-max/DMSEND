import os
import asyncio
import discord
from discord import app_commands
from discord.ext import commands
from datetime import datetime

# ─── Config from Environment Variables ─────────────────────────────
DISCORD_BOT_TOKEN = os.environ.get("DISCORD_BOT_TOKEN", "")
GUILD_ID = os.environ.get("GUILD_ID", "")
LOG_CHANNEL_ID = os.environ.get("LOG_CHANNEL_ID", "")
ALLOWED_CHANNEL = os.environ.get("ALLOWED_CHANNEL", "")  # optional: restrict command to this channel

# ─── Bot Setup ─────────────────────────────────────────────────────
intents = discord.Intents.default()
intents.members = True
intents.message_content = True
intents.guilds = True

bot = commands.Bot(command_prefix="!", intents=intents)

# Global state for stopping
stop_flags = {}


# ─── Helpers ───────────────────────────────────────────────────────

def make_progress_embed(title, sent, failed, dm_closed, total, status="in_progress", extra=""):
    """Create a styled embed for progress updates."""
    progress = sent + failed + dm_closed
    pct = int((progress / total) * 100) if total > 0 else 0

    bar_filled = int(pct / 5)
    bar_empty = 20 - bar_filled
    bar = "\u2588" * bar_filled + "\u2591" * bar_empty

    if status == "in_progress":
        color = discord.Color.blue()
        icon = "\U0001f4e8"
    elif status == "complete":
        color = discord.Color.green()
        icon = "\u2705"
    elif status == "stopped":
        color = discord.Color.orange()
        icon = "\u26a0\ufe0f"
    else:
        color = discord.Color.red()
        icon = "\u274c"

    embed = discord.Embed(
        title=f"{icon} {title}",
        color=color,
        timestamp=datetime.utcnow(),
    )
    embed.add_field(name="Progress", value=f"`{bar}` {pct}% ({progress}/{total})", inline=False)
    embed.add_field(name="Sent", value=f"```\n{sent}\n```", inline=True)
    embed.add_field(name="Failed", value=f"```\n{failed}\n```", inline=True)
    embed.add_field(name="DM Closed", value=f"```\n{dm_closed}\n```", inline=True)

    if extra:
        embed.add_field(name="Info", value=extra, inline=False)

    embed.set_footer(text="Discord Mass DM Bot")
    return embed


async def send_mass_dm(interaction, message_text, mode, role_ids, delay_sec):
    """Core logic: send DMs to guild members with live progress."""
    guild = bot.get_guild(int(GUILD_ID))
    if not guild:
        await interaction.followup.send("\u274c Cannot find the guild. Check `GUILD_ID`.", ephemeral=True)
        return

    session_id = str(interaction.user.id)
    stop_flags[session_id] = False

    # Fetch all members
    await interaction.followup.send("\u23f3 Fetching server members...", ephemeral=True)
    members = [m for m in guild.members if not m.bot]

    # Filter by roles
    if mode == "roles" and role_ids:
        members = [m for m in members if any(str(r.id) in role_ids for r in m.roles)]

    total = len(members)
    if total == 0:
        await interaction.followup.send("\u274c No members found matching criteria.", ephemeral=True)
        return

    # Send initial progress to log channel
    log_channel = None
    if LOG_CHANNEL_ID:
        log_channel = bot.get_channel(int(LOG_CHANNEL_ID))

    embed = make_progress_embed("Mass DM Started", 0, 0, 0, total)
    progress_msg = None
    if log_channel:
        progress_msg = await log_channel.send(embed=embed)

    # Also send progress in the command channel
    cmd_progress_msg = await interaction.followup.send(embed=embed, wait=True)

    sent = 0
    failed = 0
    dm_closed = 0

    for i, member in enumerate(members):
        if stop_flags.get(session_id, False):
            break

        display_name = member.display_name
        final_message = message_text.replace("<user>", member.mention)

        try:
            dm_channel = await member.create_dm()
            await dm_channel.send(final_message)
            sent += 1
            status_text = f"\u2705 Sent to **{display_name}**"
        except discord.Forbidden:
            dm_closed += 1
            status_text = f"\U0001f512 {display_name} - DMs disabled"
        except discord.HTTPException as e:
            if e.status == 429:
                retry_after = e.retry_after if hasattr(e, "retry_after") else 5
                status_text = f"\u23f1\ufe0f Rate limited! Waiting {retry_after}s..."
                if log_channel:
                    await log_channel.send(f"\u23f1\ufe0f Rate limited! Waiting {retry_after}s...")
                await asyncio.sleep(retry_after)
                # Retry once
                try:
                    await dm_channel.send(final_message)
                    sent += 1
                    status_text = f"\u2705 Sent to **{display_name}** (after retry)"
                except Exception:
                    failed += 1
                    status_text = f"\u274c Failed: **{display_name}** (after retry)"
            else:
                failed += 1
                status_text = f"\u274c Failed: **{display_name}** ({e.status})"
        except Exception:
            failed += 1
            status_text = f"\u274c Failed: **{display_name}** - Error"

        # Log each DM result to log channel
        if log_channel and (i + 1) % 3 == 0:
            await log_channel.send(status_text)

        # Update progress embed every 5 members or on last member
        if (i + 1) % 5 == 0 or (i + 1) == total:
            embed = make_progress_embed("Mass DM In Progress...", sent, failed, dm_closed, total)
            try:
                if progress_msg:
                    await progress_msg.edit(embed=embed)
                await cmd_progress_msg.edit(embed=embed)
            except Exception:
                pass

        # Delay
        if i < len(members) - 1 and not stop_flags.get(session_id, False):
            await asyncio.sleep(delay_sec)

    # Final update
    was_stopped = stop_flags.get(session_id, False)
    status = "stopped" if was_stopped else "complete"
    title = "Mass DM Stopped" if was_stopped else "Mass DM Complete!"

    embed = make_progress_embed(title, sent, failed, dm_closed, total, status=status)
    try:
        if progress_msg:
            await progress_msg.edit(embed=embed)
        await cmd_progress_msg.edit(embed=embed)
    except Exception:
        pass

    if log_channel:
        summary = (
            f"**{'Stopped' if was_stopped else 'Complete'}!** "
            f"Sent: {sent} | Failed: {failed} | DM Closed: {dm_closed} | Total: {total}"
        )
        await log_channel.send(summary)

    stop_flags.pop(session_id, None)


# ─── Views (Buttons & Modals) ─────────────────────────────────────

class MessageModal(discord.ui.Modal, title="Type Your Message"):
    """Modal that pops up to let user type the DM message."""

    message_input = discord.ui.TextInput(
        label="Message",
        style=discord.TextStyle.paragraph,
        placeholder="Type your message here... Use <user> to mention each user",
        required=True,
        max_length=2000,
    )

    delay_input = discord.ui.TextInput(
        label="Delay (seconds between each DM)",
        style=discord.TextStyle.short,
        placeholder="2",
        required=False,
        default="2",
        max_length=5,
    )

    def __init__(self, mode, role_ids=None):
        super().__init__()
        self.mode = mode
        self.role_ids = role_ids or []

    async def on_submit(self, interaction: discord.Interaction):
        message_text = self.message_input.value
        try:
            delay_sec = float(self.delay_input.value or "2")
            delay_sec = max(0.5, min(delay_sec, 30))
        except ValueError:
            delay_sec = 2.0

        await interaction.response.defer(ephemeral=True)

        # Run mass DM in background
        asyncio.create_task(
            send_mass_dm(interaction, message_text, self.mode, self.role_ids, delay_sec)
        )


class RoleSelectView(discord.ui.View):
    """View with role select menu + confirm button."""

    def __init__(self, guild: discord.Guild):
        super().__init__(timeout=120)
        self.selected_role_ids = []

        # Add role select
        roles = [r for r in guild.roles if r.name != "@everyone" and not r.managed]
        roles.sort(key=lambda r: r.position, reverse=True)

        # Discord allows max 25 options
        options = []
        for r in roles[:25]:
            options.append(
                discord.SelectOption(
                    label=r.name,
                    value=str(r.id),
                    description=f"Members: {len(r.members)}",
                )
            )

        if options:
            select = discord.ui.Select(
                placeholder="Select roles...",
                min_values=1,
                max_values=min(len(options), 25),
                options=options,
            )
            select.callback = self.role_select_callback
            self.add_item(select)

    async def role_select_callback(self, interaction: discord.Interaction):
        self.selected_role_ids = interaction.data.get("values", [])
        role_names = []
        guild = bot.get_guild(int(GUILD_ID))
        if guild:
            for rid in self.selected_role_ids:
                role = guild.get_role(int(rid))
                if role:
                    role_names.append(role.name)
        await interaction.response.send_message(
            f"Selected roles: **{', '.join(role_names)}**\nNow click **Confirm & Type Message** below.",
            ephemeral=True,
        )

    @discord.ui.button(label="Confirm & Type Message", style=discord.ButtonStyle.green, row=2)
    async def confirm_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.selected_role_ids:
            await interaction.response.send_message("Please select at least one role first!", ephemeral=True)
            return
        modal = MessageModal(mode="roles", role_ids=self.selected_role_ids)
        await interaction.response.send_modal(modal)

    @discord.ui.button(label="Cancel", style=discord.ButtonStyle.grey, row=2)
    async def cancel_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.edit_message(content="Cancelled.", embed=None, view=None)


class MainMenuView(discord.ui.View):
    """Main control panel with Send to All / Send to Roles / Stop buttons."""

    def __init__(self):
        super().__init__(timeout=300)

    @discord.ui.button(label="Send to All Members", style=discord.ButtonStyle.blurple, emoji="\U0001f4e8")
    async def send_all_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        modal = MessageModal(mode="all")
        await interaction.response.send_modal(modal)

    @discord.ui.button(label="Send to Specific Roles", style=discord.ButtonStyle.green, emoji="\U0001f3ad")
    async def send_roles_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        guild = bot.get_guild(int(GUILD_ID))
        if not guild:
            await interaction.response.send_message("\u274c Cannot find guild.", ephemeral=True)
            return

        view = RoleSelectView(guild)
        embed = discord.Embed(
            title="\U0001f3ad Select Roles",
            description="Choose which roles to send the message to, then click **Confirm & Type Message**.",
            color=discord.Color.green(),
        )
        await interaction.response.send_message(embed=embed, view=view, ephemeral=True)

    @discord.ui.button(label="Stop Sending", style=discord.ButtonStyle.red, emoji="\u23f9\ufe0f")
    async def stop_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        session_id = str(interaction.user.id)
        if session_id in stop_flags:
            stop_flags[session_id] = True
            await interaction.response.send_message("\u23f9\ufe0f Stopping mass DM...", ephemeral=True)
        else:
            await interaction.response.send_message("No active DM session found.", ephemeral=True)


# ─── Slash Command ─────────────────────────────────────────────────

@bot.tree.command(name="massdm", description="Open the Mass DM control panel")
async def massdm_command(interaction: discord.Interaction):
    # Check allowed channel
    if ALLOWED_CHANNEL and str(interaction.channel_id) != ALLOWED_CHANNEL:
        await interaction.response.send_message(
            f"\u274c This command can only be used in <#{ALLOWED_CHANNEL}>.",
            ephemeral=True,
        )
        return

    # Check permissions (only admins)
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message(
            "\u274c You need Administrator permission to use this.",
            ephemeral=True,
        )
        return

    guild = bot.get_guild(int(GUILD_ID))
    member_count = len([m for m in guild.members if not m.bot]) if guild else 0

    embed = discord.Embed(
        title="\U0001f4ec Discord Mass DM Panel",
        description="Choose an action below to send direct messages to server members.",
        color=discord.Color.from_str("#5865F2"),
        timestamp=datetime.utcnow(),
    )
    embed.add_field(
        name="\U0001f4ca Server Info",
        value=(
            f"**Server:** {guild.name if guild else 'N/A'}\n"
            f"**Members (non-bot):** {member_count}\n"
            f"**Log Channel:** {'<#' + LOG_CHANNEL_ID + '>' if LOG_CHANNEL_ID else 'Not set'}"
        ),
        inline=False,
    )
    embed.add_field(
        name="\U0001f4dd Tips",
        value=(
            "- Use `<user>` in your message to mention each recipient\n"
            "- Set delay between 0.5-30 seconds to avoid rate limits\n"
            "- Click **Stop** to abort at any time"
        ),
        inline=False,
    )
    if guild and guild.icon:
        embed.set_thumbnail(url=guild.icon.url)

    embed.set_footer(text=f"Requested by {interaction.user.display_name}")

    view = MainMenuView()
    await interaction.response.send_message(embed=embed, view=view)


# ─── Bot Events ────────────────────────────────────────────────────

@bot.event
async def on_ready():
    print(f"{'='*50}")
    print(f"  Bot is online: {bot.user} (ID: {bot.user.id})")
    print(f"  Guild ID: {GUILD_ID}")
    print(f"  Log Channel: {LOG_CHANNEL_ID or 'Not set'}")
    print(f"  Allowed Channel: {ALLOWED_CHANNEL or 'Any'}")
    print(f"{'='*50}")

    # Sync slash commands
    try:
        if GUILD_ID:
            guild_obj = discord.Object(id=int(GUILD_ID))
            bot.tree.copy_global_to(guild=guild_obj)
            synced = await bot.tree.sync(guild=guild_obj)
        else:
            synced = await bot.tree.sync()
        print(f"  Synced {len(synced)} command(s)")
    except Exception as e:
        print(f"  Failed to sync commands: {e}")

    # Set status
    await bot.change_presence(
        activity=discord.Activity(
            type=discord.ActivityType.watching,
            name="/massdm | Mass DM Panel"
        )
    )

    # Send startup message to log channel
    if LOG_CHANNEL_ID:
        channel = bot.get_channel(int(LOG_CHANNEL_ID))
        if channel:
            embed = discord.Embed(
                title="\U0001f7e2 Bot Online",
                description=f"Mass DM Bot is ready!\nUse `/massdm` to open the control panel.",
                color=discord.Color.green(),
                timestamp=datetime.utcnow(),
            )
            await channel.send(embed=embed)


# ─── Run ───────────────────────────────────────────────────────────

if not DISCORD_BOT_TOKEN:
    print("ERROR: DISCORD_BOT_TOKEN is not set!")
    print("Please set it in Railway Variables tab.")
    exit(1)
if not GUILD_ID:
    print("ERROR: GUILD_ID is not set!")
    print("Please set it in Railway Variables tab.")
    exit(1)

print(f"Starting bot...")
print(f"GUILD_ID: {GUILD_ID}")
print(f"LOG_CHANNEL_ID: {LOG_CHANNEL_ID or 'Not set'}")
print(f"ALLOWED_CHANNEL: {ALLOWED_CHANNEL or 'Not set (all channels)'}")

bot.run(DISCORD_BOT_TOKEN)

import os
import json
import time
import threading
import requests as req
from flask import Flask, render_template, request, Response, jsonify, stream_with_context

app = Flask(__name__)

DISCORD_API = "https://discord.com/api/v10"

# Global stop event for aborting mass DM
stop_event = threading.Event()


def discord_fetch(url, bot_token, method="GET", json_body=None):
    """Helper to call Discord REST API with bot token."""
    headers = {
        "Authorization": f"Bot {bot_token}",
        "Content-Type": "application/json",
    }
    try:
        if method == "GET":
            r = req.get(url, headers=headers, timeout=30)
        elif method == "POST":
            r = req.post(url, headers=headers, json=json_body, timeout=30)
        elif method == "PATCH":
            r = req.patch(url, headers=headers, json=json_body, timeout=30)
        else:
            return None, None

        if r.status_code == 429:
            data = r.json()
            retry_after = data.get("retry_after", 5)
            return {"rate_limited": True, "retry_after": retry_after}, None

        return None, r
    except Exception as e:
        return {"error": str(e)}, None


def get_all_members(guild_id, bot_token):
    """Fetch all guild members with pagination."""
    members = []
    after = "0"

    while True:
        url = f"{DISCORD_API}/guilds/{guild_id}/members?limit=1000&after={after}"
        err, resp = discord_fetch(url, bot_token)

        if err and err.get("rate_limited"):
            time.sleep(err["retry_after"])
            continue

        if err:
            raise Exception(err.get("error", "Unknown error"))

        if resp.status_code != 200:
            raise Exception(f"Failed to fetch members: HTTP {resp.status_code}")

        batch = resp.json()
        if not batch:
            break

        members.extend(batch)
        after = batch[-1]["user"]["id"]

        if len(batch) < 1000:
            break

    return members


def send_status_message(channel_id, bot_token, content):
    """Send a message to a Discord channel, return message ID."""
    url = f"{DISCORD_API}/channels/{channel_id}/messages"
    err, resp = discord_fetch(url, bot_token, method="POST", json_body={"content": content})
    if err or not resp or resp.status_code != 200:
        return None
    return resp.json().get("id")


def edit_status_message(channel_id, message_id, bot_token, content):
    """Edit an existing Discord message."""
    url = f"{DISCORD_API}/channels/{channel_id}/messages/{message_id}"
    discord_fetch(url, bot_token, method="PATCH", json_body={"content": content})


# ─── Routes ───────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/guild-info", methods=["POST"])
def guild_info():
    data = request.get_json()
    bot_token = data.get("botToken", "")
    guild_id = data.get("guildId", "")

    if not bot_token or not guild_id:
        return jsonify({"error": "Missing botToken or guildId"}), 400

    url = f"{DISCORD_API}/guilds/{guild_id}?with_counts=true"
    err, resp = discord_fetch(url, bot_token)

    if err:
        if err.get("rate_limited"):
            return jsonify({"error": "Rate limited, try again later"}), 429
        return jsonify({"error": err.get("error", "Unknown error")}), 500

    if resp.status_code != 200:
        return jsonify({"error": f"Discord API error: {resp.status_code}"}), resp.status_code

    guild = resp.json()
    icon_url = None
    if guild.get("icon"):
        ext = "gif" if guild["icon"].startswith("a_") else "png"
        icon_url = f"https://cdn.discordapp.com/icons/{guild['id']}/{guild['icon']}.{ext}?size=128"

    return jsonify({
        "id": guild["id"],
        "name": guild["name"],
        "icon": icon_url,
        "memberCount": guild.get("approximate_member_count", 0),
        "onlineCount": guild.get("approximate_presence_count", 0),
    })


@app.route("/api/roles", methods=["POST"])
def roles():
    data = request.get_json()
    bot_token = data.get("botToken", "")
    guild_id = data.get("guildId", "")

    if not bot_token or not guild_id:
        return jsonify({"error": "Missing botToken or guildId"}), 400

    url = f"{DISCORD_API}/guilds/{guild_id}/roles"
    err, resp = discord_fetch(url, bot_token)

    if err:
        if err.get("rate_limited"):
            return jsonify({"error": "Rate limited"}), 429
        return jsonify({"error": err.get("error", "Unknown error")}), 500

    if resp.status_code != 200:
        return jsonify({"error": f"Discord API error: {resp.status_code}"}), resp.status_code

    all_roles = resp.json()
    # Filter out @everyone, sort by position descending
    filtered = [
        {
            "id": r["id"],
            "name": r["name"],
            "color": f"#{r['color']:06x}" if r.get("color", 0) != 0 else None,
            "position": r["position"],
            "managed": r.get("managed", False),
        }
        for r in all_roles
        if r["name"] != "@everyone"
    ]
    filtered.sort(key=lambda x: x["position"], reverse=True)

    return jsonify(filtered)


@app.route("/api/stop", methods=["POST"])
def stop():
    stop_event.set()
    return jsonify({"ok": True})


@app.route("/api/send-dm", methods=["POST"])
def send_dm():
    data = request.get_json()
    bot_token = data.get("botToken", "")
    guild_id = data.get("guildId", "")
    message = data.get("message", "")
    mode = data.get("mode", "all")
    role_ids = data.get("roleIds", [])
    delay_sec = data.get("delay", 2)
    status_channel_id = data.get("statusChannelId")

    stop_event.clear()

    def generate():
        def sse(event_type, payload):
            return f"event: {event_type}\ndata: {json.dumps(payload)}\n\n"

        try:
            # Step 1: Fetch all members
            yield sse("log", {"status": "info", "message": "Fetching server members..."})

            try:
                members = get_all_members(guild_id, bot_token)
            except Exception as e:
                yield sse("error", {"message": f"Failed to fetch members: {str(e)}"})
                return

            # Step 2: Filter out bots
            members = [m for m in members if not m.get("user", {}).get("bot", False)]

            # Step 3: Filter by roles if needed
            if mode == "roles" and role_ids:
                members = [
                    m for m in members
                    if any(r in role_ids for r in m.get("roles", []))
                ]

            total = len(members)
            yield sse("log", {"status": "info", "message": f"Found {total} members to message"})
            yield sse("progress", {"sent": 0, "failed": 0, "total": total, "dmClosed": 0})

            if total == 0:
                yield sse("complete", {"sent": 0, "failed": 0, "total": 0, "dmClosed": 0})
                return

            # Step 4: Send initial status message to Discord channel
            status_message_id = None
            if status_channel_id:
                status_message_id = send_status_message(
                    status_channel_id,
                    bot_token,
                    f"**Mass DM Started**\nProgress: 0/{total} members\nSuccess: 0 | Failed: 0",
                )

            sent = 0
            failed = 0
            dm_closed = 0

            # Step 5: Send DMs
            for i, member in enumerate(members):
                # Check stop
                if stop_event.is_set():
                    yield sse("log", {"status": "info", "message": "Stopped by user"})
                    break

                user = member.get("user", {})
                display_name = user.get("global_name") or user.get("username", "Unknown")

                try:
                    # Create DM channel
                    dm_url = f"{DISCORD_API}/users/@me/channels"
                    err, resp = discord_fetch(dm_url, bot_token, method="POST", json_body={"recipient_id": user["id"]})

                    # Handle rate limit
                    if err and err.get("rate_limited"):
                        wait_time = err["retry_after"]
                        yield sse("log", {"status": "ratelimit", "message": f"Rate limited! Waiting {wait_time}s..."})
                        time.sleep(wait_time)
                        err, resp = discord_fetch(dm_url, bot_token, method="POST", json_body={"recipient_id": user["id"]})

                    if err or not resp or resp.status_code != 200:
                        raise Exception("Cannot create DM channel")

                    dm_channel = resp.json()

                    # Replace <user> placeholder
                    final_message = message.replace("<user>", f"<@{user['id']}>")

                    # Send message
                    msg_url = f"{DISCORD_API}/channels/{dm_channel['id']}/messages"
                    err, resp = discord_fetch(msg_url, bot_token, method="POST", json_body={"content": final_message})

                    # Handle rate limit
                    if err and err.get("rate_limited"):
                        wait_time = err["retry_after"]
                        yield sse("log", {"status": "ratelimit", "message": f"Rate limited! Waiting {wait_time}s..."})
                        time.sleep(wait_time)
                        err, resp = discord_fetch(msg_url, bot_token, method="POST", json_body={"content": final_message})

                    if resp and resp.status_code == 200:
                        sent += 1
                        yield sse("log", {"status": "success", "message": f"Sent to {display_name}"})
                    elif resp and resp.status_code == 403:
                        dm_closed += 1
                        yield sse("log", {"status": "dm_closed", "message": f"{display_name} - DMs disabled"})
                    else:
                        status_code = resp.status_code if resp else "N/A"
                        failed += 1
                        yield sse("log", {"status": "failed", "message": f"Failed: {display_name} ({status_code})"})

                except Exception:
                    failed += 1
                    yield sse("log", {"status": "failed", "message": f"Failed: {display_name} - Error"})

                yield sse("progress", {"sent": sent, "failed": failed, "total": total, "dmClosed": dm_closed})

                # Update status message in Discord channel every 5 members
                if status_channel_id and status_message_id and (i + 1) % 5 == 0:
                    progress = sent + failed + dm_closed
                    edit_status_message(
                        status_channel_id,
                        status_message_id,
                        bot_token,
                        f"**Mass DM In Progress...**\nProgress: {progress}/{total} members\nSuccess: {sent} | Failed: {failed} | DM Closed: {dm_closed}",
                    )

                # Delay between messages
                if i < len(members) - 1 and not stop_event.is_set():
                    time.sleep(delay_sec)

            # Final status message update
            if status_channel_id and status_message_id:
                progress = sent + failed + dm_closed
                edit_status_message(
                    status_channel_id,
                    status_message_id,
                    bot_token,
                    f"**Mass DM Complete!**\nTotal: {progress}/{total} members\nSuccess: {sent} | Failed: {failed} | DM Closed: {dm_closed}",
                )

            yield sse("complete", {"sent": sent, "failed": failed, "total": total, "dmClosed": dm_closed})

        except Exception as e:
            yield sse("error", {"message": f"Unexpected error: {str(e)}"})

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)

# Basecamp Agent

A Claude Code skill for managing Basecamp 3 projects, todos, messages, and campfires — across multiple accounts and clients.

## Installation

Clone the repo and copy the skill files into your project's `.claude/` directory:

```bash
git clone https://github.com/CatMizu/basecamp-agent.git /tmp/basecamp-agent

# Copy skills and scripts
cp -r /tmp/basecamp-agent/skills/* YOUR_PROJECT/.claude/skills/
cp -r /tmp/basecamp-agent/scripts YOUR_PROJECT/.claude/skills/

# Copy CLAUDE.md (merge with existing if needed)
cp /tmp/basecamp-agent/CLAUDE.md YOUR_PROJECT/CLAUDE.md
```

Then **restart Claude Code** for the skills to be loaded.

> **Note:** Claude Code loads skills from `.claude/skills/` — there is no plugin marketplace or `settings.json` plugin config. Skills are simply directories containing `SKILL.md` files placed under `.claude/skills/`.

## Setup

After installing, run the init skill to configure your Basecamp account(s):

```
/basecamp-init
```

This will guide you through:
1. Registering an OAuth application at [launchpad.37signals.com](https://launchpad.37signals.com/integrations)
2. Authorizing via browser
3. Selecting which Basecamp accounts to manage

Your credentials are stored locally at `~/.basecamp/` and never uploaded.

## Usage

### Manage projects and tasks
```
/basecamp
```

Ask things like:
- "Show me all projects"
- "List todos in [project name]"
- "Create a todo in [project] assigned to [person]"
- "Send a message to [project's] message board"
- "What's new in [client name]'s campfire?"

### Fix authentication issues
```
/basecamp-auth
```

## Project Structure

```
.
├── CLAUDE.md              # Instructions loaded into Claude's context
├── skills/
│   ├── basecamp/          # Main skill: CRUD for projects, todos, messages, campfire
│   │   ├── SKILL.md
│   │   └── api-reference.md
│   ├── basecamp-init/     # First-time OAuth setup
│   │   └── SKILL.md
│   └── basecamp-auth/     # Token refresh & auth troubleshooting
│       └── SKILL.md
└── scripts/               # Helper shell scripts (token refresh, etc.)
```

## Features

- Multi-account support (manage multiple clients from one place)
- Projects, To-dos, Messages, Campfire chat, Comments
- Automatic token refresh (tokens valid for 2 weeks, auto-renewed)
- Basecamp 3 API with full CRUD operations

## Requirements

- Claude Code
- `curl`, `jq`, `python3` (for OAuth flow)
- A Basecamp 3 account

## License

MIT

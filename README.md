# Basecamp Agent

A Claude Code plugin for managing Basecamp 3 projects, todos, messages, and campfires — across multiple accounts and clients.

## Installation

```
/plugin marketplace add CatMizu/basecamp-agent
/plugin install basecamp-agent
```

## Setup

After installing, run the init skill to configure your Basecamp account(s):

```
/basecamp-agent:basecamp-init
```

This will guide you through:
1. Registering an OAuth application at [launchpad.37signals.com](https://launchpad.37signals.com/integrations)
2. Authorizing via browser
3. Selecting which Basecamp accounts to manage

Your credentials are stored locally at `~/.basecamp/` and never uploaded.

## Usage

### Manage projects and tasks
```
/basecamp-agent:basecamp
```

Ask things like:
- "Show me all projects"
- "List todos in [project name]"
- "Create a todo in [project] assigned to [person]"
- "Send a message to [project's] message board"
- "What's new in [client name]'s campfire?"

### Fix authentication issues
```
/basecamp-agent:basecamp-auth
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

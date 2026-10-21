// Sent as the MCP `instructions` field. Clients that surface it (Claude Code) add it to every session,
// and Claude Code cuts it past 2,048 characters on older versions, so keep it short.
// claude.ai currently ignores it, so the rules that matter are repeated in the tool descriptions.
export const SERVER_INSTRUCTIONS = `Long-term memory that persists across the user's conversations.

Start of every conversation: before replying to the first message, call load_core_memories once and treat the result as background about the user. Don't announce it.

recall: search when past context about the user, their projects, preferences or earlier decisions could matter, and before asking the user something they may already have told you.

remember: save durable facts, preferences, decisions and project context as they come up, each as one self-contained statement that makes sense with no surrounding context ("User's home lab runs Proxmox on two nodes"). Don't save ephemeral chat details, anything only relevant to the current task, or secrets such as passwords, tokens and keys. Use a few short tags as categories, e.g. preference, person, project:<name>.

When a stored fact changes, find it with recall and update_memory it instead of saving a duplicate. Use forget only when the user wants something deleted.

Core vs topical: memories are topical by default and surface through recall. Core memories (core=true) load in every session, so keep them few and broadly relevant: who the user is, standing preferences, ongoing priorities. Set core=true (on remember or update_memory) only when the user explicitly asks for something to always be remembered or loaded every session, or after you have asked and the user agreed. Feel free to suggest making a lasting, broadly relevant fact core. If the core limit is hit, show the user the current core memories and ask which to demote or shorten.

Keep memory operations quiet: mention a save or update in a few words when useful, and don't narrate searches.`;

import type { PluginClientContext } from "@getpaseo/plugin/client";
import { buildSideChatSystemPrompt, sideChatTitle, type ChatTurn } from "./format";

type PaseoApi = PluginClientContext["paseo"];
type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;

export interface SideChat {
  agentId: string;
  workspaceId: string;
}

/**
 * Starts a child agent next to `agentId` with the same provider, model, mode,
 * and thinking level. Its first message is the quote and the question; the
 * recent main-chat turns travel as instructions so the question has context.
 */
export async function startSideChat(
  paseo: PaseoApi,
  input: { agentId: string; quote: string; question: string },
): Promise<SideChat> {
  const parent = paseo.agents.ref(input.agentId);
  const [refetched, turns] = await Promise.all([parent.refresh(), readTurns(parent, 120)]);
  const snapshot = refetched?.agent ?? parent.current();
  if (!snapshot) throw new Error("The main chat is not available.");
  const workspaceId = snapshot.workspaceId;
  if (!workspaceId) throw new Error("The main chat has no workspace.");

  const model = snapshot.model ?? snapshot.runtimeInfo?.model ?? null;
  const child = await paseo.workspaces.ref(workspaceId).agents.create({
    config: {
      provider: model ? `${snapshot.provider}/${model}` : snapshot.provider,
      modeId: snapshot.currentModeId ?? undefined,
      thinkingOptionId: snapshot.thinkingOptionId ?? undefined,
      systemPrompt: buildSideChatSystemPrompt(turns, input.quote),
    },
    parent: input.agentId,
    title: sideChatTitle(input.question),
    prompt: `${input.quote}\n\n${input.question.trim()}`,
  });
  return { agentId: child.id, workspaceId };
}

/**
 * The conversation as user and assistant turns. The projected timeline merges
 * streamed chunks; text split by tool calls is joined back into one turn.
 */
export async function readTurns(agent: AgentHandle, limit: number): Promise<ChatTurn[]> {
  const page = await agent.timeline.refetch({ direction: "tail", limit, projection: "projected" });
  const turns: ChatTurn[] = [];
  for (const entry of page.entries) {
    const item = entry.item;
    if (item.type !== "user_message" && item.type !== "assistant_message") continue;
    const role = item.type === "user_message" ? "user" : "assistant";
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      last.text = `${last.text}\n\n${item.text}`;
    } else {
      turns.push({ role, text: item.text });
    }
  }
  return turns;
}

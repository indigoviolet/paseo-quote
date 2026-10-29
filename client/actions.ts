import type { PluginClientContext } from "@getpaseo/plugin/client";
import { buildSideChatSystemPrompt, sideChatTitle, type ChatTurn } from "./format";

type PaseoApi = PluginClientContext["paseo"];
type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;

/** Settings → Sending → Default send: what Enter does while the agent runs. */
export type SendBehavior = "interrupt" | "steer" | "queue";

/**
 * The daemon accepts `activeTurnBehavior` and the SDK forwards it, but the
 * SDK's option type does not list it yet.
 */
type SendOptions = NonNullable<Parameters<AgentHandle["send"]>[1]> & {
  activeTurnBehavior: "interrupt" | "steer";
};

/** Long enough for any turn; the wait ends early when the agent needs attention. */
const QUEUE_WAIT_MS = 6 * 60 * 60 * 1000;

/**
 * Sends the text as an ordinary user message, the way the composer's Enter
 * would: steer or interrupt a running turn, or hold it until the turn ends.
 *
 * Paseo's own queue lives inside the composer, out of a plugin's reach, so a
 * queued reply waits here instead and is not shown in the composer's queue.
 */
export async function sendReply(
  paseo: PaseoApi,
  agentId: string,
  text: string,
  behavior: SendBehavior,
): Promise<"sent" | "queued"> {
  const agent = paseo.agents.ref(agentId);
  if (behavior === "queue") {
    const status = (await agent.refresh())?.agent.status;
    if (status === "running" || status === "initializing") {
      // A turn that stops for a permission ends the wait; the composer
      // interrupts in that case too.
      const interrupt: SendOptions = { activeTurnBehavior: "interrupt" };
      void agent
        .waitForFinish(QUEUE_WAIT_MS)
        .then(() => agent.send(text, interrupt))
        .catch((cause: unknown) => console.error("[quote] Queued reply was not sent", cause));
      return "queued";
    }
  }
  const options: SendOptions = { activeTurnBehavior: behavior === "steer" ? "steer" : "interrupt" };
  await agent.send(text, options);
  return "sent";
}

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

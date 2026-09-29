import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SideChatPanel } from "./client/side-chat-panel";
import { installSelectionBar } from "./client/web";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({
    id: "side-chat",
    title: "Side chat",
    icon: "MessagesSquare",
    context: "agent",
    locations: ["explorer", "workspace"],
    Component: SideChatPanel,
  });
  const removeBar = installSelectionBar(client);
  return () => {
    removeBar();
    removePanel();
  };
}

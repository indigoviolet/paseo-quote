import { type PluginAgentPanelProps, useAgent, usePaseo } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import {
  Platform,
  Pressable,
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { readTurns } from "./actions";
import type { ChatTurn } from "./format";

const MONO = Platform.select({
  web: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  ios: "Menlo",
  default: "monospace",
});

type Block = { kind: "text" | "quote" | "code"; text: string };

/** Enough Markdown structure to read a reply: fences, quotes, and paragraphs. */
function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trim().startsWith(fence[1]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const kind = /^\s*>/.test(line) ? "quote" : "text";
    const body: string[] = [];
    while (index < lines.length) {
      const current = lines[index]!;
      if (/^\s*(`{3,}|~{3,})/.test(current)) break;
      if ((/^\s*>/.test(current) ? "quote" : "text") !== kind) break;
      body.push(kind === "quote" ? current.replace(/^\s*> ?/, "") : current);
      index += 1;
    }
    const joined = body.join("\n").replace(/^\n+|\n+$/g, "");
    if (joined) blocks.push({ kind, text: joined });
  }
  return blocks;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function SideChatPanel({ theme, layout, agentId, navigation }: PluginAgentPanelProps) {
  const paseo = usePaseo();
  const agent = useAgent(agentId, (snapshot) => ({
    status: snapshot.status,
    title: snapshot.title,
  }));
  const [turns, setTurns] = useState<ChatTurn[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);

  // History, then a refetch at most every 250 ms while the side agent streams.
  // The projected timeline arrives with streamed chunks already merged.
  useEffect(() => {
    const handle = paseo.agents.ref(agentId);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      timer = null;
      readTurns(handle, 200).then(
        (next) => {
          if (!cancelled) setTurns(next);
        },
        (cause) => {
          if (!cancelled) setError(message(cause));
        },
      );
    };
    load();
    const unsubscribe = handle.timeline.subscribe(() => {
      if (timer === null) timer = setTimeout(load, 250);
    });
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [paseo, agentId]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await paseo.agents.ref(agentId).send(text);
      setDraft("");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSending(false);
    }
  }, [agentId, draft, paseo, sending]);

  const onKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (Platform.OS !== "web") return;
      const native = event.nativeEvent as TextInputKeyPressEventData & {
        shiftKey?: boolean;
        isComposing?: boolean;
      };
      if (native.key !== "Enter" || native.shiftKey || native.isComposing) return;
      event.preventDefault();
      void send();
    },
    [send],
  );

  const styles = useMemo(() => {
    const pad = layout.compact ? 12 : 14;
    return {
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: pad,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      title: { flex: 1, color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      status: { color: theme.colors.foregroundMuted, fontSize: 12 },
      link: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
      linkText: { color: theme.colors.accent, fontSize: 12, fontWeight: "500" as const },
      list: { flex: 1 },
      listContent: { padding: pad, gap: 14 },
      userTurn: {
        alignSelf: "flex-end" as const,
        maxWidth: "92%" as const,
        padding: 10,
        borderRadius: 10,
        gap: 6,
        backgroundColor: theme.colors.surface2,
      },
      assistantTurn: { gap: 8 },
      text: { color: theme.colors.foreground, fontSize: 13, lineHeight: 19 },
      quote: {
        color: theme.colors.foregroundMuted,
        fontSize: 13,
        lineHeight: 19,
        paddingLeft: 9,
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.border,
      },
      code: {
        color: theme.colors.foreground,
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: 17,
        padding: 8,
        borderRadius: 6,
        backgroundColor: theme.colors.surface1,
      },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      error: { color: theme.colors.statusDanger, fontSize: 12, paddingHorizontal: pad },
      composer: {
        flexDirection: "row" as const,
        alignItems: "flex-end" as const,
        gap: 8,
        padding: pad,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      },
      input: {
        flex: 1,
        minHeight: 38,
        maxHeight: 160,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderWidth: 1,
        borderRadius: 8,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        color: theme.colors.foreground,
        fontSize: 13,
      },
      send: {
        paddingHorizontal: 12,
        paddingVertical: 9,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      sendText: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: "600" as const },
    };
  }, [theme, layout.compact]);

  const renderBlocks = (text: string) =>
    splitBlocks(text).map((block, index) => (
      <Text
        key={index}
        selectable
        style={block.kind === "code" ? styles.code : block.kind === "quote" ? styles.quote : styles.text}
      >
        {block.text}
      </Text>
    ));

  const running = agent?.status === "running" || agent?.status === "initializing";
  const canSend = Boolean(draft.trim()) && !sending;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {agent?.title ?? "Side chat"}
        </Text>
        {running ? <Text style={styles.status}>Thinking…</Text> : null}
        {navigation ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open the side chat as a tab"
            onPress={() => navigation.openAgent({ agentId })}
            style={styles.link}
          >
            <Text style={styles.linkText}>Open as tab</Text>
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        ref={scroll}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
      >
        {turns === null ? <Text style={styles.muted}>Loading…</Text> : null}
        {turns?.map((turn, index) => (
          <View key={index} style={turn.role === "user" ? styles.userTurn : styles.assistantTurn}>
            {renderBlocks(turn.text)}
          </View>
        ))}
      </ScrollView>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onKeyPress={onKeyPress}
          placeholder="Ask a follow-up…"
          placeholderTextColor={theme.colors.foregroundMuted}
          multiline
          editable={!sending}
          style={styles.input}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send to the side chat"
          accessibilityState={{ disabled: !canSend }}
          disabled={!canSend}
          onPress={() => void send()}
          style={[styles.send, !canSend && { opacity: 0.45 }]}
        >
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

// Port of apps/frontend/src/lib/components/canvas-panel.svelte
// The editor itself is the web's TipTap + Yjs one, running in a WebView (canvas-editor/, bundled into
// canvas-editor.generated.ts). This side relays the socket's canvas events in and the editor's edits and
// presence out, and draws the toolbar and who else is here natively.
import * as Haptics from 'expo-haptics';
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Italic,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  SquareCode,
  Strikethrough,
  type LucideIcon,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Linking, ScrollView, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { z } from 'zod';
import type { CanvasInbound, CanvasTool } from '../../canvas-editor';
import theme from '../../theme.generated.json';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { openCanvases, type CanvasEvent } from '@/lib/canvas';
import { DEFAULT_AVATAR_COLOR } from '@/lib/default-colors';
import { canvasEditorHtml } from '@/lib/canvas-editor.generated';
import { realtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';

const tools: (readonly [CanvasTool, string, LucideIcon] | null)[] = [
  ['bold', 'Bold', Bold],
  ['italic', 'Italic', Italic],
  ['strike', 'Strikethrough', Strikethrough],
  ['code', 'Inline code', Code],
  null,
  ['heading1', 'Heading', Heading1],
  ['heading2', 'Subheading', Heading2],
  null,
  ['bulletList', 'Bulleted list', List],
  ['orderedList', 'Numbered list', ListOrdered],
  ['taskList', 'Checklist', ListTodo],
  null,
  ['blockquote', 'Quote', Quote],
  ['codeBlock', 'Code block', SquareCode],
];
const toolSchema = z.enum([
  'bold',
  'italic',
  'strike',
  'code',
  'heading1',
  'heading2',
  'bulletList',
  'orderedList',
  'taskList',
  'blockquote',
  'codeBlock',
]);

// presence comes from every device, the web's too; one odd entry shouldn't hide everyone else
const peerSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  avatarUrl: z.string().nullish(),
});
type Peer = z.infer<typeof peerSchema>;

const outboundSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('update'), update: z.string() }),
  z.object({
    type: z.literal('awareness'),
    update: z.string(),
    hello: z.boolean().optional(),
    goodbye: z.string(),
  }),
  z.object({
    type: z.literal('state'),
    synced: z.boolean(),
    writable: z.boolean(),
    active: z.array(toolSchema),
    peers: z.array(z.unknown()),
  }),
  z.object({ type: z.literal('link'), url: z.string() }),
]);

// the theme colors the editor page needs, as CSS colors (`border` is see-through)
const editorTokens = [
  'background',
  'foreground',
  'muted',
  'muted-foreground',
  'border',
  'primary',
  'link',
] as const;
const editorColors = (scheme: 'light' | 'dark') =>
  Object.fromEntries(
    editorTokens.map((token) => {
      const { alpha, [scheme]: hex } = theme[token];
      const alphaHex =
        alpha < 1
          ? Math.round(alpha * 255)
              .toString(16)
              .padStart(2, '0')
          : '';
      return [token, `${hex}${alphaHex}`];
    })
  );

type EditorState = { synced: boolean; writable: boolean; active: CanvasTool[]; peers: Peer[] };
const initialState: EditorState = { synced: false, writable: false, active: [], peers: [] };

export function CanvasPanel({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const user = useSession((s) => s.user);
  const { colorScheme } = useColorScheme();
  const colors = useMemo(() => editorColors(colorScheme ?? 'dark'), [colorScheme]);
  const webview = useRef<WebView>(null);
  const ready = useRef(false);
  const goodbye = useRef<string | null>(null);
  const [state, setState] = useState(initialState);
  // a crashed web content process leaves a blank view; a new one starts over from the server
  const [generation, setGeneration] = useState(0);

  const send = (message: CanvasInbound) =>
    webview.current?.injectJavaScript(`window.canvasReceive(${JSON.stringify(message)});true;`);

  // the editor's latest look at the socket and the session, without re-registering on every render
  const latest = useRef({ send, user, colors });
  latest.current = { send, user, colors };

  useEffect(() => {
    if (ready.current) send({ type: 'colors', colors });
    // only when the theme changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colors]);

  // leaving: stop following the canvas and tell the others we're gone
  useEffect(
    () => () => {
      openCanvases.delete(channelId);
      if (goodbye.current) {
        realtime().sendCanvas({ type: 'canvas.awareness', channelId, update: goodbye.current });
      }
      realtime().sendCanvas({ type: 'canvas.leave', channelId });
    },
    [channelId]
  );

  // Android's back closes the canvas before it leaves the channel
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);

  function onMessage(event: WebViewMessageEvent) {
    let data: unknown;
    try {
      data = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    const parsed = outboundSchema.safeParse(data);
    if (!parsed.success) return;
    const message = parsed.data;

    if (message.type === 'ready') {
      ready.current = true;
      setState(initialState);
      const self = latest.current.user;
      latest.current.send({
        type: 'init',
        user: {
          id: self?.id ?? '',
          name: self?.displayName || self?.username || 'Someone',
          avatarUrl: self?.avatarUrl ?? null,
          avatarColor: self?.avatarColor === DEFAULT_AVATAR_COLOR ? null : (self?.avatarColor ?? null),
        },
        colors: latest.current.colors,
      });
      const canvas = {
        join: () => realtime().sendCanvas({ type: 'canvas.join', channelId }),
        handle: (canvasEvent: CanvasEvent) => {
          if (canvasEvent.type === 'canvas.sync') {
            const { state: synced, writable } = canvasEvent.data;
            latest.current.send({ type: 'sync', state: synced, writable });
          }
          if (canvasEvent.type === 'canvas.update') {
            latest.current.send({ type: 'update', update: canvasEvent.data.update });
          }
          if (canvasEvent.type === 'canvas.awareness') {
            const { update, hello } = canvasEvent.data;
            latest.current.send({ type: 'awareness', update, hello });
          }
        },
      };
      openCanvases.set(channelId, canvas);
      canvas.join();
    }
    if (message.type === 'update') {
      realtime().sendCanvas({ type: 'canvas.update', channelId, update: message.update });
    }
    if (message.type === 'awareness') {
      goodbye.current = message.goodbye;
      realtime().sendCanvas({
        type: 'canvas.awareness',
        channelId,
        update: message.update,
        hello: message.hello,
      });
    }
    if (message.type === 'state') {
      const peers = message.peers.flatMap((peer) => {
        const result = peerSchema.safeParse(peer);
        return result.success ? [result.data] : [];
      });
      setState({
        synced: message.synced,
        writable: message.writable,
        active: message.active,
        peers,
      });
    }
    if (message.type === 'link' && /^https?:\/\//i.test(message.url)) {
      void Linking.openURL(message.url);
    }
  }

  function restart() {
    ready.current = false;
    openCanvases.delete(channelId);
    setState(initialState);
    setGeneration((value) => value + 1);
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, minHeight: 0 }}>
      <View className="flex-row items-center gap-2 border-b border-border pl-3">
        <Text className="text-sm font-semibold">Canvas</Text>
        {state.synced && !state.writable && (
          <Text className="text-xs text-muted-foreground">View only</Text>
        )}
        <View className="ml-auto flex-row items-center gap-1 py-2 pr-3">
          {state.peers.map((peer) => (
            <Avatar
              key={peer.id}
              src={peer.avatarUrl}
              name={peer.name}
              bgColor={peer.color}
              className="size-6"
            />
          ))}
        </View>
      </View>

      {state.writable && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          // a tap on a button must not close the keyboard the editor has open
          keyboardShouldPersistTaps="always"
          className="shrink-0 grow-0 border-b border-border"
          contentContainerClassName="items-center px-1"
        >
          {tools.map((tool, index) =>
            tool ? (
              <Button
                key={tool[0]}
                variant={state.active.includes(tool[0]) ? 'secondary' : 'ghost'}
                size="icon"
                accessibilityLabel={tool[1]}
                accessibilityState={{ selected: state.active.includes(tool[0]) }}
                onPress={() => {
                  void Haptics.selectionAsync();
                  send({ type: 'run', tool: tool[0] });
                }}
              >
                <Icon as={tool[2]} size={18} />
              </Button>
            ) : (
              <View key={`separator-${index}`} className="mx-1 h-5 w-px bg-border" />
            )
          )}
        </ScrollView>
      )}

      <View className="min-h-0 flex-1">
        <WebView
          key={generation}
          ref={webview}
          source={{ html: canvasEditorHtml }}
          originWhitelist={['*']}
          onMessage={onMessage}
          // the page is ours; links leave for the browser instead of replacing it
          onShouldStartLoadWithRequest={(request) => {
            if (/^(about|data):/.test(request.url)) return true;
            if (/^https?:\/\//i.test(request.url)) void Linking.openURL(request.url);
            return false;
          }}
          setSupportMultipleWindows={false}
          // the toolbar focuses the editor from outside the page, which has to bring the keyboard up
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView
          // the editor scrolls itself; this stops iOS from pushing the whole page up over the keyboard
          scrollEnabled={false}
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          style={{ flex: 1, backgroundColor: colors.background }}
          onContentProcessDidTerminate={restart}
          onRenderProcessGone={restart}
        />
        {!state.synced && (
          <View className="absolute inset-0 gap-2 bg-background p-4">
            <View className="h-5 w-1/2 animate-pulse bg-muted" />
            <View className="h-3 w-3/4 animate-pulse bg-muted/70" />
            <View className="h-3 w-2/3 animate-pulse bg-muted/70" />
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

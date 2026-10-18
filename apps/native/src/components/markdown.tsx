// Port of apps/frontend/src/lib/components/markdown.svelte
// Every piece is a <Text> nested in its paragraph's <Text>, and each gets the full class list: <Text> always sets a size,
// so nothing is inherited, and bold/italic pick their IBM Plex file from the classes (see ui/text.tsx).
import { useState, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { EmojiSpans } from '@/components/emoji-text';
import { ProfileSheet } from '@/components/profile-card';
import { Text } from '@/components/ui/text';
import { parseInline, parseMarkdown, type Block, type Inline } from '@/lib/markdown';
import { openLink } from '@/lib/navigation';
import type { Author } from '@/lib/types/chat';
import { cn } from '@/lib/utils';

const headings = [
  'text-xl leading-7 font-bold',
  'text-lg leading-6 font-bold',
  'text-base leading-6 font-semibold',
];
const styles = {
  bold: 'font-semibold',
  italic: 'italic',
  underline: 'underline',
  strike: 'line-through',
} as const;

const plain = (nodes: Inline[]): string =>
  nodes.map((node) => ('children' in node ? plain(node.children) : node.text)).join('');

function Spoiler({
  nodes,
  className,
  render,
}: {
  nodes: Inline[];
  className?: string;
  render: (nodes: Inline[], className?: string) => ReactNode;
}) {
  const [revealed, setRevealed] = useState(false);
  // hidden spoilers are plain text, so mentions, links and emoji images can't show through
  return revealed ? (
    <Text className={cn(className, 'bg-muted-foreground/20')}>{render(nodes, className)}</Text>
  ) : (
    <Text
      className={cn(className, 'bg-muted-foreground text-transparent')}
      onPress={() => setRevealed(true)}
      accessibilityLabel="Spoiler, tap to reveal"
    >
      {plain(nodes)}
    </Text>
  );
}

// `inline` flattens everything to one line (reply previews); `children` go at the end of the last paragraph ("(edited)")
export function Markdown({
  content,
  links = false,
  inline = false,
  className,
  children,
}: {
  content: string;
  links?: boolean;
  inline?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const [profile, setProfile] = useState<Author | null>(null);

  const spans = (nodes: Inline[], cls = className): ReactNode =>
    nodes.map((node, index) => {
      if (node.type === 'text') {
        return (
          <EmojiSpans
            key={index}
            content={node.text}
            links={links}
            className={cls}
            onMention={setProfile}
          />
        );
      }
      if (node.type === 'code') {
        return (
          <Text key={index} className={cn(cls, 'bg-muted font-mono')}>
            {node.text}
          </Text>
        );
      }
      if (node.type === 'spoiler') {
        return <Spoiler key={index} nodes={node.children} className={cls} render={spans} />;
      }
      if (node.type === 'link') {
        const linkClass = links ? cn(cls, 'text-link underline') : cls;
        return (
          <Text
            key={index}
            className={linkClass}
            onPress={links ? () => openLink(node.url) : undefined}
          >
            {spans(node.children, linkClass)}
          </Text>
        );
      }
      const styled = cn(cls, styles[node.type]);
      return (
        <Text key={index} className={styled}>
          {spans(node.children, styled)}
        </Text>
      );
    });

  const render = (blocks: Block[], last: boolean): ReactNode =>
    blocks.map((block, index) => {
      const end = last && index === blocks.length - 1;
      if (block.type === 'paragraph' || block.type === 'heading') {
        const cls =
          block.type === 'heading'
            ? cn(className, headings[block.level - 1], 'mt-1 text-foreground')
            : className;
        return (
          <Text key={index} className={cls}>
            {spans(block.children, cls)}
            {end && children}
          </Text>
        );
      }
      if (block.type === 'quote') {
        return (
          <View key={index} className="border-l-[3px] border-muted-foreground/40 pl-3">
            {render(block.children, end)}
          </View>
        );
      }
      if (block.type === 'code') {
        return (
          <View key={index} className="my-1">
            <ScrollView horizontal className="rounded-md border border-border bg-muted">
              <Text className="px-3 py-2 font-mono text-[13px] leading-5 text-foreground/90">
                {block.text}
              </Text>
            </ScrollView>
            {end && <Text className={className}>{children}</Text>}
          </View>
        );
      }
      return (
        <View key={index}>
          {block.items.map((item, itemIndex) => (
            <View key={itemIndex} className="flex-row pl-1">
              <Text className={cn(className, 'w-6 text-muted-foreground')}>
                {block.ordered ? `${block.start + itemIndex}.` : '•'}
              </Text>
              <Text className={cn(className, 'flex-1')}>
                {spans(item)}
                {end && itemIndex === block.items.length - 1 && children}
              </Text>
            </View>
          ))}
        </View>
      );
    });

  const blocks = inline ? [] : parseMarkdown(content);

  return (
    <>
      {inline ? (
        <Text className={className}>{spans(parseInline(content.replace(/\s+/g, ' ')))}</Text>
      ) : (
        <View>
          {blocks.length ? render(blocks, true) : <Text className={className}>{children}</Text>}
        </View>
      )}
      {profile && <ProfileSheet user={profile} open onClose={() => setProfile(null)} />}
    </>
  );
}
